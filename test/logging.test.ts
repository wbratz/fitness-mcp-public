import { describe, expect, it } from 'vitest';
import { callOk, callTool, USER1_TOKEN } from './helpers.js';

describe('logging (acceptance criteria 1-3)', () => {
  it('AC1: a later set logged for the same day attaches to the same workout', async () => {
    // "bench 3x8 @185"
    const bench = await callOk(USER1_TOKEN, 'log_sets', {
      sets: [
        { exercise: 'Barbell Bench Press', reps: 8, weight_lbs: 185 },
        { exercise: 'Barbell Bench Press', reps: 8, weight_lbs: 185 },
        { exercise: 'Barbell Bench Press', reps: 8, weight_lbs: 185 },
      ],
    });

    expect(bench.workout_created).toBe(true);
    expect(bench.set_ids).toHaveLength(3);

    // "also did curls 3x12 @35"
    const curls = await callOk(USER1_TOKEN, 'log_sets', {
      sets: [
        { exercise: 'Dumbbell Curl', reps: 12, weight_lbs: 35 },
        { exercise: 'Dumbbell Curl', reps: 12, weight_lbs: 35 },
        { exercise: 'Dumbbell Curl', reps: 12, weight_lbs: 35 },
      ],
    });

    expect(curls.workout_created).toBe(false);
    expect(curls.workout_id).toBe(bench.workout_id);

    const day = await callOk(USER1_TOKEN, 'get_day', { date: bench.date });
    expect(day.workouts).toHaveLength(1);
    expect(day.workouts[0].sets).toHaveLength(6);
  });

  it('AC1b: a different label on the same day starts a separate workout', async () => {
    const push = await callOk(USER1_TOKEN, 'log_sets', {
      workout_label: 'Push',
      sets: [{ exercise: 'Overhead Press', reps: 5, weight_lbs: 115 }],
    });
    const pull = await callOk(USER1_TOKEN, 'log_sets', {
      workout_label: 'Pull',
      sets: [{ exercise: 'Barbell Row', reps: 8, weight_lbs: 155 }],
    });

    expect(pull.workout_created).toBe(true);
    expect(pull.workout_id).not.toBe(push.workout_id);

    // Case-insensitive: "push" is the same session as "Push".
    const again = await callOk(USER1_TOKEN, 'log_sets', {
      workout_label: 'push',
      sets: [{ exercise: 'Lateral Raise', reps: 15, weight_lbs: 25 }],
    });
    expect(again.workout_id).toBe(push.workout_id);
  });

  it('AC2: a set logged for a past date lands on that date', async () => {
    const past = '2026-03-02';
    const logged = await callOk(USER1_TOKEN, 'log_sets', {
      date: past,
      workout_label: 'Pull',
      sets: [{ exercise: 'Pull-Up', reps: 12 }],
    });
    expect(logged.date).toBe(past);

    const day = await callOk(USER1_TOKEN, 'get_day', { date: past });
    expect(day.workouts).toHaveLength(1);
    expect(day.workouts[0].label).toBe('Pull');
    expect(day.workouts[0].sets[0].exercise).toBe('Pull-Up');
    // Bodyweight: no weight recorded.
    expect(day.workouts[0].sets[0].weight_lbs).toBeNull();

    // And it is not visible on some other day.
    const other = await callOk(USER1_TOKEN, 'get_day', { date: '2026-03-03' });
    expect(other.workouts).toHaveLength(0);
  });

  it('AC3: logging a weigh-in twice for one date leaves exactly one row', async () => {
    const date = '2026-03-04';
    await callOk(USER1_TOKEN, 'log_weighin', { date, weight_lbs: 212.8 });
    const second = await callOk(USER1_TOKEN, 'log_weighin', { date, weight_lbs: 211.4 });

    expect(second.weight_lbs).toBe(211.4);

    const trend = await callOk(USER1_TOKEN, 'get_weight_trend', { from: date, to: date });
    expect(trend.count).toBe(1);
    expect(trend.weighins[0].weight_lbs).toBe(211.4);
  });

  it('log_workout_meta records a session with no sets, and can enrich an existing one', async () => {
    const date = '2026-03-05';
    const bjj = await callOk(USER1_TOKEN, 'log_workout_meta', {
      date,
      label: 'BJJ',
      duration_min: 90,
      notes: 'hard rounds',
    });
    expect(bjj.workout_created).toBe(true);
    expect(bjj.workout.duration_min).toBe(90);

    // Same date + label -> updates rather than duplicating.
    const enriched = await callOk(USER1_TOKEN, 'log_workout_meta', {
      date,
      label: 'BJJ',
      duration_min: 105,
    });
    expect(enriched.workout_created).toBe(false);
    expect(enriched.workout.id).toBe(bjj.workout.id);
    expect(enriched.workout.duration_min).toBe(105);
    expect(enriched.workout.notes).toBe('hard rounds');
  });

  it('corrections: update_set, delete_sets, and rename_exercise', async () => {
    const logged = await callOk(USER1_TOKEN, 'log_sets', {
      date: '2026-03-06',
      sets: [
        { exercise: 'Incline Dumbbell Press', reps: 10, weight_lbs: 70 },
        { exercise: 'Incline Dumbbell Press', reps: 10, weight_lbs: 70 },
      ],
    });
    const [firstId, secondId] = logged.set_ids as number[];

    // "that last incline set was actually 9 reps"
    const updated = await callOk(USER1_TOKEN, 'update_set', { id: secondId, reps: 9 });
    expect(updated.reps).toBe(9);
    expect(updated.weight_lbs).toBe(70);

    // Naming drift cleanup.
    const renamed = await callOk(USER1_TOKEN, 'rename_exercise', {
      from: 'incline dumbbell press',
      to: 'Incline DB Press',
    });
    expect(renamed.sets_updated).toBe(2);

    const deleted = await callOk(USER1_TOKEN, 'delete_sets', { ids: [firstId] });
    expect(deleted.deleted).toBe(1);

    const history = await callOk(USER1_TOKEN, 'get_history', { exercise: 'Incline DB Press' });
    expect(history.count).toBe(1);
    expect(history.sets[0].id).toBe(secondId);
  });

  it('meals round-trip through log, update, and delete', async () => {
    const date = '2026-03-07';
    const meal = await callOk(USER1_TOKEN, 'log_meal', {
      date,
      time: '12:30',
      description: 'chicken burrito bowl, double chicken',
      calories: 780,
      protein_g: 62,
    });
    expect(meal.source).toBe('estimate');

    const fixed = await callOk(USER1_TOKEN, 'update_meal', {
      id: meal.id,
      calories: 820,
      source: 'manual',
    });
    expect(fixed.calories).toBe(820);
    expect(fixed.source).toBe('manual');

    const day = await callOk(USER1_TOKEN, 'get_day', { date });
    expect(day.meals).toHaveLength(1);

    await callOk(USER1_TOKEN, 'delete_meal', { id: meal.id });
    const after = await callOk(USER1_TOKEN, 'get_day', { date });
    expect(after.meals).toHaveLength(0);
  });

  it('rejects a calendar-invalid date rather than silently storing it', async () => {
    const outcome = await callTool(USER1_TOKEN, 'log_weighin', {
      date: '2026-02-30',
      weight_lbs: 200,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('2026-02-30');
  });

  it('list_exercises summarizes names for reuse before logging', async () => {
    await callOk(USER1_TOKEN, 'log_sets', {
      date: '2026-03-08',
      sets: [
        { exercise: 'Back Squat', reps: 5, weight_lbs: 275 },
        { exercise: 'Back Squat', reps: 5, weight_lbs: 285 },
      ],
    });

    const exercises = await callOk(USER1_TOKEN, 'list_exercises');
    const squat = exercises.find((row: any) => row.exercise === 'Back Squat');
    expect(squat.set_count).toBe(2);
    expect(squat.max_weight_lbs).toBe(285);
    expect(squat.last_used).toBe('2026-03-08');
  });
});
