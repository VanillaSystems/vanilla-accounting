/**
 * The providers paid per call with the person's own API key (issue #48): Anthropic and OpenAI over
 * HTTP. Each has shipped models and lists the rest from its /v1/models; a listed model it does not
 * know is offered only for what every model of its kind can do. The key comes from the secret store
 * (src/llm/keys.ts) and goes only into the request's header.
 */
import { CallFailed, NO_USAGE, type Call, type JudgeCall, type ModelEntry, type Provider, type Usage, type Verdict } from '../provider.js';
import type { Capability, Tier } from '../steps.js';
import { readAttachment, requestJson } from './http.js';
import { JEV } from './jev.js';

export type KeyedId = 'anthropic' | 'openai' | 'jev';

export interface KeyedSpec {
  id: KeyedId;
  shipped: readonly ModelEntry[];
  defaults: Record<Tier, string>;
  /** What a listed model can do; undefined: not a model for these steps (embeddings, speech, images). */
  capabilitiesOf(model: string): readonly Capability[] | undefined;
  /** The provider's model list; absent: it has none, its shipped models are all. */
  list?(key: string): Promise<string[]>;
  /** Rejects a key the provider refuses (HttpRefused 401 or 403), before the app keeps it. */
  check(key: string): Promise<unknown>;
  /** Absent: the provider writes no text (Jev); the step table never sends it a text step. */
  call?(key: string, call: Call): Promise<{ text: string; usage: Usage }>;
  judge?(key: string, call: JudgeCall): Promise<{ verdict: Verdict; usage: Usage }>;
}

const READS = ['text', 'json', 'typed', 'pdf', 'image'] as const;
const TEXT = ['text', 'json', 'typed'] as const;

const anthropicUrl = () => process.env.VANILLA_ANTHROPIC_URL ?? 'https://api.anthropic.com';
const anthropicHeaders = (key: string) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' });

export const ANTHROPIC: KeyedSpec = {
  id: 'anthropic',
  shipped: [
    { id: 'claude-haiku-5-5', can: READS },
    { id: 'claude-sonnet-5-5', can: READS },
    { id: 'claude-opus-5-5', can: READS },
  ],
  defaults: { fast: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' },
  // Every active Claude model reads images and PDFs (platform.claude.com/docs/en/build-with-claude/pdf-support),
  // whatever its line is called; retired ones are no longer listed.
  capabilitiesOf: (model) => (model.startsWith('claude-') ? READS : undefined),
  async list(key) {
    const json = await requestJson('Anthropic', `${anthropicUrl()}/v1/models?limit=1000`, { headers: anthropicHeaders(key), timeoutMs: 15_000 }) as { data?: Array<{ id?: unknown }> };
    return (json.data ?? []).flatMap((m) => (typeof m.id === 'string' ? [m.id] : []));
  },
  check(key) { return ANTHROPIC.list!(key); },
  async call(key, call) {
    const files = call.attachments.map(readAttachment).map((a) => (a.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } }));
    const json = await requestJson('Anthropic', `${anthropicUrl()}/v1/messages`, {
      headers: anthropicHeaders(key), timeoutMs: call.timeoutMs,
      body: { model: call.model, max_tokens: 16_000, system: call.system, messages: [{ role: 'user', content: [...files, { type: 'text', text: call.prompt }] }] },
    }) as {
      stop_reason?: string; content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
    };
    const u = json.usage ?? {};
    const usage = { input: u.input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, turns: 1 };
    if (json.stop_reason === 'refusal' || json.stop_reason === 'max_tokens') throw new CallFailed(`Anthropic stopped: ${json.stop_reason}`, usage);
    return { text: (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim(), usage };
  },
};

const openaiUrl = () => process.env.VANILLA_OPENAI_URL ?? 'https://api.openai.com';
/** Not a model for these steps: speech, images, embeddings, a specialist, or one only the Responses API serves (codex, pro, deep research). */
const NOT_CHAT = /(audio|realtime|live|tts|transcribe|whisper|image|dall-e|embedding|moderation|search|codex|cyber|rosalind|-pro\b|deep-research)/;
/** The chat generations before gpt-4o that read no PDF; every later one does, so a new generation needs no edit here. */
const TEXT_ONLY = /^(gpt-3\.5|gpt-4(-|$)|o1-mini|o3-mini)/;

export const OPENAI: KeyedSpec = {
  id: 'openai',
  shipped: [
    { id: 'gpt-6-luna', can: READS },
    { id: 'gpt-6.1-sol', can: READS },
    { id: 'gpt-6-astra', can: READS },
  ],
  defaults: { fast: 'gpt-6-luna', standard: 'gpt-6.1-sol', strong: 'gpt-6-astra' },
  capabilitiesOf: (model) => (!/^(gpt-|o\d|chatgpt-)/.test(model) || NOT_CHAT.test(model) ? undefined : TEXT_ONLY.test(model) ? TEXT : READS),
  async list(key) {
    const json = await requestJson('OpenAI', `${openaiUrl()}/v1/models`, { headers: { authorization: `Bearer ${key}` }, timeoutMs: 15_000 }) as { data?: Array<{ id?: unknown }> };
    return (json.data ?? []).flatMap((m) => (typeof m.id === 'string' ? [m.id] : []));
  },
  check(key) { return OPENAI.list!(key); },
  async call(key, call) {
    const files = call.attachments.map(readAttachment).map((a) => (a.mediaType === 'application/pdf'
      ? { type: 'file', file: { filename: a.name, file_data: `data:${a.mediaType};base64,${a.base64}` } }
      : { type: 'image_url', image_url: { url: `data:${a.mediaType};base64,${a.base64}` } }));
    const json = await requestJson('OpenAI', `${openaiUrl()}/v1/chat/completions`, {
      headers: { authorization: `Bearer ${key}` }, timeoutMs: call.timeoutMs,
      body: { model: call.model, messages: [{ role: 'system', content: call.system }, { role: 'user', content: [...files, { type: 'text', text: call.prompt }] }] },
    }) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const u = json.usage ?? {};
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const usage = { input: (u.prompt_tokens ?? 0) - cached, cacheCreate: 0, cacheRead: cached, output: u.completion_tokens ?? 0, turns: 1 };
    const choice = json.choices?.[0];
    if (!choice || choice.message?.refusal || choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') {
      throw new CallFailed(`OpenAI stopped: ${choice?.message?.refusal ? 'refusal' : choice?.finish_reason ?? 'no answer'}`, usage);
    }
    return { text: (choice.message?.content ?? '').trim(), usage };
  },
};

export const KEYED: readonly KeyedSpec[] = [ANTHROPIC, OPENAI, JEV];

/** The models of a provider: the shipped ones, then those its list adds that serve these steps. */
export function catalogOf(spec: KeyedSpec, listed: readonly string[]): ModelEntry[] {
  const shipped = new Set(spec.shipped.map((m) => m.id));
  return [...spec.shipped, ...listed.filter((id) => !shipped.has(id)).flatMap((id) => {
    const can = spec.capabilitiesOf(id);
    return can ? [{ id, can }] : [];
  })];
}

export function keyedProvider(spec: KeyedSpec, key: string, models: readonly ModelEntry[]): Provider {
  return {
    id: spec.id,
    billing: 'key',
    models,
    defaults: spec.defaults,
    ask: (call) => (spec.call ? spec.call(key, call) : Promise.reject(new CallFailed(`${spec.id} answers typed questions only`, NO_USAGE))),
    ...(spec.judge ? { judge: (call: JudgeCall) => spec.judge!(key, call) } : {}),
    ready: async () => true,
  };
}
