/**
 * D1 query helpers. Every function takes the database explicitly (always
 * ctx.db) — there is no module-level connection, so a helper can never
 * accidentally read the wrong user's data.
 */

export type Row = Record<string, unknown>;

export async function all<T = Row>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return result.results ?? [];
}

export async function first<T = Row>(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<T | null> {
  return (
    (await db
      .prepare(sql)
      .bind(...binds)
      .first<T>()) ?? null
  );
}

export async function run(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<D1Result<never>> {
  return db
    .prepare(sql)
    .bind(...binds)
    .run();
}

/** The seven tables an export covers. */
export const ALL_TABLES = [
  'workouts',
  'sets',
  'weighins',
  'meals',
  'progress_pics',
  'profile',
  'plans',
] as const;

export type TableName = (typeof ALL_TABLES)[number];

/**
 * Column order per table, mirroring migrations/0001_init.sql. Declared here
 * rather than read from pragma_table_info so CSV export produces a stable header
 * even when a range filter returns zero rows.
 */
export const TABLE_COLUMNS: Record<TableName, readonly string[]> = {
  workouts: ['id', 'date', 'label', 'duration_min', 'notes', 'created_at'],
  sets: [
    'id',
    'workout_id',
    'date',
    'exercise',
    'set_number',
    'weight_lbs',
    'reps',
    'rpe',
    'is_warmup',
    'notes',
    'created_at',
    // Added by 0002; ALTER TABLE appends, so these come last.
    'duration_sec',
    'distance_m',
  ],
  weighins: ['id', 'date', 'weight_lbs', 'notes', 'created_at'],
  meals: [
    'id',
    'date',
    'time',
    'description',
    'calories',
    'protein_g',
    'carbs_g',
    'fat_g',
    'source',
    'notes',
    'created_at',
  ],
  progress_pics: [
    'id',
    'date',
    'r2_key',
    'pose',
    'weight_lbs',
    'content_type',
    'notes',
    'created_at',
  ],
  profile: ['id', 'goal', 'stats_json', 'updated_at'],
  plans: ['id', 'name', 'content', 'is_active', 'created_at'],
};

/** Tables carrying a `date` column, so from/to range filters apply. */
const DATED_TABLES = new Set<TableName>([
  'workouts',
  'sets',
  'weighins',
  'meals',
  'progress_pics',
]);

export function isTableName(value: string): value is TableName {
  return (ALL_TABLES as readonly string[]).includes(value);
}

export function hasDateColumn(table: TableName): boolean {
  return DATED_TABLES.has(table);
}

/**
 * Read one whole table, optionally range-filtered on its `date` column.
 * `table` is validated against ALL_TABLES by the caller, never interpolated
 * from raw user input.
 */
export async function readTable(
  db: D1Database,
  table: TableName,
  from?: string,
  to?: string,
): Promise<Row[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (hasDateColumn(table)) {
    if (from) {
      where.push('date >= ?');
      binds.push(from);
    }
    if (to) {
      where.push('date <= ?');
      binds.push(to);
    }
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const order = hasDateColumn(table) ? ' ORDER BY date, id' : ' ORDER BY id';
  return all(db, `SELECT * FROM ${table}${clause}${order}`, ...binds);
}

/**
 * Build the SET clause for a partial update from a whitelist of columns.
 * `undefined` means "leave alone"; `null` means "clear the column".
 */
export function buildUpdate(
  patch: Record<string, unknown>,
  allowed: readonly string[],
): { clause: string; binds: unknown[] } | null {
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const column of allowed) {
    if (!Object.hasOwn(patch, column)) continue;
    const value = patch[column];
    if (value === undefined) continue;
    parts.push(`${column} = ?`);
    binds.push(value);
  }
  if (parts.length === 0) return null;
  return { clause: parts.join(', '), binds };
}
