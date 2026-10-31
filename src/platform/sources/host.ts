/**
 * The host of a pull (ADR 0014): everything a source's code does not do. It finds the source and
 * its code, refuses a version not switched on, takes the channel's secret from the store, opens
 * the channel, runs each due feed in the child, and delivers what it yields: a document into the
 * inbox (unless the books, the inbox or the ledger hold its bytes already, or its words say it is
 * no receipt: then into data/quarantine/), a checkpoint into the ledger. A dry run delivers nothing and writes nothing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parse } from 'yaml';
import { loadBooks, hasBooks } from '../../books/store.js';
import { secrets } from '../../secrets/secrets.js';
import type { Workspace } from '../../workspace/workspace.js';
import { sources } from './index.js';
import { launcherFor, runFeed, ChildCrashed, SourceError, type Launcher } from './launcher.js';
import { appendLedger, feedState, readLedger } from './ledger.js';
import { mailBackend, mailChannel, sha256, type Held, type MailBackend } from './mail-channel.js';
import { notReceipt } from '../../intake/recognize.js';
import { freeName, putInQuarantine } from '../../intake/quarantine.js';
import { secretKey, type Seen, type Cadence, type FeedDecl, type MacMailProblem, type MacMailReach, type MailReach, type SourceDecl } from './model.js';
import { MacMailError, macMailBackend } from './mac-mail.js';
import { ReachError } from './reach.js';
import { LoginNeeded, navigationAllowed, sessionOf, Trace, webChannel, type WebDriver } from './web-channel.js';
import { playwrightDriver } from './web-driver.js';
import { ApiRefused, apiChannel, type ApiFetch } from './api-channel.js';

/** `quarantined`: documents whose words say they are no receipt, put into data/quarantine/ instead of the inbox. */
export interface FeedReport { feed: string; documents: number; duplicates: number; quarantined: number; complete: boolean; seen?: Seen[] }

export type PullOutcome =
  | { outcome: 'ok'; feeds: FeedReport[] }
  | { outcome: 'missing-secret'; channel: 'mail' | 'api'; refused?: string; feeds: FeedReport[] }
  | { outcome: 'changed'; feed: string; message: string; feeds: FeedReport[] }
  | { outcome: 'over-reach'; feed: string; channel: string; attempted: string; feeds: FeedReport[] }
  /** A page of the source's sign-in came up: the person signs in in the source's window (the task «Bei {source} anmelden»), then the run goes on from its cursor. */
  | { outcome: 'login-needed'; at: string; feeds: FeedReport[] }
  /** The Mail app of this Mac could not be read (not open, not permitted, the account gone): a task for the person. */
  | { outcome: 'mail-app'; problem: MacMailProblem; feeds: FeedReport[] };

export interface PullRequest {
  ws: Workspace;
  appRoot: string;
  source: string;
  run: string;
  mode: 'live' | 'dry';
  /** The feeds to pull; without them, every feed that is due. */
  feeds?: string[];
  /** A dry run stops after this many documents (a preview, not a first pull over months). */
  limit?: number;
  now?: () => Date;
  launcher?: Launcher;
  mailBackend?: (reach: MailReach, password: string) => Promise<MailBackend>;
  macMailBackend?: (reach: MacMailReach) => Promise<MailBackend>;
  /** The browser behind `io.web`: the source's own Chrome session, unless a test stands in. */
  webDriver?: (session: string, guard: (url: string) => boolean) => Promise<WebDriver>;
  /** The HTTP client behind `io.api`. */
  apiFetch?: ApiFetch;
}

const HOUR = 3_600_000;
const PERIOD: Record<Cadence, number> = { hourly: HOUR, daily: 20 * HOUR, weekly: 6.5 * 24 * HOUR, monthly: 27 * 24 * HOUR, 'on-demand': Infinity };

/** Whether a feed is due: never pulled, or its cadence passed since its last line. */
export const feedDue = (feed: FeedDecl, last: string | undefined, now: Date): boolean => !last || now.getTime() - Date.parse(last) >= PERIOD[feed.every];

/** A source that is switched on, and where its code lies. */
function located(req: PullRequest): { decl: SourceDecl; folder: string; entry: string } {
  const v = sources(req.ws, req.appRoot).find((x) => (x.kind === 'invalid' ? x.id : x.decl.id) === req.source);
  if (!v) throw new Error(`no source "${req.source}"`);
  if (v.kind === 'invalid') throw new Error(`sources/${req.source}: ${v.problems.map((p) => `${p.file}${p.line ? `:${p.line}` : ''} ${p.message}`).join('; ')}`);
  if (v.kind === 'pending' && req.mode === 'live') throw new Error(`sources/${req.source} is not switched on: Firma › Quellen`);
  const { decl } = v;
  if (decl.code.kind === 'own') return { decl, folder: join(req.ws.paths.root, 'sources', decl.id), entry: decl.code.entry };
  const folder = join(req.appRoot, 'sources', decl.code.id);
  const entry = String((parse(readFileSync(join(folder, 'source.yaml'), 'utf8')) as { code: string }).code);
  return { decl, folder, entry };
}

const sha16 = (b: Buffer) => sha256(b).slice(0, 16);

/** The bytes the books, the inbox and the ledgers hold already, by their first 16 hex. */
function known(ws: Workspace): Map<string, string> {
  const out = new Map<string, string>();
  if (hasBooks(ws)) for (const r of loadBooks(ws).receipts) out.set(r.id, `receipt ${r.filename}`);
  if (existsSync(ws.paths.inbox)) for (const f of readdirSync(ws.paths.inbox)) out.set(sha16(readFileSync(join(ws.paths.inbox, f))), `inbox ${f}`);
  return out;
}

export async function pull(req: PullRequest): Promise<PullOutcome> {
  const now = req.now ?? (() => new Date());
  const { decl, folder, entry } = located(req);
  const reports: FeedReport[] = [];
  const lines = readLedger(req.ws, decl.id);
  const feeds = decl.feeds.filter((f) => (req.feeds ? req.feeds.includes(f.id) : feedDue(f, feedState(lines, f.id).last, now())));
  if (!feeds.length) return { outcome: 'ok', feeds: [] };

  let backend: MailBackend | undefined;
  const held = new Map<string, Held>();
  if (decl.reach.mail) {
    const password = await secrets.get(secretKey(decl.id, 'mail'));
    if (!password) return { outcome: 'missing-secret', channel: 'mail', feeds: reports };
    try {
      backend = await (req.mailBackend ?? mailBackend)(decl.reach.mail, password);
    } catch (e) {
      const err = e as Error & { authenticationFailed?: boolean; responseText?: string };
      if (err.authenticationFailed) return { outcome: 'missing-secret', channel: 'mail', refused: err.responseText ?? err.message, feeds: reports };
      throw e;
    }
  } else if (decl.reach.macMail) {
    try {
      backend = await (req.macMailBackend ?? macMailBackend)(decl.reach.macMail);
    } catch (e) {
      if (e instanceof MacMailError) return { outcome: 'mail-app', problem: e.problem, feeds: reports };
      throw e;
    }
  }
  const boxes = Array.isArray(decl.settings.boxes) ? (decl.settings.boxes as Array<{ to?: string }>) : [];
  const addresses = boxes.length && boxes.every((b) => b.to) ? boxes.map((b) => b.to!.toLowerCase()) : [];
  const since = new Date(typeof decl.settings.since === 'string' ? decl.settings.since : now().getTime() - 60 * 24 * HOUR);
  const mailReach = decl.reach.mail ?? decl.reach.macMail;
  const mail = backend && mailReach ? mailChannel(backend, mailReach, addresses, since, held) : undefined;
  let driver: WebDriver | undefined;
  let trace: Trace | undefined;
  const web = async () => {
    if (!decl.reach.web) return undefined;
    if (!driver) {
      trace = new Trace(decl.id, req.run);
      driver = await (req.webDriver ?? playwrightDriver)(sessionOf(decl.id), navigationAllowed(decl.reach.web));
    }
    return webChannel(driver, decl.reach.web, held, trace);
  };
  let api: ReturnType<typeof apiChannel> | undefined;
  if (decl.reach.api) {
    const token = await secrets.get(secretKey(decl.id, 'api'));
    if (!token) return { outcome: 'missing-secret', channel: 'api', feeds: reports };
    api = apiChannel(decl.reach.api, token, held, req.apiFetch);
  }
  const bytes = known(req.ws);
  for (const l of lines) if ('got' in l && l.got.kind === 'document') bytes.set(l.got.sha256.slice(0, 16), `${l.feed} ${l.key}`);

  try {
    for (const feed of feeds) {
      const state = feedState(lines, feed.id);
      const report: FeedReport = { feed: feed.id, documents: 0, duplicates: 0, quarantined: 0, complete: false };
      reports.push(report);
      const call = async (channel: string, method: string, args: unknown[]) => {
        const ch = channel === 'mail' ? mail : channel === 'web' ? await web() : channel === 'api' ? api : undefined;
        const fn = ch && (ch as Record<string, unknown>)[method];
        if (typeof fn !== 'function') throw new ReachError(channel as 'mail', `${channel}.${method}`);
        return (fn as (...a: unknown[]) => Promise<unknown>).apply(ch, args);
      };
      const run = runFeed(req.launcher ?? launcherFor(decl), { folder, entry, feed: feed.id, from: { kind: 'new', cursor: state.cursor }, settings: decl.settings }, call);
      for await (const item of run) {
        const at = now().toISOString();
        if (item.kind === 'checkpoint') { if (req.mode === 'live') appendLedger(req.ws, decl.id, { at, run: req.run, feed: feed.id, cursor: item.cursor }); continue; }
        if (item.kind === 'record') throw new SourceError(`records are not delivered yet (feed ${feed.id})`);
        if (state.keys.has(item.key)) continue;
        const file = held.get(item.file);
        if (!file) throw new SourceError(`${item.file} is no file the host fetched`);
        const sum = sha256(file.content);
        const dup = bytes.get(sum.slice(0, 16));
        const why = dup ? undefined : await notReceipt(file.content);
        if (dup) report.duplicates++; else if (why) report.quarantined++; else report.documents++;
        state.keys.add(item.key);
        if (req.mode !== 'live') {
          if (!dup) bytes.set(sum.slice(0, 16), `${feed.id} ${item.key}`);
          (report.seen ??= []).push({ name: file.name, ...(file.from ? { from: file.from } : {}), ...(item.date ? { date: item.date } : {}), as: dup ? 'duplicate' : why ? 'not-receipt' : 'new' });
          if (req.limit && report.seen.length >= req.limit) break;
          continue;
        }
        let name: string | undefined;
        let quarantined: { file: string; why: NonNullable<typeof why> } | undefined;
        if (!dup && why) {
          // Clearly no receipt by its words: kept apart with its reason, the books never see it.
          quarantined = { file: putInQuarantine(req.ws.paths.data, file.name, file.content, { kind: 'not-receipt', why, ...(file.from ? { from: file.from } : {}) }), why };
          bytes.set(sum.slice(0, 16), `quarantine ${quarantined.file}`);
        } else if (!dup) {
          mkdirSync(req.ws.paths.inbox, { recursive: true });
          name = freeName(req.ws.paths.inbox, file.name);
          writeFileSync(join(req.ws.paths.inbox, name), file.content);
          bytes.set(sum.slice(0, 16), `inbox ${name}`);
        }
        appendLedger(req.ws, decl.id, { at, run: req.run, feed: feed.id, key: item.key, got: { kind: 'document', sha256: sum, ...(name ? { file: name } : {}), ...(dup ? { duplicateOf: dup } : {}), ...(file.from ? { from: file.from } : {}), ...(quarantined ? { quarantined } : {}) } });
      }
      report.complete = true;
    }
  } catch (e) {
    const feed = reports.at(-1)?.feed ?? '';
    if (e instanceof MacMailError) return { outcome: 'mail-app', problem: e.problem, feeds: reports };
    if (e instanceof ApiRefused) return { outcome: 'missing-secret', channel: 'api', refused: e.message, feeds: reports };
    if (e instanceof LoginNeeded) return { outcome: 'login-needed', at: e.at, feeds: reports };
    if (driver && trace && (e instanceof ReachError || e instanceof SourceError || e instanceof ChildCrashed)) { trace.step({ failed: (e as Error).message }); await trace.page(driver); }
    if (e instanceof ReachError) return { outcome: 'over-reach', feed, channel: e.channel, attempted: e.attempted, feeds: reports };
    if (e instanceof SourceError || e instanceof ChildCrashed) return { outcome: 'changed', feed, message: e.message, feeds: reports };
    throw e;
  } finally {
    await backend?.close();
    await (driver as WebDriver | undefined)?.close();
  }
  return { outcome: 'ok', feeds: reports };
}

