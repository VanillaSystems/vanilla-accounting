/**
 * npm run secret -- <name>             sets a secret, asked without echo (a mailbox: source:<id>:mail)
 * npm run secret -- <name> --delete    removes it
 * npm run secret -- --import           one time: moves the IMAP passwords of the app's .env into the
 *                                      keychain and deletes their lines from .env
 *
 * Secrets belong to the books they are set for (VANILLA_WORKSPACE) and never enter the workspace
 * (ADR 0014). The keychain is the Mac's login keychain; the desktop app keeps its own.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { APP_ROOT, openWorkspace } from '../workspace/workspace.js';
import { mailSecret, secrets, type SecretName } from '../secrets/secrets.js';
import { hasKeychain, useKeychain } from '../secrets/keychain-store.js';

const ws = openWorkspace();
useKeychain(() => ws.paths.root);
if (!secrets.inApp()) { console.error(hasKeychain() ? 'No secret store here.' : 'No keychain on this computer: secrets need a Mac (or the desktop app).'); process.exit(1); }

const args = process.argv.slice(2);

/** A line typed without echo. */
async function hidden(question: string): Promise<string> {
  let muted = false;
  const out = new Writable({ write(chunk, _enc, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  process.stdout.write(question);
  muted = true;
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const isName = (s: string): s is SecretName => s === 'smtp' || /^source:[a-z0-9-]+:(mail|api)$/.test(s);

if (args[0] === '--import') {
  const env = join(APP_ROOT, '.env');
  if (!existsSync(env)) { console.log(`No ${env}: nothing to move.`); process.exit(0); }
  const lines = readFileSync(env, 'utf8').split('\n');
  const keep: string[] = [];
  const moved: string[] = [];
  for (const line of lines) {
    const m = /^\s*([A-Z0-9_]+)_IMAP_PASSWORD\s*=\s*(.*)\s*$/.exec(line);
    if (!m) { keep.push(line); continue; }
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (value) {
      const name = mailSecret(m[1].toLowerCase().replace(/_/g, '-'));
      await secrets.set(name, value);
      if ((await secrets.get(name)) !== value) { console.error(`⛔ ${name}: the keychain did not keep it; .env is left as it was.`); process.exit(1); }
      moved.push(name);
    }
  }
  writeFileSync(env, keep.join('\n'));
  console.log(moved.length ? `Moved into the keychain: ${moved.join(', ')}. Their lines are gone from ${env}.` : `No IMAP password in ${env}.`);
} else if (args[0] && isName(args[0])) {
  if (args.includes('--delete')) { await secrets.set(args[0], null); console.log(`Removed ${args[0]}.`); }
  else {
    const value = await hidden(`${args[0]}: `);
    if (!value) { console.error('Nothing typed: nothing changed.'); process.exit(1); }
    await secrets.set(args[0], value);
    console.log(`Kept ${args[0]} in the keychain.`);
  }
} else {
  console.error('Usage: npm run secret -- <smtp | source:<id>:mail | source:<id>:api> [--delete]   or   npm run secret -- --import');
  process.exit(2);
}
