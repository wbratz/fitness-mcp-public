import { describe, expect, it } from 'vitest';
import { USER2_TOKEN, callOk, USER1_TOKEN } from './helpers.js';

describe('profile and plans (acceptance criteria 6, 8)', () => {
  it('AC6: whoami returns the right name and goal per connector', async () => {
    await callOk(USER1_TOKEN, 'update_profile', { goal: 'cut to 200 lbs, keep bench at 3 plates' });
    await callOk(USER2_TOKEN, 'update_profile', { goal: 'tone up and drop 10 lbs by spring' });

    const user1 = await callOk(USER1_TOKEN, 'whoami');
    const user2 = await callOk(USER2_TOKEN, 'whoami');

    expect(user1.name).toBe('User One');
    expect(user1.goal).toBe('cut to 200 lbs, keep bench at 3 plates');

    expect(user2.name).toBe('User Two');
    expect(user2.goal).toBe('tone up and drop 10 lbs by spring');

    // Each connector sees only its own goal.
    expect(user1.goal).not.toBe(user2.goal);
  });

  it('whoami surfaces the latest weigh-in, workout date, and active plan', async () => {
    await callOk(USER1_TOKEN, 'log_weighin', { date: '2026-05-01', weight_lbs: 208.2 });
    await callOk(USER1_TOKEN, 'log_workout_meta', { date: '2026-05-02', label: 'Legs' });
    await callOk(USER1_TOKEN, 'save_plan', { name: '3-day full body', content: '# Plan\nA/B/C' });

    const user1 = await callOk(USER1_TOKEN, 'whoami');
    expect(user1.last_weighin.weight_lbs).toBe(208.2);
    expect(user1.last_workout_date).toBe('2026-05-02');
    expect(user1.active_plan_name).toBe('3-day full body');
    expect(user1.server_timezone).toBe('America/New_York');
  });

  it('AC8: save_plan with make_active deactivates prior plans', async () => {
    const first = await callOk(USER1_TOKEN, 'save_plan', {
      name: 'PPL + Shoulders/Arms',
      content: '# PPL\nPush / Pull / Legs',
    });
    expect(first.is_active).toBe(1);

    const second = await callOk(USER1_TOKEN, 'save_plan', {
      name: 'Upper/Lower 4x',
      content: '# U/L\nUpper A, Lower A, Upper B, Lower B',
      make_active: true,
    });

    const active = await callOk(USER1_TOKEN, 'get_active_plan');
    expect(active.id).toBe(second.id);
    expect(active.name).toBe('Upper/Lower 4x');
    expect(active.content).toContain('Upper A');

    // History is retained, and exactly one plan is active.
    const plans = await callOk(USER1_TOKEN, 'list_plans');
    expect(plans).toHaveLength(2);
    expect(plans.filter((plan: any) => plan.is_active === 1)).toHaveLength(1);

    // The old plan is still retrievable in full.
    const old = await callOk(USER1_TOKEN, 'get_plan', { id: first.id });
    expect(old.content).toContain('Push / Pull / Legs');
    expect(old.is_active).toBe(0);
  });

  it('save_plan with make_active false leaves the current plan active', async () => {
    const active = await callOk(USER1_TOKEN, 'save_plan', { name: 'Current', content: 'now' });
    await callOk(USER1_TOKEN, 'save_plan', {
      name: 'Someday',
      content: 'later',
      make_active: false,
    });

    const current = await callOk(USER1_TOKEN, 'get_active_plan');
    expect(current.id).toBe(active.id);
  });

  it('get_active_plan returns null before any plan is saved', async () => {
    expect(await callOk(USER2_TOKEN, 'get_active_plan')).toBeNull();
  });

  it('update_profile accepts stats as an object or a JSON string, and is partial', async () => {
    await callOk(USER1_TOKEN, 'update_profile', { goal: 'recomp' });
    await callOk(USER1_TOKEN, 'update_profile', { stats_json: { height_in: 72, age: 34 } });

    const profile = await callOk(USER1_TOKEN, 'get_profile');
    // Setting stats did not wipe the goal.
    expect(profile.goal).toBe('recomp');
    expect(JSON.parse(profile.stats_json)).toEqual({ height_in: 72, age: 34 });

    await callOk(USER1_TOKEN, 'update_profile', { stats_json: '{"height_in":72,"age":35}' });
    const updated = await callOk(USER1_TOKEN, 'get_profile');
    expect(JSON.parse(updated.stats_json).age).toBe(35);
  });
});
