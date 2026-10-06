import { describe, expect, it } from 'vitest';
import { callOk, callTool, USER1_TOKEN, rpc } from './helpers.js';

describe('MCP transport (stateless Streamable HTTP)', () => {
  it('responds to initialize with server info', async () => {
    const { status, body } = await rpc(USER1_TOKEN, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    expect(status).toBe(200);
    expect((body.result as any)?.serverInfo?.name).toBe('fitness');
  });

  it('lists every tool the spec calls for', async () => {
    const { body } = await rpc(USER1_TOKEN, 'tools/list', {});
    const names = (body.result?.tools ?? []).map((tool) => tool.name).sort();

    expect(names).toEqual(
      [
        'delete_meal',
        'delete_sets',
        'export_data',
        'get_active_plan',
        'get_day',
        'get_history',
        'get_plan',
        'get_profile',
        'get_progress_pic',
        'get_weight_trend',
        'list_exercises',
        'list_plans',
        'list_progress_pics',
        'log_meal',
        'log_sets',
        'log_weighin',
        'log_workout_meta',
        'query',
        'rename_exercise',
        'save_plan',
        'update_meal',
        'update_profile',
        'update_set',
        'whoami',
      ].sort(),
    );
  });

  it('serves a tools/call that was never preceded by initialize', async () => {
    // The whole stateless design rests on this: each HTTP request builds a fresh
    // server, so nothing may depend on an earlier request having initialized it.
    const profile = await callOk(USER1_TOKEN, 'get_profile');
    expect(profile.id).toBe(1);
  });

  it('accepts a client that only advertises application/json', async () => {
    const { status, body } = await rpc(USER1_TOKEN, 'tools/list', {}, {
      accept: 'application/json',
    });
    expect(status).toBe(200);
    expect(body.result?.tools?.length).toBeGreaterThan(0);
  });

  it('reports tool argument validation as an error result, not a crash', async () => {
    const outcome = await callTool(USER1_TOKEN, 'get_day', { date: 'not-a-date' });
    expect(outcome.isError).toBe(true);
  });

  it('rejects the old path-token form on /mcp (v3: OAuthProvider requires a Bearer header)', async () => {
    // Under v3 the OAuthProvider owns /mcp and requires Authorization: Bearer,
    // so the v2 /mcp/<token> path form no longer authenticates — it is now a
    // sub-path of the API route with no bearer, which the provider 401s before
    // any handler runs. Header-bearer static tokens still work during phase 1
    // via resolveExternalToken (exercised throughout the other suites).
    const { status } = await rpc(null, 'tools/list', {}, {
      path: `/mcp/${USER1_TOKEN}`,
    });
    expect(status).toBe(401);
  });
});
