/**
 * Read-only guard for the `query` escape hatch.
 *
 * Cross-user isolation is NOT this file's job — that is handled structurally by
 * running against one user's database. This only keeps the tool read-only.
 *
 * The strategy is to analyze a copy of the statement with comments and quoted
 * literals blanked out, so `WHERE notes = 'drop'` is fine while a real `DROP`
 * keyword is caught. The original, unmodified SQL is what actually executes.
 */

/** Statement keywords that must never appear as bare word tokens. */
const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA|ATTACH|DETACH|REPLACE|VACUUM|REINDEX)\b/i;

export type GuardResult = { ok: true; sql: string } | { ok: false; error: string };

/**
 * Replace comments and quoted spans with spaces. Returns null when the input
 * has an unterminated comment or quote, which we treat as malformed rather than
 * guessing at intent.
 */
function blankQuotedAndComments(sql: string): string | null {
  let out = '';
  let i = 0;

  const skipQuoted = (quote: string, allowDoubling: boolean): boolean => {
    i += 1; // opening quote
    while (i < sql.length) {
      if (sql[i] === quote) {
        if (allowDoubling && sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        i += 1; // closing quote
        return true;
      }
      i += 1;
    }
    return false;
  };

  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      if (!skipQuoted(c, true)) return null;
      out += ' ';
      continue;
    }
    if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) return null;
      i = end + 1;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Validate a caller-supplied statement. Accepts a single SELECT or WITH…SELECT;
 * rejects everything else.
 */
export function guardReadOnlySql(raw: string): GuardResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'sql must be a non-empty string' };
  }
  const sql = raw.trim();

  const analyzed = blankQuotedAndComments(sql);
  if (analyzed === null) {
    return { ok: false, error: 'Rejected: unterminated string literal or block comment.' };
  }

  const body = analyzed.trim();
  if (body === '') {
    return { ok: false, error: 'Rejected: statement contains no executable SQL.' };
  }

  if (!/^(SELECT|WITH)\b/i.test(body)) {
    return {
      ok: false,
      error: 'Rejected: read-only tool — the statement must begin with SELECT or WITH.',
    };
  }

  // A single trailing semicolon is fine; anything before the end is a second
  // statement. Strip trailing ';' plus whitespace, then look for leftovers.
  const withoutTrailing = body.replace(/[\s;]+$/, '');
  if (withoutTrailing.includes(';')) {
    return { ok: false, error: 'Rejected: multiple statements are not allowed.' };
  }

  const forbidden = FORBIDDEN.exec(withoutTrailing);
  if (forbidden) {
    return {
      ok: false,
      error: `Rejected: read-only tool — the keyword ${forbidden[1]!.toUpperCase()} is not permitted.`,
    };
  }

  return { ok: true, sql };
}

/** Hard ceiling on rows returned by the `query` tool. */
export const QUERY_ROW_CAP = 1000;
