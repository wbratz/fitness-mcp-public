import { describe, expect, it } from 'vitest';
import { guardReadOnlySql } from '../src/sql-guard.js';
import { callOk, callTool, USER1_TOKEN } from './helpers.js';

describe('read-only SQL guard (acceptance criterion 4)', () => {
  it('accepts a plain SELECT', () => {
    expect(guardReadOnlySql('SELECT * FROM sets').ok).toBe(true);
  });

  it('accepts a WITH ... SELECT common table expression', () => {
    const result = guardReadOnlySql(`
      WITH weekly AS (SELECT date, SUM(reps * weight_lbs) AS volume FROM sets GROUP BY date)
      SELECT * FROM weekly ORDER BY date DESC
    `);
    expect(result.ok).toBe(true);
  });

  it('accepts a leading comment before the SELECT', () => {
    expect(guardReadOnlySql('-- volume by day\nSELECT date FROM sets').ok).toBe(true);
    expect(guardReadOnlySql('/* note */ SELECT date FROM sets').ok).toBe(true);
  });

  it('accepts a single trailing semicolon', () => {
    expect(guardReadOnlySql('SELECT 1;').ok).toBe(true);
    expect(guardReadOnlySql('SELECT 1;  \n ').ok).toBe(true);
  });

  it('rejects a write statement', () => {
    for (const sql of [
      'UPDATE sets SET reps=99',
      'DELETE FROM sets',
      'INSERT INTO sets (exercise) VALUES ("x")',
      'DROP TABLE sets',
      'ALTER TABLE sets ADD COLUMN x TEXT',
      'CREATE TABLE evil (id INTEGER)',
      'PRAGMA table_list',
      "ATTACH DATABASE 'other.db' AS other",
      'REPLACE INTO weighins (date, weight_lbs) VALUES ("2026-01-01", 1)',
    ]) {
      const result = guardReadOnlySql(sql);
      expect(result.ok, `expected rejection: ${sql}`).toBe(false);
    }
  });

  it('rejects a write hidden behind a comment or a leading SELECT', () => {
    expect(guardReadOnlySql('-- SELECT\nUPDATE sets SET reps = 99').ok).toBe(false);
    expect(guardReadOnlySql('SELECT 1; UPDATE sets SET reps = 99').ok).toBe(false);
    expect(guardReadOnlySql('SELECT 1;DROP TABLE sets;').ok).toBe(false);
  });

  it('rejects a data-modifying CTE, which does start with WITH', () => {
    // This is the case the keyword check exists for: the statement passes the
    // leading-keyword test, so only the word-token scan catches it.
    const result = guardReadOnlySql(
      'WITH x AS (UPDATE sets SET reps = 1 RETURNING id) SELECT * FROM x',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('UPDATE');

    expect(
      guardReadOnlySql('WITH x AS (DELETE FROM sets RETURNING id) SELECT * FROM x').ok,
    ).toBe(false);
  });

  it('rejects multiple statements even when both are reads', () => {
    const result = guardReadOnlySql('SELECT 1; SELECT 2');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('multiple statements');
  });

  it('does not confuse a keyword inside a string literal for a real one', () => {
    // 'drop' here is data, not a statement — this must be allowed.
    expect(guardReadOnlySql("SELECT * FROM sets WHERE notes = 'drop'").ok).toBe(true);
    expect(guardReadOnlySql("SELECT * FROM sets WHERE notes LIKE '%; delete from x%'").ok).toBe(
      true,
    );
    expect(guardReadOnlySql(`SELECT * FROM sets WHERE notes = 'it''s a drop set'`).ok).toBe(true);
  });

  it('rejects an unterminated string or block comment', () => {
    expect(guardReadOnlySql("SELECT * FROM sets WHERE notes = 'oops").ok).toBe(false);
    expect(guardReadOnlySql('SELECT 1 /* unclosed').ok).toBe(false);
  });

  it('rejects a statement that starts with neither SELECT nor WITH', () => {
    expect(guardReadOnlySql('VALUES (1)').ok).toBe(false);
    expect(guardReadOnlySql('').ok).toBe(false);
    expect(guardReadOnlySql('   ').ok).toBe(false);
  });
});

describe('query tool end to end', () => {
  it('runs a WITH ... SELECT and refuses an UPDATE', async () => {
    await callOk(USER1_TOKEN, 'log_sets', {
      date: '2026-04-01',
      sets: [
        { exercise: 'Deadlift', reps: 5, weight_lbs: 315 },
        { exercise: 'Deadlift', reps: 5, weight_lbs: 325 },
      ],
    });

    const result = await callOk(USER1_TOKEN, 'query', {
      sql: `WITH v AS (SELECT exercise, SUM(reps * weight_lbs) AS volume FROM sets GROUP BY exercise)
            SELECT * FROM v`,
    });
    expect(result.row_count).toBe(1);
    expect(result.rows[0].volume).toBe(5 * 315 + 5 * 325);

    const rejected = await callTool(USER1_TOKEN, 'query', { sql: 'UPDATE sets SET reps=99' });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain('read-only');

    // The rejected write really did not happen.
    const check = await callOk(USER1_TOKEN, 'query', { sql: 'SELECT reps FROM sets' });
    expect(check.rows.every((row: any) => row.reps === 5)).toBe(true);
  });
});
