/**
 * Speech to text on this computer: Whisper (small, multilingual, 8-bit) through transformers.js on
 * onnxruntime. The model is downloaded once from Hugging Face into the models folder (the desktop
 * app's user data, VANILLA_MODELS_DIR); the audio never leaves the computer. A 10 s German clip
 * takes about 1.2 s on an M3 once the model is loaded (docs/chat.md).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WHISPER_MODEL = 'onnx-community/whisper-small';
export const SAMPLE_RATE = 16_000;

export const modelsDir = (): string => process.env.VANILLA_MODELS_DIR ?? join(homedir(), '.cache', 'vanilla-accounting', 'models');

const LANGUAGES: Record<string, string> = { de: 'german', fr: 'french', it: 'italian', en: 'english' };

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;
type Progress = (loaded: number, total: number) => void;

let model: Promise<Asr> | undefined;
const watchers = new Set<Progress>();
let queue: Promise<unknown> = Promise.resolve();

/** The model, loaded once; while it downloads, every waiting caller hears its progress (bytes of all its files). */
function load(onProgress: Progress): Promise<Asr> {
  watchers.add(onProgress);
  model ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = modelsDir();
    const files = new Map<string, { loaded: number; total: number }>();
    const asr = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status !== 'progress' || !p.file) return;
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
        const sum = [...files.values()].reduce((a, f) => ({ loaded: a.loaded + f.loaded, total: a.total + f.total }), { loaded: 0, total: 0 });
        watchers.forEach((w) => w(sum.loaded, sum.total));
      },
    });
    return asr as unknown as Asr;
  })();
  model.catch(() => { model = undefined; });
  return model.finally(() => watchers.delete(onProgress));
}

/** The text of `audio` (mono, 16 kHz) in `language` (de, fr, it, en). One transcription at a time. */
export function transcribe(audio: Float32Array, language: string, onProgress: Progress = () => {}): Promise<string> {
  const run = queue.then(async () => {
    const asr = await load(onProgress);
    const out = await asr(audio, { language: LANGUAGES[language] ?? 'german', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    return (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
  });
  queue = run.catch(() => undefined);
  return run;
}
