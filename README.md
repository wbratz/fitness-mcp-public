# fitness-mcp

A small, self-hosted fitness tracker exposed as a remote **Model Context Protocol (MCP) server** on Cloudflare Workers.

It is designed for conversational logging from MCP-capable AI clients: workouts, sets, weigh-ins, meals, goals, plans, and progress photos are parsed by the model and stored as structured data.

## Architecture

```text
ChatGPT / Claude / other MCP client
              |
              v
       Cloudflare Worker
              |
       +------+------+
       |             |
       v             v
      D1             R2
 structured data   photos
```

The example configuration contains two generic users. Each user gets a separate D1 database with the same schema. Authentication selects the database binding before application code handles the request, so even the raw read-only SQL tool cannot cross user boundaries.

Photos live in one R2 bucket under user-specific prefixes. Photo links returned to clients are short-lived HMAC-signed URLs rather than account credentials.

## What it can do

- Log resistance-training sets from natural language.
- Record reps, timed holds, and distance-based work.
- Record workout metadata when set-level numbers are unavailable.
- Upsert weigh-ins.
- Log meals and macros.
- Store goals and training plans.
- Upload, list, and retrieve progress photos.
- Query the authenticated user's D1 database through a guarded read-only SQL tool.
- Export data as JSON or CSV.

The server intentionally keeps analytics light. The MCP client can reason over the structured rows; aggregate tools can be added later if histories become too large for efficient context use.

## Stack

- Cloudflare Workers
- Cloudflare D1
- Cloudflare R2
- Cloudflare KV for OAuth provider state
- `@modelcontextprotocol/sdk`
- `@cloudflare/workers-oauth-provider`
- TypeScript
- Vitest / Miniflare

## Public example

This repository is a sanitized reference implementation. It uses generic users, placeholder Cloudflare resource IDs, example email addresses, an example Workers hostname, and test-only credentials. It contains no production credentials or production deployment identifiers.

## Setup

```bash
npm install
npx wrangler login
npx wrangler d1 create fitness-user1
npx wrangler d1 create fitness-user2
npx wrangler r2 bucket create fitness-pics
npx wrangler kv namespace create OAUTH_KV
```

Put the generated D1 database IDs and KV namespace ID into `wrangler.toml`.

Set Worker secrets:

```bash
npx wrangler secret put TOKENS_JSON
npx wrangler secret put SIGNING_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put USER_EMAILS_JSON
```

Example email allowlist:

```json
{
  "user1@example.com": "user1",
  "user2@example.com": "user2"
}
```

Then:

```bash
npm run migrate -- --remote
npm run typecheck
npm test
npm run deploy
```

Register the deployed `/mcp` endpoint in an MCP-capable client and complete the OAuth flow.

## Why one database per user?

D1/SQLite does not provide row-level security. Because this server exposes a raw read-only SQL escape hatch, putting each user in a different D1 database makes the account boundary structural rather than relying on SQL rewriting or a forgotten `WHERE user_id = ...` filter.

The cost is operational: adding a user means adding another D1 binding and running the same migrations against it.

## Development

```bash
cp .dev.vars.example .dev.vars
npm run migrate
npm run dev
npm test
npm run typecheck
```

Never commit `.dev.vars`, real tokens, OAuth secrets, database exports, or signing keys.

## License

ISC
