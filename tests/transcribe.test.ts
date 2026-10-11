/**
 * Speech to text on this computer (src/chat/transcribe.ts): German speech made by macOS's `say`,
 * transcribed by the Whisper model. Runs only where both are there offline: a Mac, and the model
 * already in VANILLA_MODELS_DIR (the first download needs the network, a test does not fetch it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelsDir, transcribe, WHISPER_MODEL } from '../src/chat/transcribe.js';

const voice = (() => { try { return execFileSync('say', ['-v', '?'], { encoding: 'utf8' }).includes('de_DE'); } catch { return false; } })();
const model = existsSync(join(modelsDir(), WHISPER_MODEL, 'config.json'));
const skip = !voice ? 'no German voice of macOS `say` here' : !model ? `the speech model is not in ${modelsDir()} (set VANILLA_MODELS_DIR to one that holds it)` : false;

test('a German sentence comes back as German text', { skip, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcribe-'));
  try {
    execFileSync('say', ['-v', 'Anna', '-o', join(dir, 'de.aiff'), 'Bitte buche die Rechnung vom zwölften August auf das Konto Telefon.']);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, 'de.aiff'), join(dir, 'de.wav')]);
    const wav = readFileSync(join(dir, 'de.wav'));
    const data = wav.indexOf('data') + 8;
    const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + data, wav.byteOffset + wav.length - ((wav.length - data) % 2)));
    const text = await transcribe(Float32Array.from(pcm, (v) => v / 32768), 'de');
    assert.match(text, /Rechnung/);
    assert.match(text, /August/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
