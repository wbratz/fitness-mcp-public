/**
 * Consent-approval cookie, tamper-evident state, and the approval / rejection
 * pages for the OAuth login flow.
 *
 * Dynamically registered MCP clients are unverified by definition, so before an
 * authorization is completed we show a page naming the requesting client and
 * remember the human's approval in a signed cookie. A bare auto-approve would
 * let anyone who discovers the endpoint complete a flow.
 *
 * All crypto is Web Crypto HMAC-SHA256, matching sig.ts and auth.ts — no
 * node:crypto, no nodejs_compat.
 */

const encoder = new TextEncoder();
const COOKIE_NAME = 'mcp_approved_clients';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // one year

function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function sign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

async function verify(secret: string, data: string, signature: string): Promise<boolean> {
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlDecode(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', await hmacKey(secret), sigBytes, encoder.encode(data));
}

/** Sign an arbitrary JSON-able value into a tamper-evident `payload.sig` token. */
export async function encodeSignedState(value: unknown, secret: string): Promise<string> {
  const payload = b64urlEncode(encoder.encode(JSON.stringify(value)));
  return `${payload}.${await sign(secret, payload)}`;
}

/** Reverse of encodeSignedState; returns null on a missing or bad signature. */
export async function decodeSignedState<T>(token: string, secret: string): Promise<T | null> {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!(await verify(secret, payload, signature))) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as T;
  } catch {
    return null;
  }
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

async function readApprovedClients(request: Request, secret: string): Promise<string[]> {
  const raw = parseCookies(request.headers.get('Cookie'))[COOKIE_NAME];
  if (!raw) return [];
  const list = await decodeSignedState<string[]>(decodeURIComponent(raw), secret);
  return Array.isArray(list) ? list : [];
}

/** Has the human already approved this client id in a prior authorization? */
export async function clientIdAlreadyApproved(
  request: Request,
  clientId: string,
  secret: string,
): Promise<boolean> {
  return (await readApprovedClients(request, secret)).includes(clientId);
}

/** A Set-Cookie value adding `clientId` to the signed approved-clients list. */
export async function approvedClientsCookie(
  request: Request,
  clientId: string,
  secret: string,
): Promise<string> {
  const current = await readApprovedClients(request, secret);
  const next = current.includes(clientId) ? current : [...current, clientId];
  const value = encodeURIComponent(await encodeSignedState(next, secret));
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function page(status: number, body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fitness Tracker</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem;color:#111}
  .card{border:1px solid #e5e5e5;border-radius:12px;padding:1.5rem}
  button{font:inherit;padding:.6rem 1.1rem;border-radius:8px;border:0;background:#111;color:#fff;cursor:pointer}
  code{background:#f3f3f3;padding:.1rem .35rem;border-radius:4px}
</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** The approval dialog. Its form POSTs the signed `state` back to /authorize. */
export function renderApprovalDialog(opts: {
  clientName: string;
  serverName: string;
  state: string;
}): Response {
  return page(
    200,
    `<div class="card">
      <h1>Connect ${escapeHtml(opts.serverName)}</h1>
      <p><strong>${escapeHtml(opts.clientName)}</strong> is asking to connect to your
      ${escapeHtml(opts.serverName)} data. You'll sign in with Google on the next screen.</p>
      <form method="post" action="/authorize">
        <input type="hidden" name="state" value="${escapeHtml(opts.state)}">
        <button type="submit">Approve and continue</button>
      </form>
    </div>`,
  );
}

/** The rejection page for a Google login whose email is not on the allowlist. */
export function renderRejected(message: string): Response {
  return page(
    403,
    `<div class="card">
      <h1>Not authorized</h1>
      <p>${escapeHtml(message)}</p>
      <p>No access was granted and no data was reached.</p>
    </div>`,
  );
}
