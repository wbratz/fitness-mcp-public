/**
 * Short-lived signed URLs for progress photos.
 *
 * `get_progress_pic` hands the model a link it can pass to the user as a
 * fallback for clients that don't render image content blocks. Putting the
 * account token in that link would make it a permanent full-access credential
 * for anyone it gets forwarded to, so instead we sign one image id for one hour.
 *
 * The signature covers the user id, so a signature minted for one person's photo
 * can never be replayed against the other's database.
 */
import { constantTimeEqual, type Env, type UserId } from './auth.js';

const DEFAULT_TTL_SECONDS = 3600;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sign(secret: string, payload: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return new Uint8Array(mac);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function payloadFor(userId: string, picId: number, exp: number): string {
  return `pic:${userId}:${picId}:${exp}`;
}

/** Absolute, expiring URL for one image. */
export async function signPicUrl(
  env: Env,
  origin: string,
  userId: UserId,
  picId: number,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now: Date = new Date(),
): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const sig = toHex(await sign(env.SIGNING_SECRET, payloadFor(userId, picId, exp)));
  const url = new URL(`/pic/${picId}`, origin);
  url.searchParams.set('u', userId);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', sig);
  return url.toString();
}

export interface SigCheck {
  ok: boolean;
  /** Set only when ok — the user whose database the id should be resolved in. */
  userId?: UserId;
  reason?: string;
}

/**
 * Verify a signed pic URL. Returns the user id from the *signed* payload, never
 * from an unauthenticated query param the caller could edit.
 */
export async function verifyPicUrl(
  env: Env,
  url: URL,
  picId: number,
  isKnownUser: (value: string) => value is UserId,
  now: Date = new Date(),
): Promise<SigCheck> {
  const userParam = url.searchParams.get('u');
  const expParam = url.searchParams.get('exp');
  const sigParam = url.searchParams.get('sig');
  if (!userParam || !expParam || !sigParam) return { ok: false, reason: 'missing signature' };

  const exp = Number(expParam);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: 'malformed expiry' };
  if (exp * 1000 <= now.getTime()) return { ok: false, reason: 'link expired' };

  const presented = fromHex(sigParam);
  if (!presented) return { ok: false, reason: 'malformed signature' };

  const expected = await sign(env.SIGNING_SECRET, payloadFor(userParam, picId, exp));
  if (!constantTimeEqual(presented, expected)) return { ok: false, reason: 'bad signature' };

  // Only trust the user id after the MAC over it has verified.
  if (!isKnownUser(userParam)) return { ok: false, reason: 'unknown user' };
  return { ok: true, userId: userParam };
}
