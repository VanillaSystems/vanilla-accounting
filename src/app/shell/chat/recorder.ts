/**
 * The microphone, recorded as mono PCM at 16 kHz (what Whisper reads, so the server converts
 * nothing) with its level for the meter. The audio stays in this page until it is sent to the
 * app's own server for transcription (src/chat/transcribe.ts).
 */
const SAMPLE_RATE = 16_000;

// A worklet hands each block of samples to the page; it is loaded from a blob, the app ships no file for it.
const WORKLET = `registerProcessor('pcm', class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
});`;

export interface Recording {
  /** The loudness of the last few milliseconds, 0..1. */
  level(): number;
  /** Stops and returns what was recorded. */
  stop(): Float32Array<ArrayBuffer>;
  /** Stops and drops it. */
  cancel(): void;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    throw e;
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const node = new AudioWorkletNode(ctx, 'pcm');
  const chunks: Float32Array[] = [];
  node.port.onmessage = (e: MessageEvent<Float32Array>) => { chunks.push(e.data); };
  source.connect(analyser);
  source.connect(node);
  const buf = new Float32Array(analyser.fftSize);

  const end = () => {
    node.port.onmessage = null;
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
  return {
    level() {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      // Speech sits around an RMS of 0.02..0.2: the square root spreads it over the meter.
      return Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 1.6);
    },
    stop() {
      end();
      const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      return out;
    },
    cancel: end,
  };
}
