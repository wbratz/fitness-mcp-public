/**
 * Non-MCP HTTP endpoints: photo upload, photo streaming, and raw exports.
 * Every handler receives an already-authenticated UserCtx.
 */
import type { Env, UserCtx } from './auth.js';
import { first, isTableName, readTable, ALL_TABLES, TABLE_COLUMNS } from './db.js';
import type { Row } from './db.js';
import { isIsoDate, resolveDate } from './dates.js';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Only these image types are accepted, and they decide the stored extension. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export function json(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function textError(message: string, status: number): Response {
  return json({ error: message }, status);
}

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keep R2 keys predictable: lowercase, alphanumeric and dashes only. */
function slugForKey(value: string | null): string {
  if (!value) return 'x';
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'x' : slug.slice(0, 24);
}

type FormValue = File | string | null;

function optionalNumber(value: FormValue, field: string): number | null {
  if (value === null || typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a number (got "${value}")`);
  return parsed;
}

function optionalString(value: FormValue): string | null {
  if (value === null || typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

/**
 * POST /upload — multipart form: file (required), date?, pose?, weight_lbs?, notes?
 * Stores the object under this user's prefix and inserts a row in their database.
 */
export async function handleUpload(request: Request, ctx: UserCtx, env: Env): Promise<Response> {
  if (request.method !== 'POST') return textError('POST required', 405);

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return textError('expected multipart/form-data with a "file" part', 415);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return textError('could not parse multipart body', 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return textError('missing "file" part', 400);
  if (file.size === 0) return textError('uploaded file is empty', 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return textError(
      `file is ${file.size} bytes; the limit is ${MAX_UPLOAD_BYTES} (8 MB). Resize before uploading.`,
      413,
    );
  }

  const fileType = (file.type || '').toLowerCase().split(';')[0]!.trim();
  const extension = IMAGE_EXTENSIONS[fileType];
  if (!extension) {
    return textError(
      `unsupported content type "${fileType || 'unknown'}"; expected one of ${Object.keys(IMAGE_EXTENSIONS).join(', ')}`,
      415,
    );
  }

  let date: string;
  let weight: number | null;
  try {
    const rawDate = optionalString(form.get('date'));
    date = resolveDate(rawDate ?? undefined);
    weight = optionalNumber(form.get('weight_lbs'), 'weight_lbs');
  } catch (error) {
    return textError(error instanceof Error ? error.message : String(error), 400);
  }

  const pose = optionalString(form.get('pose'));
  const notes = optionalString(form.get('notes'));
  const key = `${ctx.picsPrefix}${date}-${slugForKey(pose)}-${randomSuffix()}.${extension}`;

  await env.PICS.put(key, file.stream(), { httpMetadata: { contentType: fileType } });

  try {
    const row = await first<Row>(
      ctx.db,
      `INSERT INTO progress_pics (date, r2_key, pose, weight_lbs, content_type, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id, date, pose, weight_lbs, content_type, notes, created_at`,
      date,
      key,
      pose,
      weight,
      fileType,
      notes,
    );
    return json({ ok: true, user: ctx.displayName, r2_key: key, pic: row }, 201);
  } catch (error) {
    // Don't leave an orphan object behind if the row insert fails.
    await env.PICS.delete(key).catch(() => undefined);
    throw error;
  }
}

/**
 * GET /pic/:id — stream one image. The id is always resolved in the database of
 * the user the request authenticated as (or the user named in a verified
 * signature), so ids cannot be probed across accounts.
 */
export async function handlePic(id: number, ctx: UserCtx, env: Env): Promise<Response> {
  const pic = await first<{ r2_key: string; content_type: string }>(
    ctx.db,
    'SELECT r2_key, content_type FROM progress_pics WHERE id = ?',
    id,
  );
  if (!pic) return textError('not found', 404);
  if (!pic.r2_key.startsWith(ctx.picsPrefix)) return textError('not found', 404);

  const object = await env.PICS.get(pic.r2_key);
  if (!object) return textError('image object missing from storage', 404);

  return new Response(object.body, {
    headers: {
      'content-type': pic.content_type,
      'content-length': String(object.size),
      'cache-control': 'private, max-age=3600',
      etag: object.httpEtag,
    },
  });
}

/** GET /export.json — the authenticated user's seven tables, optional ?from=&to= */
export async function handleExportJson(url: URL, ctx: UserCtx): Promise<Response> {
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value !== undefined && !isIsoDate(value)) {
      return textError(`${name} must be YYYY-MM-DD`, 400);
    }
  }

  const tables: Record<string, Row[]> = {};
  for (const table of ALL_TABLES) {
    tables[table] = await readTable(ctx.db, table, from, to);
  }

  return json(
    {
      user: ctx.displayName,
      exported_at: new Date().toISOString(),
      range: { from: from ?? null, to: to ?? null },
      tables,
    },
    200,
    { 'content-disposition': `attachment; filename="fitness-${ctx.userId}.json"` },
  );
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** GET /export.csv?table=sets — one table as CSV. */
export async function handleExportCsv(url: URL, ctx: UserCtx): Promise<Response> {
  const table = url.searchParams.get('table');
  if (!table) {
    return textError(`?table= is required. Valid tables: ${ALL_TABLES.join(', ')}`, 400);
  }
  if (!isTableName(table)) {
    return textError(`unknown table "${table}". Valid tables: ${ALL_TABLES.join(', ')}`, 400);
  }

  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const rows = await readTable(ctx.db, table, from, to);

  // Static column list, so the header is stable even when zero rows match.
  const header = TABLE_COLUMNS[table];

  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(header.map((column) => csvCell(row[column])).join(','));
  }

  return new Response(`${lines.join('\r\n')}\r\n`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="fitness-${ctx.userId}-${table}.csv"`,
    },
  });
}
