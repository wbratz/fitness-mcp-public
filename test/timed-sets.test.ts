import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { USER2_TOKEN, callOk, callTool } from './helpers.js';

describe('time- and distance-measured sets', () => {
  it('logs planks as duration with no rep count', async () => {
    // "planks, 3 sets of a minute"
    const logged = await callOk(USER2_TOKEN, 'log_sets', {
      date: '2026-09-01',
      workout_label: 'Core',
      sets: [
        { exercise: 'Plank', duration_sec: 60 },
        { exercise: 'Plank', duration_sec: 60 },
        { exercise: 'Plank', duration_sec: 45 },
      ],
    });
    expect(logged.set_ids).toHaveLength(3);

    const day = await callOk(USER2_TOKEN, 'get_day', { date: '2026-09-01' });
    const sets = day.workouts[0].sets;
    expect(sets).toHaveLength(3);
    expect(sets[0].duration_sec).toBe(60);
    // The point of the change: no invented rep count, no duration in notes.
    expect(sets[0].reps).toBeNull();
    expect(sets[0].weight_lbs).toBeNull();
    expect(sets[0].notes).toBeNull();
    expect(sets[2].duration_sec).toBe(45);
  });

  it('logs a loaded carry with distance and weight together', async () => {
    // "farmer's walks, 4 rounds of 40 yards with the 50s"
    const yards40 = 36.58;
    await callOk(USER2_TOKEN, 'log_sets', {
      date: '2026-09-02',
      sets: Array.from({ length: 4 }, () => ({
        exercise: "Farmer's Walk",
        distance_m: yards40,
        weight_lbs: 50,
        notes: 'per hand',
      })),
    });

    const history = await callOk(USER2_TOKEN, 'get_history', { exercise: "farmer's walk" });
    expect(history.count).toBe(4);
    expect(history.sets[0].distance_m).toBeCloseTo(yards40, 2);
    expect(history.sets[0].weight_lbs).toBe(50);
    expect(history.sets[0].reps).toBeNull();
    expect(history.sets[0].duration_sec).toBeNull();
  });

  it('allows a set measured in all three ways at once', async () => {
    // Weighted carries are sometimes prescribed as "10 steps, 30 seconds, 20m".
    await callOk(USER2_TOKEN, 'log_sets', {
      date: '2026-09-03',
      sets: [{ exercise: 'Sled Push', reps: 10, duration_sec: 30, distance_m: 20, weight_lbs: 90 }],
    });
    const history = await callOk(USER2_TOKEN, 'get_history', { exercise: 'Sled Push' });
    expect(history.sets[0].reps).toBe(10);
    expect(history.sets[0].duration_sec).toBe(30);
    expect(history.sets[0].distance_m).toBe(20);
  });

  it('rejects a set that measures nothing at all', async () => {
    const outcome = await callTool(USER2_TOKEN, 'log_sets', {
      date: '2026-09-04',
      sets: [{ exercise: 'Mystery Movement' }],
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('Mystery Movement');
    expect(outcome.text).toContain('duration_sec');

    // Nothing was written — the whole call failed before inserting.
    const day = await callOk(USER2_TOKEN, 'get_day', { date: '2026-09-04' });
    expect(day.workouts).toHaveLength(0);
  });

  it('names the offending index when one set in a batch measures nothing', async () => {
    const outcome = await callTool(USER2_TOKEN, 'log_sets', {
      date: '2026-09-05',
      sets: [
        { exercise: 'Plank', duration_sec: 60 },
        { exercise: 'Dead Hang' },
      ],
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('sets[1]');
    expect(outcome.text).toContain('Dead Hang');
  });

  it('still requires nothing beyond reps for ordinary rep work', async () => {
    const logged = await callOk(USER2_TOKEN, 'log_sets', {
      date: '2026-09-06',
      sets: [{ exercise: 'Goblet Squat', reps: 12, weight_lbs: 40 }],
    });
    expect(logged.set_ids).toHaveLength(1);
    const history = await callOk(USER2_TOKEN, 'get_history', { exercise: 'Goblet Squat' });
    expect(history.sets[0].reps).toBe(12);
    expect(history.sets[0].duration_sec).toBeNull();
    expect(history.sets[0].distance_m).toBeNull();
  });

  it('update_set converts a rep set into a timed one', async () => {
    // Logged as reps by mistake: "3x30 plank" read as 30 reps.
    const logged = await callOk(USER2_TOKEN, 'log_sets', {
      date: '2026-09-07',
      sets: [{ exercise: 'Plank', reps: 30 }],
    });
    const id = (logged.set_ids as number[])[0];

    const fixed = await callOk(USER2_TOKEN, 'update_set', {
      id,
      reps: null,
      duration_sec: 30,
    });
    expect(fixed.reps).toBeNull();
    expect(fixed.duration_sec).toBe(30);
  });

  it('list_exercises surfaces the best figure for each measurement type', async () => {
    await callOk(USER2_TOKEN, 'log_sets', {
      date: '2026-09-08',
      sets: [
        { exercise: 'Plank', duration_sec: 60 },
        { exercise: 'Plank', duration_sec: 95 },
        { exercise: "Farmer's Walk", distance_m: 36.58, weight_lbs: 50 },
        { exercise: 'Goblet Squat', reps: 12, weight_lbs: 40 },
      ],
    });

    const rows = await callOk(USER2_TOKEN, 'list_exercises');
    const plank = rows.find((r: any) => r.exercise === 'Plank');
    const carry = rows.find((r: any) => r.exercise === "Farmer's Walk");
    const squat = rows.find((r: any) => r.exercise === 'Goblet Squat');

    // Progression for a hold is its longest hold, not a weight.
    expect(plank.max_duration_sec).toBe(95);
    expect(plank.max_weight_lbs).toBeNull();

    expect(carry.max_distance_m).toBeCloseTo(36.58, 2);
    expect(carry.max_weight_lbs).toBe(50);

    expect(squat.max_weight_lbs).toBe(40);
    expect(squat.max_duration_sec).toBeNull();
  });

  it('the raw query tool can rank holds by duration', async () => {
    await callOk(USER2_TOKEN, 'log_sets', {
      date: '2026-09-09',
      sets: [
        { exercise: 'Plank', duration_sec: 70 },
        { exercise: 'Plank', duration_sec: 120 },
        { exercise: 'Side Plank', duration_sec: 45, notes: 'left' },
      ],
    });

    const result = await callOk(USER2_TOKEN, 'query', {
      sql: `SELECT exercise, MAX(duration_sec) AS best
              FROM sets WHERE duration_sec IS NOT NULL
             GROUP BY exercise ORDER BY best DESC`,
    });
    expect(result.rows[0]).toEqual({ exercise: 'Plank', best: 120 });
    expect(result.rows[1]).toEqual({ exercise: 'Side Plank', best: 45 });
  });

  it('migration 0002 added both columns to both databases', async () => {
    for (const db of [env.DB_USER1, env.DB_USER2]) {
      const result = await db.prepare('SELECT * FROM pragma_table_info($1)').bind('sets').all<{
        name: string;
      }>();
      const columns = (result.results ?? []).map((row) => row.name);
      expect(columns).toContain('duration_sec');
      expect(columns).toContain('distance_m');
    }
  });

  it('CSV export includes the new columns in its header', async () => {
    const { SELF } = await import('cloudflare:test');
    const csv = await (
      await SELF.fetch('https://fitness.test/export.csv?table=sets', {
        headers: { authorization: `Bearer ${USER2_TOKEN}` },
      })
    ).text();
    const header = csv.split('\r\n')[0]!;
    expect(header).toBe(
      'id,workout_id,date,exercise,set_number,weight_lbs,reps,rpe,is_warmup,notes,created_at,duration_sec,distance_m',
    );
  });
});
