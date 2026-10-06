import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach } from 'vitest';

/**
 * Give every test a pristine pair of migrated databases and an empty R2 bucket.
 *
 * reset() drops all persisted state, which includes the schema, so migrations
 * are re-applied afterwards. Applying to both databases is also exactly what
 * scripts/migrate.sh does, so the isolation tests run against two genuinely
 * separate schemas rather than a shared one.
 */
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB_USER1, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.DB_USER2, env.TEST_MIGRATIONS);
});
