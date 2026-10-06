/**
 * OAuth-fronted entrypoint (v3). The Worker is an OAuthProvider:
 *   - /mcp is the protected API route. The provider validates the bearer and
 *     injects ctx.props, from which we build the same UserCtx as before.
 *   - /authorize, /token, /register are the OAuth server endpoints.
 *   - everything else (the Google login pages plus the original /upload, /pic,
 *     and /export.* endpoints) is served by the default handler.
 *
 * The UserCtx shape and everything downstream of it are unchanged; only the
 * SOURCE of identity moved from a URL segment to validated OAuth props.
 *
 * PHASE 1 of the rollout (v3 §8): OAuth runs ALONGSIDE the existing static
 * bearer tokens. resolveExternalToken keeps a header bearer working on /mcp so a
 * working client is never broken mid-migration. Phase 3 deletes resolveExternalToken
 * and rotates TOKENS_JSON. NOTE: the path-segment form (/mcp/<token>) cannot
 * coexist — the provider requires an `Authorization: Bearer` header on the API
 * route, so path-token connectors must move to OAuth at cutover.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import {
  authenticate,
  buildCtx,
  ctxFromProps,
  isUserId,
  resolveToken,
  type Env,
  type UserCtx,
} from './auth.js';
import { handleAuthorize, handleCallback } from './google-handler.js';
import {
  handleExportCsv,
  handleExportJson,
  handlePic,
  handleUpload,
  json,
  textError,
} from './http.js';
import { buildServer } from './mcp.js';
import { verifyPicUrl } from './sig.js';

function unauthorized(): Response {
  return json({ error: 'Unauthorized' }, 401, {
    'www-authenticate': 'Bearer realm="fitness-mcp"',
  });
}

/**
 * The transport requires POST clients to advertise both application/json and
 * text/event-stream, per the MCP spec. We run in JSON-response mode and never
 * open an SSE stream from a POST, so that requirement only produces confusing
 * 406s for otherwise-fine clients. Normalize it: this can only turn a rejection
 * into a success and never changes behavior for a compliant client.
 */
function normalizeAccept(request: Request): Request {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('application/json') && accept.includes('text/event-stream')) return request;

  const headers = new Headers(request.headers);
  headers.set('accept', 'application/json, text/event-stream');
  return new Request(request, { headers });
}

async function handleMcp(request: Request, ctx: UserCtx, env: Env): Promise<Response> {
  const server = buildServer(ctx, env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id is issued and none is validated.
    sessionIdGenerator: undefined,
    // Buffer each response as JSON rather than opening an SSE stream, so the
    // Response is complete by the time handleRequest resolves and we can tear
    // the server down inside the request lifetime.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(
      request.method === 'POST' ? normalizeAccept(request) : request,
    );
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/**
 * /pic/:id accepts either a normal token or a short-lived signature minted by
 * get_progress_pic. The signature names the user, and that name is only trusted
 * after its MAC verifies.
 */
async function resolvePicAccess(
  request: Request,
  url: URL,
  env: Env,
  picId: number,
): Promise<UserCtx | null> {
  if (url.searchParams.has('sig')) {
    const check = await verifyPicUrl(env, url, picId, isUserId);
    if (check.ok && check.userId) {
      return buildCtx(check.userId, '', env, url);
    }
    return null;
  }
  return authenticate(request, url, env);
}

/** Execution context carrying the provider-injected, already-validated props. */
type PropsExecutionContext = ExecutionContext & { props?: unknown };

/**
 * /mcp — reached only after the provider validates a bearer (a provider-issued
 * OAuth token, or in phase 1 a static bearer via resolveExternalToken) and sets
 * ctx.props. OPTIONS and CORS are handled by the provider before this runs.
 */
const apiHandler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // A GET is the client asking for the standalone server->client SSE stream.
    // We are stateless and never push, so decline with 405 (which the spec tells
    // clients not to retry) rather than opening an empty stream that reads as a
    // dropped connection and triggers an immediate reconnect loop.
    if (request.method === 'GET') {
      return json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
        405,
        { allow: 'POST, DELETE, OPTIONS' },
      );
    }

    const userCtx = ctxFromProps((ctx as PropsExecutionContext).props, env, url);
    if (!userCtx) return unauthorized();
    return handleMcp(request, userCtx, env);
  },
} satisfies ExportedHandler<Env>;

/** Everything that is not /mcp or an OAuth server endpoint. */
const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    const route = segments[0] ?? '';

    try {
      if (route === 'authorize') return await handleAuthorize(request, env);
      if (route === 'callback') return await handleCallback(request, env);

      if (route === 'upload') {
        const ctx = await authenticate(request, url, env);
        if (!ctx) return unauthorized();
        return await handleUpload(request, ctx, env);
      }

      if (route === 'pic') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return textError('GET required', 405);
        }
        const rawId = segments[1];
        const picId = Number(rawId);
        if (!rawId || !Number.isSafeInteger(picId) || picId <= 0) {
          return textError('pic id must be a positive integer', 400);
        }
        const ctx = await resolvePicAccess(request, url, env, picId);
        if (!ctx) return unauthorized();
        return await handlePic(picId, ctx, env);
      }

      if (route === 'export.json') {
        const ctx = await authenticate(request, url, env);
        if (!ctx) return unauthorized();
        return await handleExportJson(url, ctx);
      }

      if (route === 'export.csv') {
        const ctx = await authenticate(request, url, env);
        if (!ctx) return unauthorized();
        return await handleExportCsv(url, ctx);
      }

      return textError(`no route for ${url.pathname}`, 404);
    } catch (error) {
      // Surface the message: this server has exactly two users, both of whom
      // benefit far more from a readable error than from opacity.
      console.error('unhandled error', error);
      return json({ error: error instanceof Error ? error.message : 'internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['mcp'],
  // PHASE 1/2 ONLY. Remove in phase 3 and rotate TOKENS_JSON. Accepts the
  // existing static bearer tokens on /mcp so a working client is not broken
  // mid-migration. Static tokens contain no ':' so they never collide with the
  // provider's own "userId:grantId:secret" token format.
  resolveExternalToken: async ({ token, env }) => {
    const userId = await resolveToken(token, env);
    return userId ? { props: { userId } } : null;
  },
});
