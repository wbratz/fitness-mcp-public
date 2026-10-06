import { SELF } from 'cloudflare:test';

export const USER1_TOKEN = 'user1-test-token-aaaaaaaaaaaaaaaaaaa';
export const USER2_TOKEN = 'user2-test-token-bbbbbbbbbbbbbbbbbbb';
export const BASE = 'https://fitness.test';

let nextId = 1;

export interface RpcResponse {
  status: number;
  body: {
    jsonrpc?: string;
    id?: number;
    result?: { content?: unknown[]; isError?: boolean; tools?: { name: string }[] };
    error?: { code: number; message: string };
  };
}

/** Raw JSON-RPC POST to /mcp with a Bearer token. */
export async function rpc(
  token: string | null,
  method: string,
  params?: unknown,
  init: { path?: string; accept?: string } = {},
): Promise<RpcResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.accept !== undefined) headers.accept = init.accept;
  else headers.accept = 'application/json, text/event-stream';
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await SELF.fetch(`${BASE}${init.path ?? '/mcp'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });

  const text = await response.text();
  let body: RpcResponse['body'] = {};
  if (text) {
    try {
      body = JSON.parse(text) as RpcResponse['body'];
    } catch {
      throw new Error(`non-JSON response (${response.status}): ${text.slice(0, 300)}`);
    }
  }
  return { status: response.status, body };
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  /** Parsed JSON payload of the first text block, when it is JSON. */
  data: any;
  content: any[];
}

/** Call a tool and unwrap its content blocks. */
export async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const { body } = await rpc(token, 'tools/call', { name, arguments: args });
  if (body.error) throw new Error(`JSON-RPC error calling ${name}: ${body.error.message}`);
  if (!body.result) throw new Error(`no result calling ${name}`);

  const content = (body.result.content ?? []) as any[];
  const firstText = content.find((block) => block?.type === 'text');
  const text: string = firstText?.text ?? '';

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }

  return { isError: body.result.isError === true, text, data, content };
}

/** Call a tool and fail loudly if it reported an error. */
export async function callOk(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const outcome = await callTool(token, name, args);
  if (outcome.isError) throw new Error(`tool ${name} failed: ${outcome.text}`);
  return outcome.data;
}

/** Multipart photo upload. */
export async function uploadPhoto(
  token: string,
  fields: { date?: string; pose?: string; weight_lbs?: string; notes?: string } = {},
  file: { bytes?: Uint8Array; name?: string; type?: string } = {},
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  const bytes = file.bytes ?? new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  form.append(
    'file',
    new File([bytes], file.name ?? 'photo.jpg', { type: file.type ?? 'image/jpeg' }),
  );
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, value);
  }

  const response = await SELF.fetch(`${BASE}/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
