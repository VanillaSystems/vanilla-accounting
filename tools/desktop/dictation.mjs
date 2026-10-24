/**
 * Builds the Mac app's speech recognizer (src/desktop/dictation.swift) into out/desktop/vanilla-dictation:
 * one binary for Apple silicon and Intel, from macOS 12 on. electron-builder copies it into
 * Contents/MacOS (desktop/electron-builder.config.cjs extraFiles) and signs it with the app.
 *
 * The binary carries its own Info.plist (__TEXT,__info_plist) with the usage texts: macOS reads them
 * from the process that asks for the microphone or speech recognition, and stops one without them.
 * The prompt itself names the app that started it, whose Info.plist carries the same texts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mac } = createRequire(import.meta.url)('../../desktop/electron-builder.config.cjs');
/** The app's usage texts (the config's extendInfo), so the helper and the app say the same. */
const USAGE = {
  NSMicrophoneUsageDescription: mac.extendInfo.NSMicrophoneUsageDescription,
  NSSpeechRecognitionUsageDescription: mac.extendInfo.NSSpeechRecognitionUsageDescription,
};

export const HELPER = 'vanilla-dictation';

const plist = (entries) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${Object.entries(entries).map(([k, v]) => `  <key>${k}</key><string>${v}</string>`).join('\n')}
</dict></plist>
`;

export function buildDictation(out = 'out/desktop') {
  const dir = mkdtempSync(join(tmpdir(), 'vanilla-dictation-'));
  try {
    const info = join(dir, 'Info.plist');
    writeFileSync(info, plist({ CFBundleIdentifier: 'org.vanilla-accounting.desktop.dictation', CFBundleName: 'Vanilla Accounting', ...USAGE }));
    const slices = ['arm64', 'x86_64'].map((arch) => {
      const file = join(dir, arch);
      execFileSync('swiftc', [
        '-O', '-swift-version', '5', '-target', `${arch}-apple-macos12`,
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', info,
        'src/desktop/dictation.swift', '-o', file,
      ], { stdio: ['ignore', 'ignore', 'inherit'] });
      return file;
    });
    const target = join(out, HELPER);
    execFileSync('lipo', ['-create', ...slices, '-output', target]);
    return target;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
