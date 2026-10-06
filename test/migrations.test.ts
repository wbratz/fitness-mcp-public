import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ALL_TABLES } from '../src/db.js';

describe('migrations (acceptance criterion 11)', () => {
  it('creates all seven tables in both databases', async () => {
    for (const db of [env.DB_USER1, env.DB_USER2]) {
      const result = await db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all<{ name: string }>();
      const names = (result.results ?? []).map((row) => row.name);
      for (const table of ALL_TABLES) {
        expect(names, `${table} should exist`).toContain(table);
      }
    }
  });

  it('seeds exactly one profile row per database', async () => {
    for (const db of [env.DB_USER1, env.DB_USER2]) {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM profile').first<{ n: number }>();
      expect(row?.n).toBe(1);
    }
  });

  it('is idempotent: re-applying changes nothing', async () => {
    // Put a row in place so we can prove re-running does not reset data.
    await env.DB_USER1.prepare(
      "INSERT INTO weighins (date, weight_lbs) VALUES ('2026-01-01', 199.9)",
    ).run();

    // The same operation scripts/migrate.sh performs, run a second time.
    await applyD1Migrations(env.DB_USER1, env.TEST_MIGRATIONS);
    await applyD1Migrations(env.DB_USER2, env.TEST_MIGRATIONS);

    const weighins = await env.DB_USER1.prepare(
      'SELECT COUNT(*) AS n FROM weighins',
    ).first<{ n: number }>();
    expect(weighins?.n).toBe(1);

    const profile = await env.DB_USER1.prepare(
      'SELECT COUNT(*) AS n FROM profile',
    ).first<{ n: number }>();
    expect(profile?.n).toBe(1);
  });

  it('enforces the profile singleton and the one-weighin-per-date rule', async () => {
    await expect(
      env.DB_USER1.prepare('INSERT INTO profile (id) VALUES (2)').run(),
    ).rejects.toThrow();

    await env.DB_USER1.prepare(
      "INSERT INTO weighins (date, weight_lbs) VALUES ('2026-02-02', 200)",
    ).run();
    await expect(
      env.DB_USER1.prepare(
        "INSERT INTO weighins (date, weight_lbs) VALUES ('2026-02-02', 201)",
      ).run(),
    ).rejects.toThrow();
  });
});
