import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            // Test-only tokens. Production values live in Worker secrets.
            TOKENS_JSON: JSON.stringify({
              'user1-test-token-aaaaaaaaaaaaaaaaaaa': 'user1',
              'user2-test-token-bbbbbbbbbbbbbbbbbbb': 'user2',
            }),
            SIGNING_SECRET: 'test-signing-secret-do-not-use-in-production',
            // v3 OAuth test values (production values live in Worker secrets).
            GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
            GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
            COOKIE_ENCRYPTION_KEY:
              '0000000000000000000000000000000000000000000000000000000000000000',
            USER_EMAILS_JSON: JSON.stringify({
              'user1@example.com': 'user1',
              'user2@example.com': 'user2',
            }),
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  };
});
