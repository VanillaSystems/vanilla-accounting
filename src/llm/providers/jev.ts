/**
 * TypeSafe Jev (issue #48 step 3): a model that answers typed questions only, a yes/no
 * probability or one of named choices with a confidence, about text or a JSON state and PNG or
 * JPEG images of 280 to 1568 pixels a side. It writes no text and no JSON of its own and reads no
 * PDF, so the step table offers it only for typed steps (steps.ts `needs: ['typed']`). Measured in
 * our evals: about 0.4 s and USD 0.0004 a call. Wire format of POST /v1/systemone as the
 * @typesafe-ai/sdk 0.7.0 sends it; images go as multipart/form-data behind an opt-in header.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CallFailed, NO_USAGE, type JudgeCall, type Usage, type Verdict } from '../provider.js';
import { requestJson } from './http.js';
import type { KeyedSpec } from './keyed.js';

const url = () => `${process.env.VANILLA_JEV_URL ?? 'https://api.typesafe.ai'}/v1/systemone`;
const TYPED = ['typed', 'image'] as const;
const SIDE = { min: 280, max: 1568 };

/** Width and height of a PNG (its IHDR) or a JPEG (its first frame header); undefined for anything else. */
export function imageSize(b: Buffer): { type: 'image/png' | 'image/jpeg'; width: number; height: number } | undefined {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return undefined;
}

function image(path: string, n: number) {
  const bytes = readFileSync(path);
  const size = imageSize(bytes);
  if (!size) throw new CallFailed(`Jev reads PNG and JPEG images only, not ${basename(path)}`, NO_USAGE);
  const sides = [size.width, size.height];
  if (sides.some((s) => s < SIDE.min || s > SIDE.max)) throw new CallFailed(`Jev reads images of ${SIDE.min} to ${SIDE.max} pixels a side; ${basename(path)} is ${size.width}×${size.height}`, NO_USAGE);
  return { ref: `<image:${n}>`, part: `asset-${n}`, type: size.type, bytes };
}

type Answer = { noul?: number; choice?: string; confidence?: number | null };

const probability = (v: unknown): number | undefined => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined);

/** Jev's answer as a verdict; a probability outside 0 to 1 is no answer. A choice without its confidence counts as unsure. */
function verdictOf(call: JudgeCall, a: Answer | undefined): Verdict {
  const yes = probability(a?.noul);
  if (call.question.type === 'noul' && yes !== undefined) return { type: 'noul', yes, confidence: Math.max(yes, 1 - yes) };
  const confidence = a?.confidence == null ? 0 : probability(a.confidence);
  if (call.question.type === 'choice' && typeof a?.choice === 'string' && a.choice in call.question.options && confidence !== undefined) return { type: 'choice', choice: a.choice, confidence };
  throw new CallFailed('Jev gave no answer to the question', NO_USAGE);
}

async function systemOne(key: string, call: JudgeCall): Promise<{ verdict: Verdict; usage: Usage }> {
  const images = call.images.map(image);
  const refs = images.map((i) => i.ref);
  const state = !refs.length ? call.state : typeof call.state === 'string' ? `${call.state}\n\n${refs.join(' ')}` : { ...call.state, images: refs };
  const q = call.question;
  const request = {
    model: call.model, state,
    questions: { q: q.type === 'noul' ? { type: 'noul', instructions: q.instructions, criteria: null } : { type: 'choice', instructions: q.instructions, criteria: q.options } },
  };
  const headers = { authorization: `Bearer ${key}` };
  let json: unknown;
  if (!images.length) json = await requestJson('Jev', url(), { headers, body: request, timeoutMs: call.timeoutMs });
  else {
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify({ ...request, assets: Object.fromEntries(images.map((i) => [i.ref, { type: 'image', part: i.part }])) })], { type: 'application/json' }));
    for (const i of images) form.append(i.part, new Blob([new Uint8Array(i.bytes)], { type: i.type }), i.part);
    json = await requestJson('Jev', url(), { headers: { ...headers, 'TypeSafe-Danger-Zone-Images': 'true' }, form, timeoutMs: call.timeoutMs });
  }
  const r = json as { answers?: { q?: Answer }; usage?: { input_tokens?: number; output_tokens?: number } };
  const usage = { ...NO_USAGE, input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0, turns: 1 };
  return { verdict: verdictOf(call, r.answers?.q), usage };
}

export const JEV: KeyedSpec = {
  id: 'jev',
  shipped: [{ id: 'jev-latest', can: TYPED }, { id: 'jev-1.14.0', can: TYPED }, { id: 'jev-1.13.0', can: TYPED }],
  defaults: { fast: 'jev-latest', standard: 'jev-latest', strong: 'jev-latest' },
  capabilitiesOf: () => undefined,
  /** Jev lists no models: a key is checked with one question about a word, no company data. */
  check: (key) => systemOne(key, { state: 'Hallo', question: { type: 'noul', instructions: 'Is this a greeting?' }, model: 'jev-latest', images: [], timeoutMs: 15_000 }),
  judge: systemOne,
};
