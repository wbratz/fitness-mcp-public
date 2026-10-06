/**
 * All server-side date defaults resolve in this zone. The model is expected to
 * convert relative dates ("Monday", "yesterday") to explicit YYYY-MM-DD before
 * calling, so this only matters when `date` is omitted entirely.
 *
 * Change this one line to move the household to another zone.
 */
export const DEFAULT_TZ = 'America/New_York';

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: DEFAULT_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today in DEFAULT_TZ as 'YYYY-MM-DD' (en-CA formats as ISO). */
export function today(now: Date = new Date()): string {
  return DATE_FMT.format(now);
}

/** Full ISO-8601 UTC, matching the schema's created_at default. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString().replace(/\.(\d{3})Z$/, '.$1Z');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  // Reject calendar-invalid dates like 2026-02-30.
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function isHhMm(value: string): boolean {
  return HH_MM.test(value);
}

/** Validate an optional date argument, defaulting to today in DEFAULT_TZ. */
export function resolveDate(value: string | undefined, field = 'date'): string {
  if (value === undefined || value === '') return today();
  if (!isIsoDate(value)) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date (got "${value}")`);
  }
  return value;
}
