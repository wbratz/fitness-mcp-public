/**
 * Token -> user resolution.
 *
 * There is no users table. A single Worker secret TOKENS_JSON maps opaque tokens
 * to user ids, and a static code map turns a user id into a D1 binding + R2 key
 * prefix. Every request handler receives a UserCtx and touches nothing else, so
 * a handler physically cannot reach another user's rows or objects.
 */

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB_USER1: D1Database;
  DB_USER2: D1Database;
  PICS: R2Bucket;
  /** JSON object: { "<token>": "user1", "<token>": "user2" } */
  TOKENS_JSON: string;
  /** Signs short-lived /pic/:id URLs. */
  SIGNING_SECRET: string;

  // v3 OAuth additions --------------------------------------------------------
  /** Injected by OAuthProvider; the OAuth server helper API. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Provider storage for clients, grants, and issued tokens. */
  OAUTH_KV: KVNamespace;
  /** Google OAuth web client, used once at login to read identity. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Signs the consent-approval cookie (`openssl rand -hex 32`). */
  COOKIE_ENCRYPTION_KEY: string;
  /** JSON object: { "user1@…": "user1", "user2@…": "user2" } — the email allowlist. */
  USER_EMAILS_JSON: string;
}

export type UserId = 'user1' | 'user2';

/**
 * The complete registry of users. Adding a third person means a new D1 database,
 * a new binding in wrangler.toml, an entry here, a token in TOKENS_JSON, and a
 * deploy. That cost is deliberate — see README §Trade-offs.
 */
const USERS = {
  user1: { displayName: 'User One', binding: 'DB_USER1' },
  user2: { displayName: 'User Two', binding: 'DB_USER2' },
} as const satisfies Record<UserId, { displayName: string; binding: 'DB_USER1' | 'DB_USER2' }>;

export interface UserCtx {
  userId: UserId;
  displayName: string;
  /** This user's database. The only one any handler ever sees. */
  db: D1Database;
  /** 'user1/pics/' — every R2 key this user can touch starts with this. */
  picsPrefix: string;
  /** The authenticated token, for building follow-up URLs. */
  token: string;
  /** e.g. 'https://fitness-mcp.example.workers.dev' */
  origin: string;
}

export function isUserId(value: string): value is UserId {
  return Object.hasOwn(USERS, value);
}

/** Cheap per-isolate memo so we only JSON.parse the secret once. */
let tokensCache: { raw: string; map: Map<string, UserId> } | null = null;

function parseTokens(raw: string): Map<string, UserId> {
  if (tokensCache?.raw === raw) return tokensCache.map;

  const map = new Map<string, UserId>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TOKENS_JSON is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TOKENS_JSON must be a JSON object of {token: userId}');
  }
  for (const [token, userId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof userId !== 'string' || !isUserId(userId)) {
      throw new Error(`TOKENS_JSON maps a token to unknown user "${String(userId)}"`);
    }
    map.set(token, userId);
  }
  tokensCache = { raw, map };
  return map;
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/** Both inputs are always 32-byte digests, so the length check never leaks. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Accepted, in order: Authorization: Bearer <token>, then an explicit path
 * segment (POST /mcp/<token> — how claude.ai and ChatGPT connect), then
 * ?key=<token>.
 */
export function extractToken(request: Request, url: URL, pathToken?: string): string | null {
  const header = request.headers.get('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1]!.trim();
  }
  if (pathToken) return pathToken;
  return url.searchParams.get('key');
}

/**
 * Resolve a token to a user via constant-time comparison of SHA-256 digests.
 * Every candidate is compared even after a match so the loop cannot be timed to
 * learn which token matched.
 */
export async function resolveToken(token: string, env: Env): Promise<UserId | null> {
  const tokens = parseTokens(env.TOKENS_JSON);
  const presented = await sha256(token);

  let matched: UserId | null = null;
  for (const [candidate, userId] of tokens) {
    const known = await sha256(candidate);
    if (constantTimeEqual(presented, known)) matched = userId;
  }
  return matched;
}

export function buildCtx(userId: UserId, token: string, env: Env, url: URL): UserCtx {
  const user = USERS[userId];
  return {
    userId,
    displayName: user.displayName,
    db: env[user.binding],
    picsPrefix: `${userId}/pics/`,
    token,
    origin: url.origin,
  };
}

/**
 * Full request -> UserCtx. Returns null when no usable token is present, which
 * every caller turns into a 401.
 */
export async function authenticate(
  request: Request,
  url: URL,
  env: Env,
  pathToken?: string,
): Promise<UserCtx | null> {
  const token = extractToken(request, url, pathToken);
  if (!token) return null;
  const userId = await resolveToken(token, env);
  if (!userId) return null;
  return buildCtx(userId, token, env, url);
}

// --- v3 OAuth: identity from validated provider props ------------------------

/**
 * The props an authorization writes into a grant. Only `userId` is load-bearing
 * downstream; the rest ride along for logging and future use.
 */
export interface UserProps {
  userId: UserId;
  displayName?: string;
  email?: string;
}

/** Type guard for props coming back off a token, which are `unknown` by origin. */
export function isUserProps(value: unknown): value is UserProps {
  return (
    typeof value === 'object' &&
    value !== null &&
    isUserId((value as { userId?: unknown }).userId as string)
  );
}

/**
 * Build a UserCtx from OAuth props (or the static-token fallback's props). The
 * only trusted field is `userId`; the display name and the D1 binding come from
 * the server-side USERS registry, never from the token, so a forged prop cannot
 * select another user's database.
 */
export function ctxFromProps(props: unknown, env: Env, url: URL): UserCtx | null {
  if (!isUserProps(props)) return null;
  // token is unused off the OAuth path (no follow-up URL carries it); '' is safe.
  return buildCtx(props.userId, '', env, url);
}

/** Cheap per-isolate memo for the email allowlist, mirroring parseTokens. */
let emailsCache: { raw: string; map: Map<string, UserId> } | null = null;

function parseEmails(raw: string): Map<string, UserId> {
  if (emailsCache?.raw === raw) return emailsCache.map;
  const map = new Map<string, UserId>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('USER_EMAILS_JSON is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('USER_EMAILS_JSON must be a JSON object of {email: userId}');
  }
  for (const [email, userId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof userId !== 'string' || !isUserId(userId)) {
      throw new Error(`USER_EMAILS_JSON maps an email to unknown user "${String(userId)}"`);
    }
    map.set(email.toLowerCase(), userId);
  }
  emailsCache = { raw, map };
  return map;
}

/** Resolve a verified Google email to a user id, or null if not allowlisted. */
export function resolveEmail(email: string, env: Env): UserId | null {
  return parseEmails(env.USER_EMAILS_JSON).get(email.trim().toLowerCase()) ?? null;
}
