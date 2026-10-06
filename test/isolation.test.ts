import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { USER2_TOKEN, BASE, callOk, callTool, USER1_TOKEN, rpc, uploadPhoto } from './helpers.js';

/** Seed distinct, easily-identified data into both databases. */
async function seedBoth() {
  await callOk(USER1_TOKEN, 'log_weighin', { date: '2026-06-01', weight_lbs: 208.5 });
  await callOk(USER1_TOKEN, 'log_sets', {
    date: '2026-06-01',
    workout_label: 'Push',
    sets: [{ exercise: 'Barbell Bench Press', reps: 8, weight_lbs: 185 }],
  });
  await callOk(USER1_TOKEN, 'log_meal', { date: '2026-06-01', description: 'USER1 STEAK' });
  await callOk(USER1_TOKEN, 'update_profile', { goal: 'USER1 GOAL' });
  await callOk(USER1_TOKEN, 'save_plan', { name: 'USER1 PLAN', content: 'user1 only' });

  await callOk(USER2_TOKEN, 'log_weighin', { date: '2026-06-01', weight_lbs: 141.2 });
  await callOk(USER2_TOKEN, 'log_sets', {
    date: '2026-06-01',
    workout_label: 'Full Body',
    sets: [{ exercise: 'Goblet Squat', reps: 12, weight_lbs: 40 }],
  });
  await callOk(USER2_TOKEN, 'log_meal', { date: '2026-06-01', description: 'USER2 SALAD' });
  await callOk(USER2_TOKEN, 'update_profile', { goal: 'USER2 GOAL' });
  await callOk(USER2_TOKEN, 'save_plan', { name: 'USER2 PLAN', content: 'user2 only' });
}

describe('cross-user isolation (acceptance criterion 5)', () => {
  it('the raw query tool cannot reach the other database', async () => {
    await seedBoth();

    const kingWeighins = await callOk(USER1_TOKEN, 'query', { sql: 'SELECT * FROM weighins' });
    expect(kingWeighins.row_count).toBe(1);
    expect(kingWeighins.rows[0].weight_lbs).toBe(208.5);

    const annaWeighins = await callOk(USER2_TOKEN, 'query', { sql: 'SELECT * FROM weighins' });
    expect(annaWeighins.row_count).toBe(1);
    expect(annaWeighins.rows[0].weight_lbs).toBe(141.2);

    const kingMeals = await callOk(USER1_TOKEN, 'query', {
      sql: 'SELECT description FROM meals',
    });
    expect(JSON.stringify(kingMeals.rows)).toContain('USER1 STEAK');
    expect(JSON.stringify(kingMeals.rows)).not.toContain('USER2 SALAD');

    const kingPlans = await callOk(USER1_TOKEN, 'query', { sql: 'SELECT name FROM plans' });
    expect(JSON.stringify(kingPlans.rows)).not.toContain('USER2 PLAN');
  });

  it('export_data and /export.json return only the authenticated user', async () => {
    await seedBoth();

    const kingDump = await callOk(USER1_TOKEN, 'export_data');
    const kingText = JSON.stringify(kingDump);
    expect(kingDump.user).toBe('User One');
    expect(kingText).toContain('USER1 STEAK');
    expect(kingText).not.toContain('USER2 SALAD');
    expect(kingText).not.toContain('USER2 GOAL');

    const response = await SELF.fetch(`${BASE}/export.json`, {
      headers: { authorization: `Bearer ${USER2_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const annaText = await response.text();
    expect(annaText).toContain('USER2 SALAD');
    expect(annaText).not.toContain('USER1 STEAK');
    expect(annaText).not.toContain('USER1 PLAN');
  });

  it('export.csv is scoped per user', async () => {
    await seedBoth();

    const kingCsv = await (
      await SELF.fetch(`${BASE}/export.csv?table=meals`, {
        headers: { authorization: `Bearer ${USER1_TOKEN}` },
      })
    ).text();
    expect(kingCsv).toContain('USER1 STEAK');
    expect(kingCsv).not.toContain('USER2 SALAD');
    // Header comes from the static column list, so it is present regardless.
    expect(kingCsv.split('\r\n')[0]).toBe(
      'id,date,time,description,calories,protein_g,carbs_g,fat_g,source,notes,created_at',
    );
  });

  it('photos cannot be listed, read, or streamed across users', async () => {
    const annaUpload = await uploadPhoto(USER2_TOKEN, { date: '2026-06-02', pose: 'front' });
    expect(annaUpload.status).toBe(201);
    const annaPicId: number = annaUpload.body.pic.id;
    expect(annaUpload.body.r2_key.startsWith('user2/pics/')).toBe(true);

    // User One has no photos at all.
    const kingList = await callOk(USER1_TOKEN, 'list_progress_pics');
    expect(kingList.count).toBe(0);

    // User Two's id is not resolvable in User One's database.
    const kingFetch = await callTool(USER1_TOKEN, 'get_progress_pic', { id: annaPicId });
    expect(kingFetch.isError).toBe(true);

    // Nor over HTTP with User One's token.
    const streamed = await SELF.fetch(`${BASE}/pic/${annaPicId}`, {
      headers: { authorization: `Bearer ${USER1_TOKEN}` },
    });
    expect(streamed.status).toBe(404);

    // User Two can read her own.
    const annaFetch = await callTool(USER2_TOKEN, 'get_progress_pic', { id: annaPicId });
    expect(annaFetch.isError).toBe(false);
  });

  it('get_day is scoped per user for the same calendar date', async () => {
    await seedBoth();

    const kingDay = await callOk(USER1_TOKEN, 'get_day', { date: '2026-06-01' });
    const annaDay = await callOk(USER2_TOKEN, 'get_day', { date: '2026-06-01' });

    expect(kingDay.workouts[0].label).toBe('Push');
    expect(kingDay.weighin.weight_lbs).toBe(208.5);
    expect(annaDay.workouts[0].label).toBe('Full Body');
    expect(annaDay.weighin.weight_lbs).toBe(141.2);
  });
});

describe('authentication (acceptance criterion 10)', () => {
  const protectedRoutes = [
    '/export.json',
    '/export.csv?table=sets',
    '/pic/1',
  ];

  it('rejects a missing token on /mcp', async () => {
    const { status } = await rpc(null, 'tools/list', {});
    expect(status).toBe(401);
  });

  it('rejects an unknown token on /mcp', async () => {
    const { status } = await rpc('not-a-real-token', 'tools/list', {});
    expect(status).toBe(401);
  });

  it('rejects an unknown path token on /mcp/:token', async () => {
    const { status } = await rpc(null, 'tools/list', {}, { path: '/mcp/wrong-token' });
    expect(status).toBe(401);
  });

  it('rejects missing and unknown tokens on every GET route', async () => {
    for (const route of protectedRoutes) {
      const none = await SELF.fetch(`${BASE}${route}`);
      expect(none.status, `${route} with no token`).toBe(401);

      const bad = await SELF.fetch(`${BASE}${route}`, {
        headers: { authorization: 'Bearer nope' },
      });
      expect(bad.status, `${route} with a bad token`).toBe(401);
    }
  });

  it('rejects missing and unknown tokens on /upload', async () => {
    const none = await SELF.fetch(`${BASE}/upload`, { method: 'POST' });
    expect(none.status).toBe(401);

    const bad = await uploadPhoto('nope');
    expect(bad.status).toBe(401);
  });

  it('accepts the ?key= query fallback', async () => {
    const response = await SELF.fetch(`${BASE}/export.json?key=${USER1_TOKEN}`);
    expect(response.status).toBe(200);
  });

  it('returns 404 for an unknown path rather than leaking a route list', async () => {
    const response = await SELF.fetch(`${BASE}/`, {
      headers: { authorization: `Bearer ${USER1_TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});
