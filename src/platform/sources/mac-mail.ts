/**
 * The Mail app of this Mac as a mail backend (reach `mac-mail`): the host asks Mail through Apple
 * events (JavaScript for Automation, run by /usr/bin/osascript), so the person sets up nothing:
 * no server, no password, no Full Disk Access. macOS asks once «… möchte Mail steuern»; a «no»
 * is the problem `not-permitted`, never a crash. The source's code sees the same mail channel as
 * an IMAP mailbox's (mail-channel.ts): messages by an increasing id, attachments as held bytes.
 *
 * Mail's message id grows as Mail stores new mail, so it is the cursor. Rebuilding a mailbox (or a
 * new Mail version moving its store) numbers the messages anew; the lowest id of the mailbox then
 * changes, which is the cursor's validity: a changed validity starts again from `since`, and the
 * ledger's keys keep anything from arriving twice.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { MailBackend, MailSummary } from './mail-channel.js';
import type { MacMailAccount, MacMailProblem, MacMailReach } from './model.js';

/** Runs a JXA script with its arguments (`run(argv)`) and gives what it printed. */
export type Osascript = (script: string, args: string[]) => Promise<string>;

export class MacMailError extends Error {
  constructor(readonly problem: MacMailProblem, detail?: string) { super(`Mail app: ${problem}${detail ? ` (${detail})` : ''}`); }
}

const OSASCRIPT = '/usr/bin/osascript';
/** Mail answers a first look at a large mailbox by date in seconds; a minute is a Mail that hangs. */
const TIMEOUT_MS = 120_000;

/** Whether this machine can read its Mail app at all: macOS with osascript. */
export const macMailAvailable = (): boolean => process.platform === 'darwin' && existsSync(OSASCRIPT);

/** What osascript's failure means: AppleScript's error numbers, as macOS prints them on stderr. */
export function problemOf(e: { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown; message?: string }): MacMailProblem {
  const text = `${String(e.stderr ?? '')} ${e.message ?? ''}`;
  if (e.code === 'ENOENT') return 'unavailable';
  if (e.killed || e.signal === 'SIGTERM') return 'timeout';
  if (/-1743|not authori[sz]ed/i.test(text)) return 'not-permitted';
  if (/-600\b|isn.t running/i.test(text)) return 'not-running';
  if (/-1712|timed out/i.test(text)) return 'timeout';
  return 'failed';
}

export const osascript: Osascript = (script, args) => new Promise((resolve, reject) => {
  if (!macMailAvailable()) return reject(new MacMailError('unavailable'));
  execFile(OSASCRIPT, ['-l', 'JavaScript', '-e', script, ...args], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new MacMailError(problemOf({ ...err, stderr }), String(stderr || err.message).trim().slice(0, 200)));
    resolve(stdout);
  });
});

// The scripts run inside osascript, not here: plain JavaScript for Automation. Each answers JSON;
// a problem the person can act on is `{ "error": <MacMailProblem> }`. Mail is never started by
// them (`running()` asks without launching it).
const PRELUDE = `
const Mail = Application('Mail');
const fail = (error) => JSON.stringify({ error });
const boxOf = (account, folder) => {
  const accounts = Mail.accounts.whose({ name: account })();
  if (!accounts.length) return { error: 'no-account' };
  const boxes = accounts[0].mailboxes.whose({ name: folder })();
  return boxes.length ? { box: boxes[0] } : { error: 'no-mailbox' };
};`;

const ACCOUNTS = `${PRELUDE}
function run() {
  if (!Mail.running()) return fail('not-running');
  return JSON.stringify({ accounts: Mail.accounts().filter((a) => a.enabled()).map((a) => ({ name: a.name(), addresses: a.emailAddresses(), mailboxes: a.mailboxes.name() })) });
}`;

const LIST = `${PRELUDE}
function run(argv) {
  const [account, folder, after, since, limit] = argv;
  if (!Mail.running()) return fail('not-running');
  const at = boxOf(account, folder);
  if (at.error) return fail(at.error);
  const all = at.box.messages.id();
  let min = Infinity;
  for (const i of all) if (i < min) min = i;
  let ids = after ? all.filter((i) => i > Number(after)) : at.box.messages.whose({ dateReceived: { _greaterThan: new Date(since) } }).id();
  ids = ids.sort((a, b) => a - b).slice(0, Number(limit));
  // One message at a time by its id: Mail answers that faster than a property over a range.
  const messages = ids.map((uid) => {
    const m = at.box.messages.byId(uid);
    const date = m.dateReceived();
    return { uid, sender: m.sender() || '', subject: m.subject() || '', date: date ? date.toISOString() : '', messageId: m.messageId() || '' };
  });
  return JSON.stringify({ validity: all.length ? String(min) : '', messages });
}`;

const ATTACHMENTS = `${PRELUDE}
function run(argv) {
  const [account, folder, uid, dir] = argv;
  if (!Mail.running()) return fail('not-running');
  const at = boxOf(account, folder);
  if (at.error) return fail(at.error);
  const found = at.box.messages.whose({ id: Number(uid) })();
  if (!found.length) return JSON.stringify({ parts: [] });
  const parts = [];
  found[0].mailAttachments().forEach((a, i) => {
    const name = String(a.name() || 'attachment');
    let downloaded = true;
    try { downloaded = a.downloaded(); } catch (e) { /* older Mail: every attachment is there */ }
    if (!downloaded) { parts.push({ name, skipped: 'not-downloaded' }); return; }
    const path = dir + '/' + i + '-' + name.replace(/[\\/:]/g, '_');
    Mail.save(a, { in: Path(path) });
    parts.push({ name, path });
  });
  return JSON.stringify({ parts });
}`;

/** The script's JSON, or its problem thrown. */
function answer<T>(out: string): T {
  let v: unknown;
  try { v = JSON.parse(out); } catch { throw new MacMailError('failed', `not JSON: ${out.slice(0, 120)}`); }
  const error = (v as { error?: MacMailProblem })?.error;
  if (error) throw new MacMailError(error);
  return v as T;
}

/** `Anna Muster <anna@example.com>` → `anna@example.com`; a bare address stays. */
export function addressOf(sender: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(sender);
  return (m?.[1] ?? sender).trim().toLowerCase();
}

/** The mailbox Mail uses as an account's inbox: `INBOX` for IMAP accounts, `Inbox` for Exchange; else the first. */
export const inboxOf = (mailboxes: readonly string[]): string => mailboxes.find((m) => m === 'INBOX') ?? mailboxes.find((m) => /^inbox$/i.test(m)) ?? mailboxes[0] ?? 'INBOX';

/**
 * Which accounts the Mail app has: the enabled ones, each with its addresses, mailboxes and inbox;
 * none is the problem `no-account`. Read-only, and evidence a discovery step may use. The first call
 * makes macOS ask the person «… möchte Mail steuern», so call it only when the person chose to look
 * at the mail program (a click, or a yes to the AI's question), never silently as a probe.
 */
export async function macMailAccounts(run: Osascript = osascript): Promise<MacMailAccount[]> {
  const { accounts } = answer<{ accounts: Array<{ name: string; addresses: string[] | null; mailboxes: string[] | null }> }>(await run(ACCOUNTS, []));
  if (!accounts.length) throw new MacMailError('no-account');
  return accounts.map((a) => ({ name: a.name, addresses: a.addresses ?? [], mailboxes: a.mailboxes ?? [], inbox: inboxOf(a.mailboxes ?? []) }));
}

const TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
export const contentTypeOf = (name: string): string => TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';

/**
 * A mail backend over one account of the Mail app. It checks first that Mail runs and holds the
 * account and its mailbox, so a pull that cannot read refuses before any code runs.
 */
export async function macMailBackend(r: MacMailReach, run: Osascript = osascript): Promise<MailBackend> {
  const folder0 = r.folders[0] ?? 'INBOX';
  answer(await run(LIST, [r.account, folder0, String(Number.MAX_SAFE_INTEGER), new Date().toISOString(), '0']));
  return {
    async list(folder, after, since, limit) {
      const page = answer<{ validity: string; messages: Array<{ uid: number; sender: string; subject: string; date: string; messageId: string }> }>(
        await run(LIST, [r.account, folder, after === undefined ? '' : String(after), since.toISOString(), String(limit)]),
      );
      const messages: MailSummary[] = [...page.messages].sort((x, y) => x.uid - y.uid).map((m) => ({ uid: m.uid, from: addressOf(m.sender), to: [], subject: m.subject, date: m.date, messageId: m.messageId || `mac-mail-${r.account}-${m.uid}` }));
      return { validity: page.validity, messages };
    },
    async attachments(folder, uid) {
      // Mail writes each attachment into a folder of the host's, read back and removed at once.
      const dir = mkdtempSync(join(tmpdir(), 'vanilla-mac-mail-'));
      try {
        const { parts } = answer<{ parts: Array<{ name: string; path?: string }> }>(await run(ATTACHMENTS, [r.account, folder, String(uid), dir]));
        const saved = new Set(readdirSync(dir).map((f) => join(dir, f)));
        return parts.flatMap((p) => (p.path && saved.has(p.path) ? [{ filename: p.name, contentType: contentTypeOf(p.name), content: readFileSync(p.path) }] : []));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async close() {},
  };
}
