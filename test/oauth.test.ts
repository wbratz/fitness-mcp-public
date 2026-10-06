import { SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, USER1_TOKEN, rpc } from './helpers.js';

// --- OAuth flow helpers ------------------------------------------------------

const CLIENT_REDIRECT = `${BASE}/cb`;

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/** Dynamic client registration; returns the issued client_id. */
async function registerClient(name = 'Test MCP Client'): Promise<string> {
  const res = await SELF.fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp',
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  expect(body.client_id).toBeTruthy();
  return body.client_id;
}

function authorizeUrl(clientId: string, challenge: string, state = 'xyz'): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    scope: 'mcp',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${BASE}/authorize?${p.toString()}`;
}

// Google is mocked by patching globalThis.fetch (see beforeAll). These set the
// identity the next /callback will read back.
let googleEmail = 'user1@example.com';
let googleVerified = true;
function mockGoogle(email: string, opts: { verified?: boolean } = {}): void {
  googleEmail = email;
  googleVerified = opts.verified ?? true;
}

/** GET+POST /authorize through the consent page; returns the state sent to Google plus the approval cookie. */
async function approveAndGetGoogleState(
  clientId: string,
  challenge: string,
  cookie?: string,
): Promise<{ googleState: string; setCookie: string | null; dialogShown: boolean }> {
  const getRes = await SELF.fetch(authorizeUrl(clientId, challenge), {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });

  // Already-approved clients skip the dialog and 302 straight to Google.
  if (getRes.status === 302) {
    const loc = new URL(getRes.headers.get('location')!);
    return { googleState: loc.searchParams.get('state')!, setCookie: null, dialogShown: false };
  }

  expect(getRes.status).toBe(200);
  const html = await getRes.text();
  const dialogState = /name="state" value="([^"]+)"/.exec(html)?.[1];
  expect(dialogState).toBeTruthy();

  const form = new URLSearchParams({ state: dialogState! });
  const postRes = await SELF.fetch(`${BASE}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: form,
    redirect: 'manual',
  });
  expect(postRes.status).toBe(302);
  const loc = new URL(postRes.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  return {
    googleState: loc.searchParams.get('state')!,
    setCookie: postRes.headers.get('set-cookie'),
    dialogShown: true,
  };
}

/** Simulate Google's redirect back to /callback. */
async function callback(googleState: string): Promise<Response> {
  return SELF.fetch(`${BASE}/callback?code=g-code&state=${encodeURIComponent(googleState)}`, {
    redirect: 'manual',
  });
}

/** Full login. Returns issued OAuth tokens. */
async function login(
  email: string,
): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  const { googleState } = await approveAndGetGoogleState(clientId, challenge);
  mockGoogle(email);
  const cbRes = await callback(googleState);
  expect(cbRes.status).toBe(302);
  const authCode = new URL(cbRes.headers.get('location')!).searchParams.get('code');
  expect(authCode).toBeTruthy();

  const tokenRes = await SELF.fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode!,
      redirect_uri: CLIENT_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  expect(tokenRes.status).toBe(200);
  const tok = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  expect(tok.access_token).toBeTruthy();
  return { accessToken: tok.access_token, refreshToken: tok.refresh_token, clientId };
}

/** tools/call over an OAuth bearer. */
async function callOAuth(accessToken: string, name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc(accessToken, 'tools/call', { name, arguments: args });
  const content = (body.result?.content ?? []) as any[];
  const text = content.find((b) => b?.type === 'text')?.text ?? '';
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { isError: body.result?.isError === true, data, status: body };
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  // The worker runs in this same isolate, so patching globalThis.fetch
  // intercepts google-handler's outbound calls without touching SELF.fetch.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'g-access', token_type: 'Bearer' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
      return new Response(
        JSON.stringify({ email: googleEmail, email_verified: googleVerified, name: 'Test User' }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('OAuth migration (v3)', () => {
  it('1+2: full flow — user1 logs in and whoami returns User One', async () => {
    const { accessToken } = await login('user1@example.com');
    const who = await callOAuth(accessToken, 'whoami');
    expect(who.isError).toBe(false);
    expect(who.data.name).toBe('User One');
  });

  it('3: allowlisted user2 resolves to User Two', async () => {
    const { accessToken } = await login('user2@example.com');
    const who = await callOAuth(accessToken, 'whoami');
    expect(who.data.name).toBe('User Two');
  });

  it('4: a non-allowlisted email is rejected at /callback with no token issued', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const { googleState } = await approveAndGetGoogleState(clientId, challenge);
    mockGoogle('stranger@example.com');
    const cbRes = await callback(googleState);
    expect(cbRes.status).toBe(403);
    const text = await cbRes.text();
    expect(text).toContain('not authorized');
    // No redirect to the client, so no authorization code was ever issued.
    expect(cbRes.headers.get('location')).toBeNull();
  });

  it('5: /mcp with no, malformed, or unknown token all 401', async () => {
    const noToken = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(noToken.status).toBe(401);

    const malformed = await rpc('not-a-real-token', 'tools/list', {});
    expect(malformed.status).toBe(401);

    // Provider-shaped but unknown (userId:grantId:secret that is not in KV).
    const fakeInternal = await rpc('user1:deadbeef:nope', 'tools/list', {});
    expect(fakeInternal.status).toBe(401);
  });

  it('6: isolation holds under OAuth in both directions', async () => {
    const user1 = await login('user1@example.com');
    const user2 = await login('user2@example.com');

    await callOAuth(user1.accessToken, 'log_weighin', { date: '2026-08-01', weight_lbs: 200 });
    await callOAuth(user2.accessToken, 'log_weighin', { date: '2026-08-01', weight_lbs: 150 });

    const kingRows = await callOAuth(user1.accessToken, 'query', {
      sql: 'SELECT weight_lbs FROM weighins',
    });
    expect(kingRows.data.rows).toEqual([{ weight_lbs: 200 }]);

    const annaRows = await callOAuth(user2.accessToken, 'query', {
      sql: 'SELECT weight_lbs FROM weighins',
    });
    expect(annaRows.data.rows).toEqual([{ weight_lbs: 150 }]);
  });

  it('7: dynamic client registration returns a usable client_id', async () => {
    const clientId = await registerClient('Some Other Client');
    expect(clientId.length).toBeGreaterThan(0);
    // Usable: it can drive a full login.
    const { verifier, challenge } = await pkce();
    const { googleState } = await approveAndGetGoogleState(clientId, challenge);
    mockGoogle('user1@example.com');
    const cbRes = await callback(googleState);
    expect(cbRes.status).toBe(302);
  });

  it('8: refresh exchange returns a working new access token', async () => {
    const { refreshToken, clientId } = await login('user1@example.com');
    const res = await SELF.fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    expect(res.status).toBe(200);
    const tok = (await res.json()) as { access_token: string };
    expect(tok.access_token).toBeTruthy();
    const who = await callOAuth(tok.access_token, 'whoami');
    expect(who.data.name).toBe('User One');
  });

  it('9: the old static path-token form on /mcp is rejected (401)', async () => {
    const { status } = await rpc(null, 'tools/list', {}, { path: `/mcp/${USER1_TOKEN}` });
    expect(status).toBe(401);
  });

  it('10: /upload still works on a static bearer (Shortcut path unaffected)', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'p.jpg', { type: 'image/jpeg' }));
    form.append('date', '2026-08-02');
    const res = await SELF.fetch(`${BASE}/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${USER1_TOKEN}` },
      body: form,
    });
    expect(res.status).toBe(201);
  });

  it('11: consent is remembered per client — same client skips the dialog, a new one does not', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();

    // First authorization: dialog shown, cookie set.
    const first = await approveAndGetGoogleState(clientId, challenge);
    expect(first.dialogShown).toBe(true);
    expect(first.setCookie).toBeTruthy();
    const cookie = first.setCookie!.split(';')[0];

    // Same client, carrying the cookie: dialog skipped.
    const second = await approveAndGetGoogleState(clientId, challenge, cookie);
    expect(second.dialogShown).toBe(false);

    // A different client with the same cookie must still see the dialog.
    const otherClient = await registerClient('Different Client');
    const third = await approveAndGetGoogleState(otherClient, challenge, cookie);
    expect(third.dialogShown).toBe(true);
  });
});
