/**
 * MCP server construction and tool registration.
 *
 * A fresh McpServer is built per request (stateless transport) and closed over a
 * single UserCtx, so every tool below can only ever touch that user's database
 * and R2 prefix.
 *
 * Tool descriptions are load-bearing product surface: both Claude and ChatGPT
 * read them, and they carry the parsing behavior this server depends on. Write
 * them as if they are the only documentation the model will ever see.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Env, UserCtx } from './auth.js';
import { all, buildUpdate, first, isTableName, readTable, run, ALL_TABLES } from './db.js';
import type { Row, TableName } from './db.js';
import { DEFAULT_TZ, isHhMm, isIsoDate, nowIso, resolveDate } from './dates.js';
import { signPicUrl } from './sig.js';
import { guardReadOnlySql, QUERY_ROW_CAP } from './sql-guard.js';

const EXPORT_ROW_CAP = 5000;

/**
 * Largest photo get_progress_pic will inline as base64. base64 inflates bytes by
 * ~4/3, so the 8 MB /upload ceiling (http.ts MAX_UPLOAD_BYTES) would embed as
 * ~10.7 MB — enough to blow the tool-response budget. Above this we error and
 * hand back the expiring link instead, which streams the full image out of band.
 * (v2 §5.5.)
 */
const MAX_INLINE_PIC_BYTES = 3 * 1024 * 1024;

/** Compact DDL, embedded in the `query` tool description. */
const SCHEMA_DDL = `
workouts(id, date TEXT 'YYYY-MM-DD', label TEXT NULL, duration_min INTEGER NULL, notes TEXT NULL, created_at TEXT)
sets(id, workout_id INTEGER NULL -> workouts.id, date TEXT, exercise TEXT, set_number INTEGER NULL,
     weight_lbs REAL NULL /* NULL = bodyweight */, reps INTEGER NULL /* NULL for timed/distance work */,
     duration_sec INTEGER NULL /* planks, holds, timed carries */,
     distance_m REAL NULL /* metres; carries, sprints, sled work */,
     rpe REAL NULL, is_warmup INTEGER 0|1, notes TEXT NULL, created_at TEXT)
  -- A set has at least one of reps, duration_sec, distance_m. Rep work has reps
  -- and NULL duration/distance; a plank has duration_sec and NULL reps.
weighins(id, date TEXT UNIQUE, weight_lbs REAL, notes TEXT NULL, created_at TEXT)
meals(id, date TEXT, time TEXT NULL 'HH:MM', description TEXT, calories INTEGER NULL,
      protein_g REAL NULL, carbs_g REAL NULL, fat_g REAL NULL, source TEXT 'estimate'|'manual',
      notes TEXT NULL, created_at TEXT)
progress_pics(id, date TEXT, r2_key TEXT UNIQUE, pose TEXT NULL, weight_lbs REAL NULL,
              content_type TEXT, notes TEXT NULL, created_at TEXT)
profile(id = 1 singleton, goal TEXT NULL, stats_json TEXT NULL, updated_at TEXT)
plans(id, name TEXT, content TEXT, is_active INTEGER 0|1, created_at TEXT)
`.trim();

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function boolToInt(value: boolean | undefined): number | undefined {
  return value === undefined ? undefined : value ? 1 : 0;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Validate an optional YYYY-MM-DD range bound. */
function checkRange(from?: string, to?: string): void {
  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value !== undefined && !isIsoDate(value)) {
      throw new Error(`${name} must be a valid YYYY-MM-DD date (got "${value}")`);
    }
  }
}

/**
 * Workout attachment rule, shared by log_sets and log_workout_meta:
 *   1. A workout for this date with the same label (or any workout for the date
 *      when no label is given) -> attach to the most recent such workout.
 *   2. Otherwise create one.
 *
 * This is what makes late and partial logging merge naturally: "oh, I also did
 * curls Monday" lands in Monday's existing workout instead of creating a second.
 *
 * Label comparison is case-insensitive, so "push" and "Push" are one session.
 */
async function findOrCreateWorkout(
  db: D1Database,
  date: string,
  label: string | null,
): Promise<{ workout_id: number; workout_created: boolean }> {
  const existing = label
    ? await first<{ id: number }>(
        db,
        'SELECT id FROM workouts WHERE date = ? AND label = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1',
        date,
        label,
      )
    : await first<{ id: number }>(
        db,
        'SELECT id FROM workouts WHERE date = ? ORDER BY id DESC LIMIT 1',
        date,
      );

  if (existing) return { workout_id: existing.id, workout_created: false };

  const created = await first<{ id: number }>(
    db,
    'INSERT INTO workouts (date, label) VALUES (?, ?) RETURNING id',
    date,
    label,
  );
  if (!created) throw new Error('failed to create workout row');
  return { workout_id: created.id, workout_created: true };
}

export function buildServer(ctx: UserCtx, env: Env): McpServer {
  const server = new McpServer(
    { name: 'fitness', version: '1.0.0' },
    {
      instructions:
        `Personal fitness tracker for ${ctx.displayName}. Call whoami at the start of a ` +
        `session for their goal and current plan, then get_active_plan and get_history ` +
        `as needed so suggestions are grounded in their actual programming and data. ` +
        `Before logging resistance training, call list_exercises and reuse existing ` +
        `exercise names. Resolve relative dates ("Monday", "yesterday") to explicit ` +
        `YYYY-MM-DD before calling any tool.`,
    },
  );

  const db = ctx.db;

  /** Register a tool with uniform error handling. */
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  ): void => {
    server.registerTool(name, { description, inputSchema }, (async (args: unknown) => {
      try {
        return await handler(args as z.infer<z.ZodObject<S>>);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }) as never);
  };

  // ---------------------------------------------------------------------------
  // Identity & context
  // ---------------------------------------------------------------------------

  tool(
    'whoami',
    `Who this database belongs to, plus their goal, active plan name, and most ` +
      `recent weigh-in and workout date. Call this once at the start of a session ` +
      `to orient yourself before giving advice — it tells you whose data you are ` +
      `looking at and what they are working toward. Takes no arguments.`,
    {},
    async () => {
      const profile = await first<{ goal: string | null }>(db, 'SELECT goal FROM profile WHERE id = 1');
      const plan = await first<{ name: string }>(
        db,
        'SELECT name FROM plans WHERE is_active = 1 ORDER BY id DESC LIMIT 1',
      );
      const weighin = await first<Row>(
        db,
        'SELECT date, weight_lbs FROM weighins ORDER BY date DESC LIMIT 1',
      );
      const workout = await first<{ date: string }>(
        db,
        'SELECT date FROM workouts ORDER BY date DESC LIMIT 1',
      );
      return jsonResult({
        name: ctx.displayName,
        goal: profile?.goal ?? null,
        active_plan_name: plan?.name ?? null,
        last_weighin: weighin ?? null,
        last_workout_date: workout?.date ?? null,
        server_timezone: DEFAULT_TZ,
        today: resolveDate(undefined),
      });
    },
  );

  tool(
    'get_profile',
    `Read the stored goal and any volunteered stats (height, age, and so on). ` +
      `Use this when tailoring advice; pair it with get_active_plan.`,
    {},
    async () => {
      const profile = await first<Row>(db, 'SELECT * FROM profile WHERE id = 1');
      return jsonResult(profile ?? {});
    },
  );

  tool(
    'update_profile',
    `Update the goal and/or stats. Partial: omitted fields are left alone. ` +
      `Call this whenever the person states or revises a goal — e.g. "my goal is ` +
      `to tone up and drop 10 lbs by spring" -> update_profile(goal: "tone up, ` +
      `drop 10 lbs by spring"). Store the goal in their own words. ` +
      `stats_json accepts either a JSON object or a JSON string.`,
    {
      goal: z.string().optional().describe('Freeform goal, in the person\'s own words.'),
      stats_json: z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .optional()
        .describe('Object or JSON string: height, age, bodyfat, anything volunteered.'),
    },
    async ({ goal, stats_json }) => {
      let statsText: string | undefined;
      if (stats_json !== undefined) {
        if (typeof stats_json === 'string') {
          try {
            JSON.parse(stats_json);
          } catch {
            throw new Error('stats_json was a string but is not valid JSON');
          }
          statsText = stats_json;
        } else {
          statsText = JSON.stringify(stats_json);
        }
      }

      const patch = buildUpdate({ goal, stats_json: statsText }, ['goal', 'stats_json']);
      if (!patch) throw new Error('provide at least one of goal or stats_json');

      await run(
        db,
        `UPDATE profile SET ${patch.clause}, updated_at = ? WHERE id = 1`,
        ...patch.binds,
        nowIso(),
      );
      return jsonResult(await first<Row>(db, 'SELECT * FROM profile WHERE id = 1'));
    },
  );

  tool(
    'save_plan',
    `Store a workout plan or program. Call this when the person shares their ` +
      `programming — "here's my new program: ..." -> save_plan(name, content, ` +
      `make_active: true). Keep the plan content verbatim as markdown; do not ` +
      `summarize it. Old plans are retained as history, so saving a new one is ` +
      `always safe. With make_active (the default), every other plan is ` +
      `deactivated first.`,
    {
      name: z.string().min(1).describe("Short label, e.g. 'PPL + Shoulders/Arms'."),
      content: z.string().min(1).describe('The plan itself, as markdown. Verbatim.'),
      make_active: z.boolean().optional().describe('Default true. Deactivates all other plans.'),
    },
    async ({ name, content, make_active }) => {
      const activate = make_active !== false;
      if (activate) await run(db, 'UPDATE plans SET is_active = 0 WHERE is_active = 1');
      const created = await first<Row>(
        db,
        'INSERT INTO plans (name, content, is_active) VALUES (?, ?, ?) RETURNING *',
        name,
        content,
        activate ? 1 : 0,
      );
      return jsonResult(created);
    },
  );

  tool(
    'get_active_plan',
    `The currently active workout plan, in full. Call this before suggesting ` +
      `a session so the suggestion follows the plan the person is actually on. ` +
      `Returns null when no plan has been saved yet.`,
    {},
    async () => {
      const plan = await first<Row>(
        db,
        'SELECT * FROM plans WHERE is_active = 1 ORDER BY id DESC LIMIT 1',
      );
      return jsonResult(plan ?? null);
    },
  );

  tool(
    'list_plans',
    `All saved plans, newest first, with id / name / is_active / created_at but ` +
      `without the full content. Use it to find an older plan's id, then get_plan.`,
    {},
    async () =>
      jsonResult(
        await all(db, 'SELECT id, name, is_active, created_at FROM plans ORDER BY id DESC'),
      ),
  );

  tool(
    'get_plan',
    'One plan by id, including its full content. Get ids from list_plans.',
    { id: z.number().int().positive() },
    async ({ id }) => {
      const plan = await first<Row>(db, 'SELECT * FROM plans WHERE id = ?', id);
      if (!plan) throw new Error(`no plan with id ${id}`);
      return jsonResult(plan);
    },
  );

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  const setInput = z.object({
    exercise: z
      .string()
      .min(1)
      .describe('Canonical exercise name. Reuse an existing name from list_exercises.'),
    reps: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('Reps completed. Omit for work measured in time or distance instead.'),
    duration_sec: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(
        'Seconds of work, for holds and timed effort: planks, dead hangs, wall sits, ' +
          'timed carries. Convert to seconds first — "a 90-second plank" is 90, ' +
          '"two minutes" is 120, "1:15" is 75.',
      ),
    distance_m: z
      .number()
      .positive()
      .nullable()
      .optional()
      .describe(
        'Distance in METRES, for carries, sprints, and sled work. Convert before ' +
          'sending: 1 yard = 0.9144, 1 foot = 0.3048, 1 mile = 1609.34. So "40 yards" ' +
          'is 36.58. Report distances back in whatever unit the person used.',
      ),
    weight_lbs: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Pounds. Omit or null for bodyweight movements. For a loaded carry this is ' +
          'the load — say in notes whether it is per hand or total.',
      ),
    rpe: z.number().nullable().optional().describe('Rate of perceived exertion, e.g. 8.5.'),
    set_number: z.number().int().nullable().optional().describe('Ordinal within the exercise.'),
    is_warmup: z.boolean().optional().describe('Default false.'),
    notes: z.string().nullable().optional().describe("Anything specific, e.g. 'paused'."),
  });

  tool(
    'log_sets',
    `The single entry point for all resistance-training data. One call handles ` +
      `one set, one exercise, several exercises, or a whole session — pass however ` +
      `many sets the person reported.\n\n` +
      `Before calling, call list_exercises and map their phrasing onto an existing ` +
      `name ("incline db" -> "Incline Dumbbell Press"). Only introduce a new Title ` +
      `Case name when nothing matches.\n\n` +
      `Expand NxM notation into N separate set rows. Resolve relative dates to an ` +
      `explicit date first; omitting date means today in ${DEFAULT_TZ}.\n\n` +
      `Each set is measured in reps, in time (duration_sec), or in distance ` +
      `(distance_m) — send whichever the person actually reported, and at least one ` +
      `of the three. Never invent a rep count for a hold, and never bury a duration ` +
      `in notes: "3x30s plank" is three sets of duration_sec 30, not reps 30.\n\n` +
      `Examples:\n` +
      `- "bench 185x8, 185x8, 190x6" -> 3 sets, today.\n` +
      `- "Push day: bench 4x8 @185, incline DB 3x10 @70s, laterals 4x15 @25" -> 11 ` +
      `sets, workout_label "Push".\n` +
      `- "3 sets of pull-ups, 12/10/8" -> 3 sets, weight_lbs null (bodyweight).\n` +
      `- "planks, 3 sets of a minute" -> 3 sets, duration_sec 60, reps omitted.\n` +
      `- "held a 2:30 plank" -> 1 set, duration_sec 150.\n` +
      `- "farmer's walks, 4 rounds of 40 yards with the 50s" -> 4 sets, ` +
      `distance_m 36.58, weight_lbs 50, notes "per hand".\n` +
      `- "side planks 45s each side" -> 2 sets, duration_sec 45, notes "left" and ` +
      `"right".\n` +
      `- "dead hang 40s then 35s" -> 2 sets, duration_sec 40 and 35.\n` +
      `- "I also did curls 3x12 @35 on Monday" -> date set to that Monday; it ` +
      `attaches to Monday's existing workout automatically.\n\n` +
      `Sets attach to an existing workout for that date with the same label (or any ` +
      `workout for that date when no label is given), otherwise a new workout is ` +
      `created. Returns workout_id, whether a workout was created, and the new set ids.`,
    {
      date: z.string().optional().describe(`YYYY-MM-DD. Default: today in ${DEFAULT_TZ}.`),
      workout_label: z
        .string()
        .nullable()
        .optional()
        .describe("Session label: 'Push', 'Pull', 'Legs', 'BJJ', freeform."),
      workout_notes: z.string().nullable().optional().describe('Note about the session overall.'),
      sets: z.array(setInput).min(1).describe('One entry per performed set.'),
    },
    async ({ date, workout_label, workout_notes, sets }) => {
      const day = resolveDate(date);

      // A set with no reps, no duration, and no distance records nothing, so
      // reject it rather than storing a row that can never show progression.
      sets.forEach((set, index) => {
        if (set.reps == null && set.duration_sec == null && set.distance_m == null) {
          throw new Error(
            `sets[${index}] ("${set.exercise}") has no measurement — provide at least ` +
              `one of reps, duration_sec (for holds and timed work), or distance_m ` +
              `(for carries and sprints).`,
          );
        }
      });

      const label = workout_label ?? null;
      const attach = await findOrCreateWorkout(db, day, label);

      if (workout_notes) {
        await run(
          db,
          `UPDATE workouts SET notes = CASE
             WHEN notes IS NULL OR notes = '' THEN ?
             ELSE notes || char(10) || ?
           END WHERE id = ?`,
          workout_notes,
          workout_notes,
          attach.workout_id,
        );
      }

      const statements = sets.map((set) =>
        db
          .prepare(
            `INSERT INTO sets
               (workout_id, date, exercise, set_number, weight_lbs, reps,
                duration_sec, distance_m, rpe, is_warmup, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id`,
          )
          .bind(
            attach.workout_id,
            day,
            set.exercise,
            set.set_number ?? null,
            set.weight_lbs ?? null,
            set.reps ?? null,
            set.duration_sec ?? null,
            set.distance_m ?? null,
            set.rpe ?? null,
            boolToInt(set.is_warmup) ?? 0,
            set.notes ?? null,
          ),
      );

      const results = await db.batch<{ id: number }>(statements);
      const setIds = results.flatMap((result) => (result.results ?? []).map((row) => row.id));

      return jsonResult({
        date: day,
        workout_id: attach.workout_id,
        workout_created: attach.workout_created,
        set_ids: setIds,
      });
    },
  );

  tool(
    'log_weighin',
    `Record a body weight in pounds. One row per date — calling twice for the ` +
      `same date overwrites rather than duplicating, so re-logging a correction is ` +
      `safe. Late entries are fine: "forgot Monday — weighed 212.8" -> set date to ` +
      `that Monday.`,
    {
      date: z.string().optional().describe(`YYYY-MM-DD. Default: today in ${DEFAULT_TZ}.`),
      weight_lbs: z.number().positive().describe('Pounds.'),
      notes: z.string().nullable().optional(),
    },
    async ({ date, weight_lbs, notes }) => {
      const day = resolveDate(date);
      const row = await first<Row>(
        db,
        `INSERT INTO weighins (date, weight_lbs, notes) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           weight_lbs = excluded.weight_lbs,
           notes = COALESCE(excluded.notes, weighins.notes)
         RETURNING *`,
        day,
        weight_lbs,
        notes ?? null,
      );
      return jsonResult(row);
    },
  );

  tool(
    'log_meal',
    `Record something eaten. Macros are optional — log the description even when ` +
      `you have no numbers. When you estimate macros yourself (for example from a ` +
      `photo of a plate), set source to "estimate"; use "manual" only when the ` +
      `person supplied the numbers. Keep description specific enough to be useful ` +
      `later ("chicken burrito bowl, double chicken" beats "lunch").`,
    {
      date: z.string().optional().describe(`YYYY-MM-DD. Default: today in ${DEFAULT_TZ}.`),
      time: z.string().nullable().optional().describe("24-hour 'HH:MM'."),
      description: z.string().min(1),
      calories: z.number().int().nullable().optional(),
      protein_g: z.number().nullable().optional(),
      carbs_g: z.number().nullable().optional(),
      fat_g: z.number().nullable().optional(),
      source: z.enum(['estimate', 'manual']).optional().describe("Default 'estimate'."),
      notes: z.string().nullable().optional(),
    },
    async (args) => {
      const day = resolveDate(args.date);
      if (args.time && !isHhMm(args.time)) {
        throw new Error(`time must be 24-hour HH:MM (got "${args.time}")`);
      }
      const row = await first<Row>(
        db,
        `INSERT INTO meals
           (date, time, description, calories, protein_g, carbs_g, fat_g, source, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
        day,
        args.time ?? null,
        args.description,
        args.calories ?? null,
        args.protein_g ?? null,
        args.carbs_g ?? null,
        args.fat_g ?? null,
        args.source ?? 'estimate',
        args.notes ?? null,
      );
      return jsonResult(row);
    },
  );

  tool(
    'log_workout_meta',
    `Record a session with no set-level data: classes, BJJ, cardio, or a lifting ` +
      `session where the numbers weren't tracked. Examples:\n` +
      `- "BJJ tonight, 90 min, hard rounds" -> label "BJJ", duration_min 90.\n` +
      `- "did legs Monday, don't remember numbers" -> date Monday, label "Legs".\n\n` +
      `Uses the same attachment rule as log_sets, so this can also add duration or ` +
      `notes to a session you already logged sets for. Provided fields overwrite; ` +
      `omitted fields are left alone.`,
    {
      date: z.string().optional().describe(`YYYY-MM-DD. Default: today in ${DEFAULT_TZ}.`),
      label: z.string().nullable().optional().describe("'Push', 'BJJ', 'Yoga', freeform."),
      duration_min: z.number().int().positive().nullable().optional(),
      notes: z.string().nullable().optional(),
    },
    async ({ date, label, duration_min, notes }) => {
      const day = resolveDate(date);
      const attach = await findOrCreateWorkout(db, day, label ?? null);

      const patch = buildUpdate(
        { label: label ?? undefined, duration_min, notes },
        ['label', 'duration_min', 'notes'],
      );
      if (patch) {
        await run(
          db,
          `UPDATE workouts SET ${patch.clause} WHERE id = ?`,
          ...patch.binds,
          attach.workout_id,
        );
      }

      return jsonResult({
        workout_created: attach.workout_created,
        workout: await first<Row>(db, 'SELECT * FROM workouts WHERE id = ?', attach.workout_id),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Corrections
  // ---------------------------------------------------------------------------

  tool(
    'update_set',
    `Fix one recorded set. Find its id first with get_day or get_history — e.g. ` +
      `"that last incline set was actually 9 reps" -> look up the set, then ` +
      `update_set(id, reps: 9). Only the fields you pass change. Pass null to clear ` +
      `a field: to convert a set that was logged as reps into a timed one, send ` +
      `reps: null together with duration_sec. Note that changing date does not move ` +
      `the set to a different workout row.`,
    {
      id: z.number().int().positive(),
      exercise: z.string().optional(),
      reps: z.number().int().nullable().optional(),
      duration_sec: z.number().int().positive().nullable().optional().describe('Seconds.'),
      distance_m: z.number().positive().nullable().optional().describe('Metres.'),
      weight_lbs: z.number().nullable().optional(),
      rpe: z.number().nullable().optional(),
      set_number: z.number().int().nullable().optional(),
      is_warmup: z.boolean().optional(),
      notes: z.string().nullable().optional(),
      date: z.string().optional().describe('YYYY-MM-DD.'),
    },
    async ({ id, is_warmup, date, ...rest }) => {
      if (date !== undefined && !isIsoDate(date)) {
        throw new Error(`date must be a valid YYYY-MM-DD date (got "${date}")`);
      }
      const patch = buildUpdate({ ...rest, is_warmup: boolToInt(is_warmup), date }, [
        'exercise',
        'reps',
        'duration_sec',
        'distance_m',
        'weight_lbs',
        'rpe',
        'set_number',
        'is_warmup',
        'notes',
        'date',
      ]);
      if (!patch) throw new Error('provide at least one field to change');

      const result = await run(db, `UPDATE sets SET ${patch.clause} WHERE id = ?`, ...patch.binds, id);
      if (!result.meta.changes) throw new Error(`no set with id ${id}`);
      return jsonResult(await first<Row>(db, 'SELECT * FROM sets WHERE id = ?', id));
    },
  );

  tool(
    'delete_sets',
    `Delete recorded sets by id. Find ids with get_day or get_history first. ` +
      `Returns the number of rows actually removed.`,
    { ids: z.array(z.number().int().positive()).min(1) },
    async ({ ids }) => {
      const placeholders = ids.map(() => '?').join(', ');
      const result = await run(db, `DELETE FROM sets WHERE id IN (${placeholders})`, ...ids);
      return jsonResult({ requested: ids.length, deleted: result.meta.changes ?? 0 });
    },
  );

  tool(
    'update_meal',
    'Fix a logged meal. Only the fields you pass change. Get ids from get_day.',
    {
      id: z.number().int().positive(),
      description: z.string().optional(),
      time: z.string().nullable().optional().describe("24-hour 'HH:MM'."),
      calories: z.number().int().nullable().optional(),
      protein_g: z.number().nullable().optional(),
      carbs_g: z.number().nullable().optional(),
      fat_g: z.number().nullable().optional(),
      source: z.enum(['estimate', 'manual']).optional(),
      notes: z.string().nullable().optional(),
      date: z.string().optional().describe('YYYY-MM-DD.'),
    },
    async ({ id, date, time, ...rest }) => {
      if (date !== undefined && !isIsoDate(date)) {
        throw new Error(`date must be a valid YYYY-MM-DD date (got "${date}")`);
      }
      if (time && !isHhMm(time)) throw new Error(`time must be 24-hour HH:MM (got "${time}")`);

      const patch = buildUpdate({ ...rest, time, date }, [
        'description',
        'time',
        'calories',
        'protein_g',
        'carbs_g',
        'fat_g',
        'source',
        'notes',
        'date',
      ]);
      if (!patch) throw new Error('provide at least one field to change');

      const result = await run(
        db,
        `UPDATE meals SET ${patch.clause} WHERE id = ?`,
        ...patch.binds,
        id,
      );
      if (!result.meta.changes) throw new Error(`no meal with id ${id}`);
      return jsonResult(await first<Row>(db, 'SELECT * FROM meals WHERE id = ?', id));
    },
  );

  tool(
    'delete_meal',
    'Delete one logged meal by id. Get ids from get_day.',
    { id: z.number().int().positive() },
    async ({ id }) => {
      const result = await run(db, 'DELETE FROM meals WHERE id = ?', id);
      if (!result.meta.changes) throw new Error(`no meal with id ${id}`);
      return jsonResult({ deleted_id: id });
    },
  );

  tool(
    'rename_exercise',
    `Merge or rename an exercise across all history — the cleanup tool for naming ` +
      `drift ("Bench" and "Barbell Bench Press" recorded as two exercises). Matching ` +
      `on the old name is case-insensitive. Returns how many set rows changed. ` +
      `Confirm with the person before merging two names that might be genuinely ` +
      `different movements.`,
    {
      from: z.string().min(1).describe('Existing name to replace (case-insensitive).'),
      to: z.string().min(1).describe('Canonical name to use instead.'),
    },
    async ({ from, to }) => {
      const result = await run(
        db,
        'UPDATE sets SET exercise = ? WHERE exercise = ? COLLATE NOCASE',
        to,
        from,
      );
      return jsonResult({ from, to, sets_updated: result.meta.changes ?? 0 });
    },
  );

  // ---------------------------------------------------------------------------
  // Retrieval / analysis
  // ---------------------------------------------------------------------------

  tool(
    'list_exercises',
    `Every exercise name on record, with set_count, last_used, and the best figure ` +
      `for each way of measuring: max_weight_lbs, max_duration_sec, max_distance_m. ` +
      `Whichever is null simply isn't how that movement is measured — a plank has a ` +
      `max_duration_sec and no max_weight_lbs. Call this before log_sets and reuse ` +
      `the names it returns; that is what keeps history queryable instead of ` +
      `fragmenting across spellings. Also useful for spotting drift worth cleaning ` +
      `up with rename_exercise.`,
    {},
    async () =>
      jsonResult(
        await all(
          db,
          `SELECT exercise,
                  COUNT(*)          AS set_count,
                  MAX(date)         AS last_used,
                  MAX(weight_lbs)   AS max_weight_lbs,
                  MAX(duration_sec) AS max_duration_sec,
                  MAX(distance_m)   AS max_distance_m
             FROM sets
            GROUP BY exercise COLLATE NOCASE
            ORDER BY last_used DESC, set_count DESC`,
        ),
      ),
  );

  tool(
    'get_history',
    `Raw set rows, newest first — the data to compute progression, volume, or PRs ` +
      `from. Filter by exercise (case-insensitive) and/or a date range. Do the ` +
      `analysis yourself from these rows; the server deliberately returns no ` +
      `aggregates beyond what list_exercises gives.`,
    {
      exercise: z.string().optional().describe('Case-insensitive exact name match.'),
      from: z.string().optional().describe('YYYY-MM-DD, inclusive.'),
      to: z.string().optional().describe('YYYY-MM-DD, inclusive.'),
      limit: z.number().int().positive().max(2000).optional().describe('Default 200.'),
    },
    async ({ exercise, from, to, limit }) => {
      checkRange(from, to);
      const where: string[] = [];
      const binds: unknown[] = [];
      if (exercise) {
        where.push('exercise = ? COLLATE NOCASE');
        binds.push(exercise);
      }
      if (from) {
        where.push('date >= ?');
        binds.push(from);
      }
      if (to) {
        where.push('date <= ?');
        binds.push(to);
      }
      const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const cap = limit ?? 200;
      const rows = await all(
        db,
        `SELECT * FROM sets${clause} ORDER BY date DESC, id DESC LIMIT ?`,
        ...binds,
        cap,
      );
      return jsonResult({ count: rows.length, limit: cap, sets: rows });
    },
  );

  tool(
    'get_day',
    `Everything recorded for one date: workouts with their sets nested, the ` +
      `weigh-in, meals, and progress-photo metadata. This is the tool for "what did ` +
      `I do on Tuesday" and for finding the id of a set or meal you need to correct. ` +
      `unattached_sets holds any sets whose workout row was deleted.`,
    { date: z.string().describe('YYYY-MM-DD.') },
    async ({ date }) => {
      if (!isIsoDate(date)) throw new Error(`date must be a valid YYYY-MM-DD date (got "${date}")`);

      const workouts = await all<Row & { id: number }>(
        db,
        'SELECT * FROM workouts WHERE date = ? ORDER BY id',
        date,
      );
      const sets = await all<Row & { workout_id: number | null }>(
        db,
        'SELECT * FROM sets WHERE date = ? ORDER BY id',
        date,
      );

      const byWorkout = new Map<number, Row[]>();
      const unattached: Row[] = [];
      for (const set of sets) {
        if (set.workout_id === null) {
          unattached.push(set);
          continue;
        }
        const bucket = byWorkout.get(set.workout_id);
        if (bucket) bucket.push(set);
        else byWorkout.set(set.workout_id, [set]);
      }

      return jsonResult({
        date,
        workouts: workouts.map((workout) => ({
          ...workout,
          sets: byWorkout.get(workout.id) ?? [],
        })),
        unattached_sets: unattached,
        weighin: await first<Row>(db, 'SELECT * FROM weighins WHERE date = ?', date),
        meals: await all(db, 'SELECT * FROM meals WHERE date = ? ORDER BY time, id', date),
        pics: await all(db, 'SELECT * FROM progress_pics WHERE date = ? ORDER BY id', date),
      });
    },
  );

  tool(
    'get_weight_trend',
    `Raw weigh-in rows over a date range, oldest first. Compute rolling averages, ` +
      `rate of change, and progress against the stated goal yourself from these rows.`,
    {
      from: z.string().optional().describe('YYYY-MM-DD, inclusive.'),
      to: z.string().optional().describe('YYYY-MM-DD, inclusive.'),
    },
    async ({ from, to }) => {
      checkRange(from, to);
      const where: string[] = [];
      const binds: unknown[] = [];
      if (from) {
        where.push('date >= ?');
        binds.push(from);
      }
      if (to) {
        where.push('date <= ?');
        binds.push(to);
      }
      const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const rows = await all(db, `SELECT * FROM weighins${clause} ORDER BY date ASC`, ...binds);
      return jsonResult({ count: rows.length, weighins: rows });
    },
  );

  tool(
    'query',
    `Read-only SQL escape hatch for questions the other tools don't cover — ` +
      `cross-table joins, custom groupings, window functions. Runs against this ` +
      `person's database only.\n\n` +
      `Rules: a single statement that starts with SELECT or WITH. No INSERT, ` +
      `UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, ATTACH, or REPLACE, and no ` +
      `multiple statements. At most ${QUERY_ROW_CAP} rows are returned.\n\n` +
      `Schema:\n${SCHEMA_DDL}`,
    { sql: z.string().min(1).describe('A single SELECT or WITH statement.') },
    async ({ sql }) => {
      const guard = guardReadOnlySql(sql);
      if (!guard.ok) throw new Error(guard.error);

      const rows = await all(db, guard.sql);
      const truncated = rows.length > QUERY_ROW_CAP;
      return jsonResult({
        row_count: Math.min(rows.length, QUERY_ROW_CAP),
        truncated,
        rows: truncated ? rows.slice(0, QUERY_ROW_CAP) : rows,
      });
    },
  );

  tool(
    'export_data',
    `Dump raw rows as JSON — all seven tables by default, or just the ones you ` +
      `name. from/to filter the tables that have a date column; profile and plans ` +
      `are always returned whole. Capped at ${EXPORT_ROW_CAP} rows total; past that ` +
      `it fails and points you at the HTTP export, which streams the full dataset.`,
    {
      tables: z
        .array(z.enum(ALL_TABLES))
        .optional()
        .describe(`Default: all of ${ALL_TABLES.join(', ')}.`),
      from: z.string().optional().describe('YYYY-MM-DD, inclusive.'),
      to: z.string().optional().describe('YYYY-MM-DD, inclusive.'),
    },
    async ({ tables, from, to }) => {
      checkRange(from, to);
      const wanted: TableName[] = tables?.length ? tables : [...ALL_TABLES];

      const dump: Record<string, Row[]> = {};
      let total = 0;
      for (const table of wanted) {
        if (!isTableName(table)) throw new Error(`unknown table "${table}"`);
        const rows = await readTable(db, table, from, to);
        total += rows.length;
        if (total > EXPORT_ROW_CAP) {
          throw new Error(
            `export exceeds the ${EXPORT_ROW_CAP}-row tool limit (${total}+ rows). ` +
              `Use the HTTP export instead: GET ${ctx.origin}/export.json — it streams ` +
              `the full dataset with no cap.`,
          );
        }
        dump[table] = rows;
      }
      return jsonResult({ user: ctx.displayName, row_count: total, tables: dump });
    },
  );

  // ---------------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------------

  tool(
    'list_progress_pics',
    `Progress-photo metadata (id, date, pose, weight, notes) — not the images ` +
      `themselves. Use it to find which photos exist, then get_progress_pic to see ` +
      `one. Filter by date range and/or pose.`,
    {
      from: z.string().optional().describe('YYYY-MM-DD, inclusive.'),
      to: z.string().optional().describe('YYYY-MM-DD, inclusive.'),
      pose: z.string().optional().describe("Case-insensitive: 'front', 'side', 'back', freeform."),
    },
    async ({ from, to, pose }) => {
      checkRange(from, to);
      const where: string[] = [];
      const binds: unknown[] = [];
      if (from) {
        where.push('date >= ?');
        binds.push(from);
      }
      if (to) {
        where.push('date <= ?');
        binds.push(to);
      }
      if (pose) {
        where.push('pose = ? COLLATE NOCASE');
        binds.push(pose);
      }
      const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const rows = await all(
        db,
        `SELECT id, date, pose, weight_lbs, content_type, notes, created_at
           FROM progress_pics${clause} ORDER BY date DESC, id DESC`,
        ...binds,
      );
      return jsonResult({ count: rows.length, pics: rows });
    },
  );

  tool(
    'get_progress_pic',
    `Fetch one progress photo as an image, for visual comparison. Address it ` +
      `either by id (from list_progress_pics) or by date plus optional pose. ` +
      `Returns the image itself plus its metadata and a temporary link that ` +
      `expires in about an hour — hand the person that link if the image does not ` +
      `render in your client. To compare two dates, call this twice.`,
    {
      id: z.number().int().positive().optional().describe('From list_progress_pics.'),
      date: z.string().optional().describe('YYYY-MM-DD. Used when id is omitted.'),
      pose: z.string().optional().describe("Narrows a date match: 'front', 'side', 'back'."),
    },
    async ({ id, date, pose }) => {
      if (id === undefined && date === undefined) throw new Error('provide either id or date');
      if (date !== undefined && !isIsoDate(date)) {
        throw new Error(`date must be a valid YYYY-MM-DD date (got "${date}")`);
      }

      let pic: (Row & { id: number; r2_key: string; content_type: string }) | null;
      if (id !== undefined) {
        pic = await first(db, 'SELECT * FROM progress_pics WHERE id = ?', id);
      } else if (pose) {
        pic = await first(
          db,
          'SELECT * FROM progress_pics WHERE date = ? AND pose = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1',
          date,
          pose,
        );
      } else {
        pic = await first(
          db,
          'SELECT * FROM progress_pics WHERE date = ? ORDER BY id DESC LIMIT 1',
          date,
        );
      }
      if (!pic) throw new Error('no matching progress photo');

      // r2_key came from this user's database, and the prefix is re-checked here
      // so a corrupted row still cannot read across the bucket.
      if (!pic.r2_key.startsWith(ctx.picsPrefix)) {
        throw new Error('stored photo key does not belong to this user');
      }

      const object = await env.PICS.get(pic.r2_key);
      if (!object) throw new Error(`photo object missing from storage (${pic.r2_key})`);

      const { r2_key: _r2Key, ...metadata } = pic;
      const link = await signPicUrl(env, ctx.origin, ctx.userId, pic.id, 3600);

      // Don't inline a large photo: base64 would bloat the response (see
      // MAX_INLINE_PIC_BYTES). Checked against object.size before reading the
      // body, so an oversized image is never even loaded into memory.
      if (object.size > MAX_INLINE_PIC_BYTES) {
        throw new Error(
          `photo is ${object.size} bytes, over the ${MAX_INLINE_PIC_BYTES}-byte (~3 MB) ` +
            `inline limit. Open it at this link, valid about an hour: ${link}`,
        );
      }

      return {
        content: [
          { type: 'image', data: toBase64(await object.arrayBuffer()), mimeType: pic.content_type },
          {
            type: 'text',
            text: JSON.stringify({ ...metadata, expiring_url: link }, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
