/**
 * Google login handlers for the OAuth flow. Google is only the upstream
 * *identity* provider: it answers "which human is this," we map the verified
 * email to a userId via the allowlist, and OAuthProvider issues its own tokens
 * to the MCP client. No password handling, and the Google token is used once.
 *
 *   GET  /authorize  parse the auth request; show the consent page (or, if the
 *                    client is already approved, skip to Google).
 *   POST /authorize  consent approved -> set the approval cookie -> go to Google.
 *   GET  /callback   exchange the code, read the email, map it to a userId, and
 *                    completeAuthorization — or render "not authorized".
 */
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';

import type { Env } from './auth.js';
import { resolveEmail } from './auth.js';
import {
  approvedClientsCookie,
  clientIdAlreadyApproved,
  decodeSignedState,
  encodeSignedState,
  renderApprovalDialog,
  renderRejected,
} from './workers-oauth-utils.js';

const SERVER_NAME = 'Fitness Tracker';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Build the Google consent URL, carrying the (signed) auth request as state. */
async function googleAuthUrl(env: Env, origin: string, authReq: AuthRequest): Promise<string> {
  const state = await encodeSignedState(authReq, env.COOKIE_ENCRYPTION_KEY);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH}?${params.toString()}`;
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...extraHeaders } });
}

/** GET and POST /authorize. */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // POST: the consent form was submitted. Trust only the signed state.
  if (request.method === 'POST') {
    const form = await request.formData();
    const authReq = await decodeSignedState<AuthRequest>(
      String(form.get('state') ?? ''),
      env.COOKIE_ENCRYPTION_KEY,
    );
    if (!authReq?.clientId) return new Response('invalid or expired approval', { status: 400 });
    const cookie = await approvedClientsCookie(request, authReq.clientId, env.COOKIE_ENCRYPTION_KEY);
    return redirect(await googleAuthUrl(env, url.origin, authReq), { 'set-cookie': cookie });
  }

  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

  const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  if (!authReq.clientId) return new Response('invalid authorization request', { status: 400 });

  // A client the human already approved skips straight to Google.
  if (await clientIdAlreadyApproved(request, authReq.clientId, env.COOKIE_ENCRYPTION_KEY)) {
    return redirect(await googleAuthUrl(env, url.origin, authReq));
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
  const state = await encodeSignedState(authReq, env.COOKIE_ENCRYPTION_KEY);
  return renderApprovalDialog({
    clientName: client?.clientName || authReq.clientId,
    serverName: SERVER_NAME,
    state,
  });
}

interface GoogleTokenResponse {
  access_token?: string;
  id_token?: string;
}
interface GoogleUserinfo {
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

/** GET /callback — Google has returned with an authorization code. */
export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) return renderRejected(`Google reported: ${error}`);

  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  if (!code || !stateParam) return new Response('missing code or state', { status: 400 });

  const authReq = await decodeSignedState<AuthRequest>(stateParam, env.COOKIE_ENCRYPTION_KEY);
  if (!authReq?.clientId) return new Response('invalid state', { status: 400 });

  // Exchange the code for a Google access token.
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return new Response('google token exchange failed', { status: 502 });
  const token = (await tokenRes.json()) as GoogleTokenResponse;
  if (!token.access_token) return new Response('google returned no access token', { status: 502 });

  // Read the identity.
  const userinfoRes = await fetch(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userinfoRes.ok) return new Response('google userinfo failed', { status: 502 });
  const userinfo = (await userinfoRes.json()) as GoogleUserinfo;

  const email = (userinfo.email ?? '').trim();
  const verified = userinfo.email_verified === true || userinfo.email_verified === 'true';
  if (!email || !verified) return renderRejected('Your Google account has no verified email.');

  // The allowlist is the gate. A non-allowlisted email gets no token, no grant,
  // and no database binding — the new equivalent of a 401.
  const userId = resolveEmail(email, env);
  if (!userId) return renderRejected(`${email} is not authorized for this server.`);

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId,
    scope: authReq.scope?.length ? authReq.scope : ['mcp'],
    metadata: { label: email },
    props: { userId, email, displayName: userinfo.name || email },
  });
  return redirect(redirectTo);
}
