/**
 * Stands in for the Anthropic and OpenAI APIs on 127.0.0.1, so a test runs the real HTTP providers
 * with no network and no real key. Each request is kept for the test to read; `reply` decides the
 * answer of the next requests per path.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: any }
export type Reply = { status: number; body: unknown };

export interface ProviderStub {
  url: string;
  seen: Seen[];
  reply: Map<string, Reply>;
  stop(): Promise<void>;
}

const DEFAULTS: Record<string, Reply> = {
  'GET /v1/models': { status: 200, body: { data: ['claude-sonnet-4-6', 'claude-mythos-5-1', 'gpt-4o', 'gpt-7-nova', 'gpt-3.5-turbo', 'gpt-image-2.5-flare', 'gpt-realtime-2.1', 'gpt-4o-mini-tts', 'gpt-5-pro', 'text-embedding-3-small'].map((id) => ({ id })) } },
  'POST /v1/messages': { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"stub":"anthropic"}' }], usage: { input_tokens: 11, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5 } } },
  'POST /v1/chat/completions': { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: '{"stub":"openai"}' } }], usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 8 } } } },
};

export async function providerStub(): Promise<ProviderStub> {
  const seen: Seen[] = [];
  const reply = new Map<string, Reply>();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      seen.push({ method: req.method ?? '', path, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const key = `${req.method} ${path}`;
      const r = reply.get(key) ?? DEFAULTS[key] ?? { status: 404, body: { error: { message: 'no such path' } } };
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    reply,
    stop: () => new Promise((done) => server.close(() => done())),
  };
}
