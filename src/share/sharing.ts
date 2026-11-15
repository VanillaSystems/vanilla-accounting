/**
 * Sharing the books by link (docs/specs/e2e-and-fiduciary.md B3, ADR 0016 as amended on
 * 2026-11-15): the Freigabe-Datei (`.vanillashare`, src/handover/package.ts) uploaded whole to the
 * share service, which sends the invitation itself, from «<name> über Vanilla Accounting», replies
 * to the sharer. The link in it is the access. Its page downloads the same file into the browser's
 * Downloads; double-clicked, it opens as the recipient's copy, linked to the share by what its index
 * names (`share`). «In der App öffnen» downloads it in the app, into Downloads too. «Aktualisieren»
 * puts the whole books again into the same share; the recipient's copy moves forward when he opens
 * it. The recipient's return goes into the same share; the sharer's app fetches it and keeps it for
 * review. Nothing reaches the books before the sharer takes it over.
 *
 * Kept where: the shares' facts (id, recipient, version, state) in handover/shares.json of the
 * books; each share's revoke and return token in the secret store (src/secrets/), never in the
 * books, which are often a repository; this computer's confirmed sender in the secret store too. A
 * copy keeps its link (service, id, return token, the state it holds) in its own data/durchsicht/,
 * which lives in the app's folder and travels nowhere.
 *
 * A link naming another service than this app's opens only when the person confirmed it, after
 * seeing whose books, from whom and through which service (`previewLink`).
 *
 * The `.vanilla` file stays the way for every step without the service (B3.7).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { secrets } from '../secrets/secrets.js';
import { sendText, sendingAddress } from '../invoices/mail.js';
import type { Workspace } from '../workspace/workspace.js';
import { prepareShare, HANDOVER_DIR, type ShareRequest } from '../handover/share.js';
import { readPackage, writePackage, PackageError, type PackageContents, type ShareTag } from '../handover/package.js';
import { buildReturn, durchsichtHome, isDurchsicht, markerOf, openPackage, type CopyChoice, type Opened } from '../handover/durchsicht.js';
import { attachDocument, restoreSaved } from '../handover/document.js';
import { receiveReturn } from '../handover/returns.js';
import { readVersions } from '../handover/versions.js';
import { DURCHSICHT_MARKER } from '../handover/content.js';
import type { Party } from '../handover/versions.js';
import { shareClient, ShareServiceError, type Envelope, type ShareClient } from './client.js';
import { downloadsDir, linkOf, parseLink, shareService } from './service.js';
import { receivePackage, sendPackage, type Progress } from './transport.js';
import { SHARE_LIMITS } from './limits.js';

/** A step of the flow refused before or beside the service: the UI says it by its code. */
export type ShareFlowRefusal =
  | 'shareNoService' | 'shareNoSecretStore' | 'shareSenderMissing' | 'shareSenderUnconfirmed' | 'shareLinkInvalid' | 'shareNoLink' | 'shareUnknown'
  | 'shareForeignService' | 'shareConfirmationOdd' | 'shareCopyNewer' | 'shareEmailMissing' | 'shareWithdrawn' | 'shareNotCopy' | 'shareReturnFailed';

export class ShareFlowError extends Error {
  constructor(message: string, readonly code: ShareFlowRefusal, readonly params: Record<string, string> = {}) { super(message); }
}

// ─── this computer's sender ─────────────────────────────────────────────────

interface Sender { service: string; email: string; token: string }

async function senderKept(): Promise<Sender | undefined> {
  const raw = await secrets.get('share:sender');
  if (!raw) return undefined;
  try { return JSON.parse(raw) as Sender; } catch { return undefined; }
}

function serviceNow(): string {
  const { url } = shareService();
  if (!url) throw new ShareFlowError('Kein Teil-Dienst eingerichtet: die Buchhaltung geht als Datei (.vanilla).', 'shareNoService');
  return url;
}

function needSecretStore(): void {
  if (!secrets.inApp()) throw new ShareFlowError('Diese App kann die Zugangsdaten des Links hier nicht sicher aufbewahren: die Buchhaltung geht als Datei (.vanilla).', 'shareNoSecretStore');
}

export interface SenderView {
  email?: string;
  confirmed: boolean;
  /** Why the service refused the last confirmation e-mail (docs/api.md): otherAddress, ambiguousFrom, notAuthenticated, codeExpired. */
  refusedReason?: string;
  confirmationExpiresAt?: string;
}

export interface Registered extends SenderView {
  /** The e-mail that confirms the address: the app sent it (`mailed`), or the person sends it from her mail program. */
  confirmation?: { to: string; subject: string; text: string; expiresAt: string };
  mailed: boolean;
  mailError?: string;
}

/** The subject the service's inbound address reads (its docs/api.md), its code in base64url; nothing else goes out from her mailbox. */
const CONFIRM_SUBJECT = /^Vanilla Accounting confirmation [A-Za-z0-9_-]{8,64}$/;

/**
 * What the service asks to be sent, held to what a confirmation is: to an address at the service's
 * own domain, with the subject it reads; the body is the app's own. A service never chooses whom
 * her mailbox writes to or what it says (review of PR #538).
 */
function confirmationOf(service: string, email: string, c: { to?: unknown; subject?: unknown; expiresAt?: unknown }): NonNullable<Registered['confirmation']> {
  const host = new URL(service).hostname.toLowerCase();
  const to = typeof c.to === 'string' ? c.to.trim() : '';
  const domain = to.split('@')[1]?.toLowerCase();
  const subject = typeof c.subject === 'string' ? c.subject : '';
  if (!/^[^@\s]+@[^@\s]+$/.test(to) || domain !== host || !CONFIRM_SUBJECT.test(subject)) {
    throw new ShareFlowError(`Der Dienst ${host} verlangt eine Bestätigung an ${to || '(leer)'} mit dem Betreff «${subject.slice(0, 80)}»: das sendet die App nicht.`, 'shareConfirmationOdd', { host });
  }
  const text = `Mit dieser E-Mail bestätigt Vanilla Accounting, dass ${email} Buchhaltungen über ${host} teilt.\n`;
  return { to, subject, text, expiresAt: typeof c.expiresAt === 'string' ? c.expiresAt : '' };
}

/**
 * Registers `email` as this computer's sender (docs/api.md POST /api/senders) and sends the
 * confirmation e-mail from that address when the books' mailbox sends from it; otherwise the
 * person sends it from her mail program, prepared with the exact subject.
 */
export async function registerSender(ws: Workspace, email: string): Promise<Registered> {
  needSecretStore();
  const service = serviceNow();
  const reg = await shareClient(service).registerSender(email.trim());
  await secrets.set('share:sender', JSON.stringify({ service, email: email.trim(), token: reg.senderToken } satisfies Sender));
  if (reg.confirmed) return { email: email.trim(), confirmed: true, mailed: false };
  const confirmation = confirmationOf(service, email.trim(), reg.confirmation ?? {});
  const out: Registered = { email: email.trim(), confirmed: false, confirmation, mailed: false, ...(confirmation.expiresAt ? { confirmationExpiresAt: confirmation.expiresAt } : {}) };
  if (sendingAddress(ws)?.toLowerCase() === email.trim().toLowerCase()) {
    try {
      await sendText(ws, { to: confirmation.to, subject: confirmation.subject, body: confirmation.text });
      out.mailed = true;
    } catch (e) { out.mailError = (e as Error).message; }
  }
  return out;
}

/** This computer's sender as the service sees it now; nothing when none is registered for the service in use. */
export async function senderState(): Promise<SenderView> {
  const s = await senderKept();
  const { url } = shareService();
  if (!s || s.service !== url) return { confirmed: false };
  try {
    const me = await shareClient(s.service).sender(s.token);
    return {
      email: s.email, confirmed: me.confirmed,
      ...(me.refusedReason ? { refusedReason: me.refusedReason } : {}),
      ...(me.confirmationExpiresAt ? { confirmationExpiresAt: me.confirmationExpiresAt } : {}),
    };
  } catch (e) {
    // A token the service no longer knows: registered anew next time.
    if (e instanceof ShareServiceError && e.code === 'senderUnknown') { await secrets.set('share:sender', null); return { confirmed: false }; }
    throw e;
  }
}

/** Forgets this computer's sender («Andere Adresse»). */
export const forgetSender = (): Promise<void> => secrets.set('share:sender', null);

// ─── the sharer's shares ────────────────────────────────────────────────────

export interface ShareReturn { id: string; state: string; at: string; bytes: number; received?: string; error?: string }

export interface ShareRecord {
  id: string;
  service: string;
  to: Party;
  version: number;
  /** Always `full` since the owner's decision of 2026-11-15; `update` on shares 0.6.0 made. */
  kind: 'full' | 'update';
  /** Ciphertext bytes and files of the package. */
  bytes: number;
  files: number;
  at: string;
  state: string;
  expiresAt?: string;
  firstOpenedAt?: string;
  opens: string[];
  returns: ShareReturn[];
  /** When the service last sent the invitation, and how often it did; her message and language, for «Nochmals senden». */
  invitedAt?: string;
  message?: string;
  language?: string;
  invites?: number;
  /** When «Aktualisieren» last put the books into this share again, and when he was told. */
  updatedAt?: string;
  notifiedAt?: string;
  /** The note of the last «Aktualisieren» did not go out (the update itself is done): why, as the service said it. Its «Nochmals senden» sends the note. */
  notifyError?: string;
  revokedAt?: string;
  checkedAt?: string;
  /** The last check's failure, as a fact. */
  error?: string;
}

const SHARES = 'shares.json';
const sharesFile = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.root, HANDOVER_DIR, SHARES);

export function readShares(ws: Pick<Workspace, 'paths'>): ShareRecord[] {
  const f = sharesFile(ws);
  if (!existsSync(f)) return [];
  try { return (JSON.parse(readFileSync(f, 'utf8')) as { shares?: ShareRecord[] }).shares ?? []; } catch { return []; }
}

/**
 * Every change of shares.json: read, changed and written in one synchronous step, so no network
 * wait sits between the read and the write and no share added meanwhile is lost (review of #538).
 */
function updateShares(ws: Pick<Workspace, 'paths'>, fn: (shares: ShareRecord[]) => ShareRecord[]): ShareRecord[] {
  const next = fn(readShares(ws));
  mkdirSync(dirname(sharesFile(ws)), { recursive: true });
  writeFileSync(`${sharesFile(ws)}.tmp`, JSON.stringify({ schema: 1, shares: next }, null, 1) + '\n');
  renameSync(`${sharesFile(ws)}.tmp`, sharesFile(ws));
  return next;
}
const changeShare = (ws: Pick<Workspace, 'paths'>, id: string, fn: (r: ShareRecord) => void): ShareRecord | undefined => {
  let out: ShareRecord | undefined;
  updateShares(ws, (all) => all.map((r) => { if (r.id !== id) return r; const c = structuredClone(r); fn(c); out = c; return c; }));
  return out;
};

/** What the sharer's app keeps of a share in the secret store: its revoke token, and the recipient's return token for the next state's index. */
interface ShareKeys { revokeToken: string; returnToken?: string }
const keysOf = async (id: string): Promise<ShareKeys | undefined> => {
  const raw = await secrets.get(`share:${id}`);
  return raw ? (JSON.parse(raw) as ShareKeys) : undefined;
};

/** Why the service did not send a mail: kept as it was raised, worded by the route (src/server/routes/share.ts). */
export interface Shared { record: ShareRecord; link: string; invited: boolean; inviteError?: unknown }

/** One share, and one check of the shares, of the same books at a time: two shares at once would both build on the same next version, two checks would fetch a return twice. */
const running = new Map<string, Promise<unknown>>();
function oneAtATime<T>(ws: Pick<Workspace, 'paths'>, fn: () => Promise<T>): Promise<T> {
  const key = ws.paths.root;
  const before = running.get(key) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(fn);
  running.set(key, next.catch(() => undefined));
  return next;
}

export interface ShareOptions { progress?: Progress; now?: Date; language?: string }

/** The confirmed sender of this computer for the service in use, asked of the service now. */
async function confirmedSender(service: string): Promise<Sender> {
  const sender = await senderKept();
  if (!sender || sender.service !== service) throw new ShareFlowError('Zuerst die eigene E-Mail-Adresse bestätigen.', 'shareSenderMissing');
  const me = await shareClient(service).sender(sender.token);
  if (!me.confirmed) throw new ShareFlowError(`${sender.email} ist noch nicht bestätigt.`, 'shareSenderUnconfirmed', { email: sender.email });
  return sender;
}

/**
 * «Einladung senden»: builds the next version's package, seals and uploads it, then writes the
 * version (only once the service holds it), keeps the share, and asks the service to send the
 * invitation to `req.to.email`. A mail the service refuses (its limit of the day, say) leaves the
 * share as it is: the person copies the link or sends it again later.
 */
export function shareByLink(ws: Workspace, req: ShareRequest, from: Party, opts: ShareOptions = {}): Promise<Shared> {
  return oneAtATime(ws, () => shareNow(ws, req, from, opts));
}

/** The envelope the share's page shows and the download is named by: who, which books, her note, the day. */
const envelope = (senderName: string, direction: Envelope['direction'], company: string, note: string | undefined, now?: Date): Envelope => ({
  v: 2, senderName: senderName.slice(0, 100), direction, ...(company ? { company: company.slice(0, 200) } : {}),
  ...(note ? { note: note.slice(0, 1000) } : {}), ...(now ? { asOf: now.toISOString().slice(0, 10) } : {}),
});

/** The hand-over's Freigabe-Datei, naming the share it goes into (`tag`), its index kept at `room` bytes. */
function handOverFile(prepared: { index: PackageContents['index']; files: ReadonlyMap<string, Uint8Array> }, tag: ShareTag | undefined, room: number | undefined): { bytes: Uint8Array; indexBytes: number } {
  const index = { ...prepared.index, ...(tag ? { share: tag } : {}) };
  return { bytes: writePackage({ index, files: new Map(prepared.files) }, room === undefined ? {} : { indexRoom: room }), indexBytes: Buffer.byteLength(JSON.stringify(index, null, 1)) };
}

const languageOf = (l: string | undefined): string => (l && ['de', 'fr', 'it', 'en'].includes(l.slice(0, 2)) ? l.slice(0, 2) : 'de');

async function shareNow(ws: Workspace, req: ShareRequest, from: Party, opts: ShareOptions): Promise<Shared> {
  needSecretStore();
  const service = serviceNow();
  const email = req.to.email?.trim();
  if (!email) throw new ShareFlowError('Für den Link braucht es die E-Mail-Adresse: an sie schickt der Dienst die Einladung.', 'shareEmailMissing');
  const sender = await confirmedSender(service);
  const client = shareClient(service);
  const now = opts.now ?? new Date();
  // Whole, like every hand-over: the link opens on any copy, lost, older or missing a receipt (src/handover/share.ts).
  const prepared = await prepareShare(ws, req, from, now);
  const message = prepared.index.message;
  const meta = envelope(from.name, 'send', ws.company.name, message, now);
  const sent = await sendPackage({
    client, service, build: (tag, room) => handOverFile(prepared, tag, room),
    start: (bytes) => client.create(sender.token, { bytes, meta }),
    progress: opts.progress,
  });
  const link = linkOf(service, sent.id);
  let version;
  try {
    await secrets.set(`share:${sent.id}`, JSON.stringify({ revokeToken: sent.revokeToken, ...(sent.returnToken ? { returnToken: sent.returnToken } : {}) } satisfies ShareKeys));
    // Written only now, with the service holding the package.
    version = prepared.commit();
  } catch (e) {
    // A share the books keep no version of (another version written meanwhile): gone at the service, its tokens dropped.
    await client.revoke(sent.id, sent.revokeToken).catch(() => undefined);
    await secrets.set(`share:${sent.id}`, null).catch(() => undefined);
    throw e;
  }
  const record: ShareRecord = {
    id: sent.id, service, to: req.to, version: version.n, kind: 'full',
    bytes: sent.status.bytes, files: prepared.files.size, at: now.toISOString(), state: sent.status.state,
    ...(sent.status.expiresAt ? { expiresAt: sent.status.expiresAt } : {}), opens: [], returns: [],
    ...(message ? { message } : {}), language: languageOf(opts.language),
  };
  updateShares(ws, (all) => [record, ...all.filter((r) => r.id !== record.id)]);
  try {
    const next = await invite(ws, record, sent.revokeToken, sender.email, from);
    return { record: next, link, invited: true };
  } catch (e) {
    return { record, link, invited: false, inviteError: e };
  }
}

/** The invitation, as the service sends it: every field named each time, so a first send that failed can be sent again. */
async function invite(ws: Workspace, r: ShareRecord, revokeToken: string, senderEmail: string, from: Party): Promise<ShareRecord> {
  if (!r.to.email) throw new ShareFlowError('Für den Link braucht es die E-Mail-Adresse: an sie schickt der Dienst die Einladung.', 'shareEmailMissing');
  const done = await shareClient(r.service).invite(r.id, revokeToken, {
    // Within the service's field limits (its docs/api.md: names 100, company 200, message 2000 characters).
    kind: 'invite', to: { name: r.to.name.slice(0, 100), email: r.to.email }, from: { name: from.name.slice(0, 100), email: senderEmail },
    ...(r.message ? { message: r.message.slice(0, 2000) } : {}), company: ws.company.name.slice(0, 200), language: r.language ?? 'de',
  });
  return changeShare(ws, r.id, (x) => { x.invitedAt = done.sentAt; x.invites = done.invites; }) ?? r;
}

/**
 * «Nochmals senden»: the service sends the invitation again, to the same address (it takes no other
 * once one went out). After an «Aktualisieren» whose note did not go out (notifyError), the note.
 */
export async function inviteAgain(ws: Workspace, id: string, from: Party): Promise<ShareRecord> {
  const r = readShares(ws).find((x) => x.id === id);
  const keys = r ? await keysOf(id) : undefined;
  if (!r || !keys) throw new ShareFlowError('Diesen Link kennt die App nicht (mehr).', 'shareUnknown');
  if (r.notifyError) {
    const done = await shareClient(r.service).invite(id, keys.revokeToken, { kind: 'update' });
    return changeShare(ws, id, (x) => { x.notifiedAt = done.sentAt; x.invites = done.invites; delete x.notifyError; }) ?? r;
  }
  const sender = await confirmedSender(r.service);
  return invite(ws, r, keys.revokeToken, sender.email, from);
}

/**
 * «Aktualisieren»: the whole books again into the same share, as its next state: same link, same
 * recipient, his return token unchanged; the service keeps it 14 days from now. With `notify` the
 * service sends him a short note; without, nothing. His copy moves forward by itself when he opens
 * it (checkCopy), his own changes kept; if he never opened the link, he gets this state first.
 */
export function updateByLink(ws: Workspace, id: string, from: Party, opts: ShareOptions & { notify?: boolean; message?: string } = {}): Promise<ShareRecord> {
  return oneAtATime(ws, () => updateNow(ws, id, from, opts));
}

async function updateNow(ws: Workspace, id: string, from: Party, opts: ShareOptions & { notify?: boolean; message?: string }): Promise<ShareRecord> {
  needSecretStore();
  const r = readShares(ws).find((x) => x.id === id);
  const keys = r ? await keysOf(id) : undefined;
  if (!r || !keys) throw new ShareFlowError('Diesen Link kennt die App nicht (mehr).', 'shareUnknown');
  if (r.revokedAt) throw new ShareFlowError('Diese Freigabe ist zurückgezogen: für einen neuen Stand neu teilen.', 'shareWithdrawn');
  const client = shareClient(r.service);
  const now = opts.now ?? new Date();
  const message = opts.message?.trim() ? opts.message.trim().slice(0, 2000) : undefined;
  const prepared = await prepareShare(ws, { to: r.to, ...(message ? { message } : {}) }, from, now);
  const meta = envelope(from.name, 'send', ws.company.name, message, now);
  const sent = await sendPackage({
    client, service: r.service, build: (tag, room) => handOverFile(prepared, tag, room),
    start: async (bytes) => {
      const made = await client.update(id, keys.revokeToken, { bytes, meta });
      return { id, revokeToken: keys.revokeToken, ...(keys.returnToken ? { returnToken: keys.returnToken } : {}), ...(made.generation ? { generation: made.generation } : {}) };
    },
    progress: opts.progress,
  });
  const version = prepared.commit();
  let next = changeShare(ws, id, (x) => {
    x.version = version.n; x.bytes = sent.status.bytes; x.files = prepared.files.size; x.updatedAt = now.toISOString(); x.state = sent.status.state;
    if (sent.status.expiresAt) x.expiresAt = sent.status.expiresAt;
  }) ?? r;
  if (opts.notify) {
    // The note is a courtesy: a refusal (the day's mails, say) leaves the update done, and is said (notifyError).
    try {
      const done = await client.invite(id, keys.revokeToken, { kind: 'update', ...(message ? { message } : {}), language: languageOf(opts.language) });
      next = changeShare(ws, id, (x) => { x.notifiedAt = done.sentAt; x.invites = done.invites; delete x.notifyError; }) ?? next;
    } catch (e) {
      next = changeShare(ws, id, (x) => { x.notifyError = (e as Error).message.slice(0, 300); }) ?? next;
    }
  }
  return next;
}

/** The link of a share again («Link kopieren» later). */
export async function linkFor(ws: Workspace, id: string): Promise<string> {
  const r = readShares(ws).find((x) => x.id === id);
  if (!r) throw new ShareFlowError('Diesen Link kennt die App nicht (mehr).', 'shareUnknown');
  return linkOf(r.service, r.id);
}

/** «Zurückziehen»: the service deletes the share at once. A copy already opened stays where it was opened; its app says so the next time it checks. */
export async function revokeShare(ws: Workspace, id: string, now = new Date()): Promise<ShareRecord> {
  const r = readShares(ws).find((x) => x.id === id);
  const keys = r ? await keysOf(id) : undefined;
  if (!r || !keys) throw new ShareFlowError('Diesen Link kennt die App nicht (mehr).', 'shareUnknown');
  const status = await shareClient(r.service).revoke(id, keys.revokeToken);
  const next = changeShare(ws, id, (x) => { x.state = status.state; x.revokedAt = now.toISOString(); });
  await secrets.set(`share:${id}`, null);
  return next ?? r;
}

/** A share's returns are taken 30 days after it was made at the latest: no use asking much later. */
const ASK_DAYS = 45;

export interface Arrived { share: string; id: string; from: Party; changes: number; basedOn: number }

/**
 * Asks the service about every share still running (on opening the books and on demand): its
 * openings and its returns. A return that is ready is fetched (the service hands its key over to
 * the sharer's revoke token) and kept for review, like a `.vanilla` file opened by hand. Nothing is
 * taken over. Each share's facts are written by id as they arrive, never the list read before the waits.
 */
export function refreshShares(ws: Workspace, now = new Date(), client: (service: string) => ShareClient = shareClient): Promise<{ shares: ShareRecord[]; arrived: Arrived[] }> {
  return oneAtATime(ws, () => refreshNow(ws, now, client));
}

async function refreshNow(ws: Workspace, now = new Date(), client: (service: string) => ShareClient = shareClient): Promise<{ shares: ShareRecord[]; arrived: Arrived[] }> {
  const arrived: Arrived[] = [];
  for (const r of readShares(ws)) {
    if (r.revokedAt || r.state === 'gone' || now.getTime() - Date.parse(r.updatedAt ?? r.at) > ASK_DAYS * 86400_000) continue;
    const keys = await keysOf(r.id);
    if (!keys) continue;
    const c = client(r.service);
    try {
      const s = await c.status(r.id, keys.revokeToken);
      changeShare(ws, r.id, (x) => {
        x.state = s.state;
        x.opens = s.opens;
        if (s.firstOpenedAt) x.firstOpenedAt = s.firstOpenedAt;
        if (s.expiresAt) x.expiresAt = s.expiresAt;
        if (s.invite?.sentAt) { x.invitedAt = s.invite.sentAt; x.invites = s.invite.count; }
        delete x.error;
        for (const ret of s.returns) {
          const kept = x.returns.find((y) => y.id === ret.id);
          if (kept) { kept.state = ret.state; kept.bytes = ret.bytes; } else x.returns.push({ id: ret.id, state: ret.state, at: ret.createdAt, bytes: ret.bytes });
        }
        x.checkedAt = now.toISOString();
      });
      const received = new Set(r.returns.filter((x) => x.received).map((x) => x.id));
      for (const ret of s.returns) {
        // A large return waits at the service until she fetches it (fetchReturn): a check never fills the disk.
        if (received.has(ret.id) || ret.state !== 'ready' || ret.bytes > SHARE_LIMITS.returnFetchedAlone) continue;
        const got = await fetchOne(ws, r.id, ret.id, c, keys.revokeToken, now);
        if (got) arrived.push(got);
      }
    } catch (e) {
      changeShare(ws, r.id, (x) => {
        if (e instanceof ShareServiceError && e.code === 'notFound') x.state = 'gone';
        else x.error = (e as Error).message.slice(0, 300);
        x.checkedAt = now.toISOString();
      });
    }
  }
  return { shares: readShares(ws), arrived };
}

/** Fetches one return and keeps it for review; a failure is kept on the return as a fact. */
async function fetchOne(ws: Workspace, share: string, id: string, c: ShareClient, token: string, now: Date): Promise<Arrived | undefined> {
  try {
    const { bytes } = await receivePackage({ client: c, id, token, isReturn: true });
    const got = receiveReturn(ws, bytes, now);
    changeShare(ws, share, (x) => { const k = x.returns.find((y) => y.id === id); if (k) { k.received = got.id; delete k.error; } });
    return { share, ...got };
  } catch (e) {
    changeShare(ws, share, (x) => { const k = x.returns.find((y) => y.id === id); if (k) k.error = (e as Error).message.slice(0, 300); });
    return undefined;
  }
}

/**
 * «Holen»: a return larger than refreshShares fetches by itself (SHARE_LIMITS.returnFetchedAlone),
 * fetched now that the sharer asks for it, and kept for review.
 */
export function fetchReturn(ws: Workspace, share: string, id: string, now = new Date(), client: (service: string) => ShareClient = shareClient): Promise<{ record: ShareRecord; arrived?: Arrived }> {
  return oneAtATime(ws, async () => {
    const r = readShares(ws).find((x) => x.id === share);
    const keys = r ? await keysOf(share) : undefined;
    const ret = r?.returns.find((x) => x.id === id);
    if (!r || !keys || !ret) throw new ShareFlowError('Diesen Link kennt die App nicht (mehr).', 'shareUnknown');
    if (ret.received) return { record: r };
    const arrived = await fetchOne(ws, share, id, client(r.service), keys.revokeToken, now);
    const record = readShares(ws).find((x) => x.id === share) ?? r;
    if (!arrived) {
      const why = record.returns.find((x) => x.id === id)?.error ?? '';
      throw new ShareFlowError(`Die Rücksendung kam nicht an: ${why}`, 'shareReturnFailed', { why });
    }
    return { record, arrived };
  });
}

// ─── the recipient's copy ───────────────────────────────────────────────────

/** What a copy keeps of the share it came through (by link, or by a Freigabe-Datei naming it): where its return goes, which state of the share it holds, and whether the share is over. */
interface LinkFacts {
  service: string; id: string; returnToken?: string; at: string;
  /** The share's state of the books this copy holds (the service's generation) and when the sharer made it. */
  generation?: number; updatedAt?: string;
  /** The sharer withdrew the share (or the service no longer knows it): seen at this time. */
  withdrawnAt?: string;
}
const linkFile = (root: string) => join(root, dirname(DURCHSICHT_MARKER), 'link.json');

export function linkOfCopy(root: string): LinkFacts | undefined {
  const f = linkFile(root);
  if (!existsSync(f)) return undefined;
  try { return JSON.parse(readFileSync(f, 'utf8')) as LinkFacts; } catch { return undefined; }
}

function keepLinkFacts(root: string, facts: LinkFacts): void {
  mkdirSync(dirname(linkFile(root)), { recursive: true });
  writeFileSync(linkFile(root), JSON.stringify(facts, null, 2) + '\n', { mode: 0o600 });
  chmodSync(linkFile(root), 0o600);
}

/** Whether a return from this copy can go back through the service: a link's copy whose share is not withdrawn. */
export const canReturnByLink = (root: string): boolean => { const f = linkOfCopy(root); return !!f?.returnToken && !f.withdrawnAt; };

/** What a link holds, read without opening it: what the person confirms. */
export interface LinkPreview {
  service: string;
  host: string;
  /** The link names another service than this app's. */
  foreign: boolean;
  state: string;
  expiresAt?: string;
  /** The Freigabe-Datei's size, for «84 von 196 MB». */
  bytes?: number;
  /** From the share's envelope: who shares which books, as the link itself claims (whoever made it wrote it). */
  senderName?: string;
  company?: string;
  note?: string;
}

/** What a link holds: its service and its envelope's claims (the service hands the key to read it). */
export async function previewLink(text: string, opts: { client?: (service: string) => ShareClient } = {}): Promise<LinkPreview> {
  const link = parseLink(text);
  if (!link) throw new ShareFlowError('Das ist kein Link einer geteilten Buchhaltung.', 'shareLinkInvalid');
  const info = await (opts.client ?? shareClient)(link.service).info(link.id);
  const meta = info.meta && typeof info.meta === 'object' && typeof info.meta.senderName === 'string' ? info.meta : undefined;
  return {
    service: link.service, host: new URL(link.service).host, foreign: link.foreign, state: info.state,
    ...(info.expiresAt ? { expiresAt: info.expiresAt } : {}),
    ...(typeof info.bytes === 'number' ? { bytes: info.bytes } : {}),
    ...(meta ? { senderName: meta.senderName, ...(meta.company ? { company: meta.company } : {}), ...(meta.note ? { note: meta.note } : {}) } : {}),
  };
}

/**
 * Downloads a link's Freigabe-Datei (one opening, counted for the sharer's card) into `saveTo` (the
 * person's Downloads), with its progress: the same file the share's page downloads. A link naming
 * another service than this app's waits for the person (`trust`).
 */
export async function downloadShare(text: string, opts: { progress?: Progress; client?: (service: string) => ShareClient; trust?: boolean; saveTo?: string } = {}): Promise<{ bytes: Uint8Array; path?: string; filename: string; service: string; id: string }> {
  const link = parseLink(text);
  if (!link) throw new ShareFlowError('Das ist kein Link einer geteilten Buchhaltung.', 'shareLinkInvalid');
  const host = new URL(link.service).host;
  if (link.foreign && !opts.trust) throw new ShareFlowError(`Der Link führt zu ${host}, nicht zum Teil-Dienst dieser App.`, 'shareForeignService', { host });
  const got = await receivePackage({ client: (opts.client ?? shareClient)(link.service), id: link.id, progress: opts.progress, ...(opts.saveTo ? { saveTo: opts.saveTo } : {}) });
  return { ...got, service: link.service, id: link.id };
}

/**
 * Opens a link (pasted, or handed over by the system's `vanilla-accounting://`): its Freigabe-Datei
 * is downloaded into the person's Downloads, then opened as that file would be on a double-click
 * (openShareFile): a new copy, or an existing one moved forward with his changes kept; the copy's
 * document is the downloaded file. Waits for the person on a link naming another service than this
 * app's (`trust`) and on a copy of the firm that came from someone else (`copy`, shareCopyOther).
 * `into`: this copy and no other (checkCopy).
 */
export async function openLink(text: string, opts: { at?: string; progress?: Progress; now?: Date; client?: (service: string) => ShareClient; trust?: boolean; copy?: CopyChoice; into?: string; saveTo?: string } = {}): Promise<OpenedFile> {
  const got = await downloadShare(text, { ...opts, saveTo: opts.saveTo ?? downloadsDir() });
  return openShareFile(got.bytes, { ...(got.path ? { path: got.path } : {}), ...(opts.at ? { at: opts.at } : {}), ...(opts.now ? { now: opts.now } : {}), ...(opts.copy ? { copy: opts.copy } : {}), ...(opts.into ? { into: opts.into } : {}), trusted: got.service });
}

/** A Freigabe-Datei opened: the copy, and what came back of the changes he had saved into it. */
export interface OpenedFile extends Opened {
  /** His changes the file held (saved into it): put back into the copy; `stale` when they were saved on another state than the file's. */
  restored?: { applied: number; dropped: number; stale: boolean };
  /** The copy's document: the file it now saves into. */
  document?: string;
  /** The share the copy is linked to. */
  linked: boolean;
}

/**
 * Opens a Freigabe-Datei as the recipient's copy (the owner's decision of 2026-11-15: the file is
 * the document): openPackage, then the changes he saved into the file come back, and the file
 * becomes the copy's document (`path`; none for bytes without a file, from the browser). A file
 * naming a share of this app's service (or of `trusted`, the service the person just confirmed)
 * links the copy to it: «Zurückschicken» and «Aktualisieren» go through the share as by the link.
 * A file naming another service opens as a plain file: its return goes back as a file.
 */
export function openShareFile(bytes: Uint8Array, opts: { path?: string; now?: Date; at?: string; copy?: CopyChoice; into?: string; otherAsNew?: boolean; trusted?: string } = {}): OpenedFile {
  const p = readPackage(bytes);
  const now = opts.now ?? new Date();
  const tag = p.index.share;
  const linked = !!tag && (tag.service === shareService().url || tag.service === opts.trusted);
  const opened = openPackage(p, now, opts.at ?? durchsichtHome(), {
    ...(linked ? { link: { service: tag!.service, id: tag!.id } } : {}),
    ...(opts.copy ? { copy: opts.copy } : {}), ...(opts.into ? { root: opts.into } : {}), ...(opts.otherAsNew ? { otherAsNew: true } : {}),
  });
  if (linked) {
    // Written only once the copy is this share's (its own, or as the person answered).
    const had = linkOfCopy(opened.root);
    keepLinkFacts(opened.root, {
      service: tag!.service, id: tag!.id, ...(tag!.returnToken ? { returnToken: tag!.returnToken } : {}),
      generation: tag!.generation, at: now.toISOString(), ...(had?.id === tag!.id && had.updatedAt ? { updatedAt: had.updatedAt } : {}),
    });
  }
  const restored = p.saved ? restoreSaved(opened.root, p.saved) : undefined;
  if (opts.path) attachDocument(opened.root, opts.path, bytes, restored && !restored.stale ? p.saved : undefined, now);
  return { ...opened, ...(restored ? { restored } : {}), ...(opts.path ? { document: opts.path } : {}), linked };
}

/**
 * A Freigabe-Datei the sharer made herself, of books open here: her own hand-over (a version her
 * books wrote, of this firm). With his changes saved into it (mailed back), they are a return for
 * review, never a new copy of her own books; without, there is nothing to open.
 */
export function ownHandOver(ws: Pick<Workspace, 'paths' | 'company'> | undefined, p: PackageContents): boolean {
  if (!ws || isDurchsicht(ws.paths.root) || p.index.kind === 'return') return false;
  const uid = ws.company.uid;
  const sameFirm = uid && p.index.firm.uid ? uid === p.index.firm.uid : p.index.firm.name === ws.company.name;
  return sameFirm && readVersions(ws.paths).some((v) => v.n === p.index.version.n && v.checksum === p.index.version.checksum);
}

/** Her own hand-over opened in her books: his saved changes kept for review as a return, or a refusal in words. */
export function receiveOwnHandOver(ws: Workspace, p: PackageContents, now = new Date()): { id: string; from: Party; changes: number; basedOn: number } {
  if (!p.saved) throw new PackageError(`Diese Freigabe-Datei ist deine eigene Übergabe (Version ${p.index.version.n}) und enthält keine Änderungen von ${p.index.to.name}.`, 'shareOwnBooks', { version: String(p.index.version.n), name: p.index.to.name });
  return receiveReturn(ws, p.saved, now);
}

/** What a copy's check of its share found (`checkCopy`). */
export type CopyCheck =
  | { state: 'none' | 'current' }
  | { state: 'updated'; at: string; name: string; conflicts: number; dropped: number; carried: number; file?: string }
  | { state: 'withdrawn'; at: string; name: string };

/**
 * A copy that came by link asks its share whenever it opens: a newer state the sharer put there
 * («Aktualisieren») is fetched and moves the copy forward, his changes kept (conflicts as with any
 * hand-over); a share she withdrew, or one the service no longer knows, is noted on the copy, which
 * stays as it is: his return then goes as a file. No network, no answer: the copy stays as it is.
 */
export async function checkCopy(root: string, opts: { now?: Date; client?: (service: string) => ShareClient; saveTo?: string } = {}): Promise<CopyCheck> {
  const facts = linkOfCopy(root);
  const marker = markerOf(root);
  if (!facts || !marker || !isDurchsicht(root)) return { state: 'none' };
  const name = marker.sharer.name;
  if (facts.withdrawnAt) return { state: 'withdrawn', at: facts.withdrawnAt, name };
  const client = (opts.client ?? shareClient)(facts.service);
  const now = opts.now ?? new Date();
  let info;
  try { info = await client.info(facts.id); } catch (e) {
    if (!(e instanceof ShareServiceError && e.code === 'notFound')) return { state: 'current' };
    info = { state: 'revoked' } as const;
  }
  if (info.state === 'revoked') {
    keepLinkFacts(root, { ...facts, withdrawnAt: now.toISOString() });
    return { state: 'withdrawn', at: now.toISOString(), name };
  }
  const generation = 'generation' in info && typeof info.generation === 'number' ? info.generation : 1;
  if (info.state !== 'ready' || generation <= (facts.generation ?? 1)) return { state: 'current' };
  // Into this copy: a newer state never opens a second copy beside it (the firm's name changed, say); another firm is refused.
  // The new Freigabe-Datei lands in Downloads and becomes the copy's document; the older file stays as it was.
  const opened = await openLink(linkOf(facts.service, facts.id), { at: dirname(root), into: root, now, client: opts.client, trust: true, ...(opts.saveTo ? { saveTo: opts.saveTo } : {}) });
  keepLinkFacts(opened.root, { ...linkOfCopy(opened.root)!, ...('updatedAt' in info && info.updatedAt ? { updatedAt: info.updatedAt } : {}) });
  const at = linkOfCopy(opened.root)?.updatedAt ?? now.toISOString();
  return { state: 'updated', at, name, conflicts: opened.conflicts, dropped: opened.dropped, carried: opened.carried, ...(opened.document ? { file: basename(opened.document) } : {}) };
}

/**
 * «Kopie löschen» on a copy whose share was withdrawn: the copy's folder goes, with his changes
 * that were not sent back. Only on a copy, never on books of one's own.
 */
export function deleteCopy(root: string): void {
  if (!isDurchsicht(root) || !markerOf(root)) throw new ShareFlowError('Löschen geht nur bei einer Kopie zur Durchsicht.', 'shareNotCopy');
  rmSync(root, { recursive: true, force: true });
}

export interface Returned { id: string; changes: number; files: number; bytes: number; to: Party }

/**
 * «Zurückschicken» on a copy that came by link: the return package, sealed under a new key that the
 * service keeps for the sharer, uploaded into the same share. A failure leaves the copy as it was
 * (no «zurückgeschickt» noted).
 */
export async function returnByLink(ws: Workspace, message: string | undefined, opts: { progress?: Progress; now?: Date; client?: (service: string) => ShareClient } = {}): Promise<Returned> {
  const facts = linkOfCopy(ws.paths.root);
  if (!facts?.returnToken) throw new ShareFlowError('Diese Kopie kam nicht über einen Link: die Änderungen gehen als Datei (.vanilla) zurück.', 'shareNoLink');
  if (facts.withdrawnAt) throw new ShareFlowError('Die Freigabe ist zurückgezogen: die Änderungen gehen als Datei (.vanilla) zurück.', 'shareWithdrawn');
  const markerPath = join(ws.paths.root, DURCHSICHT_MARKER);
  const markerBefore = readFileSync(markerPath);
  const marker = markerOf(ws.paths.root)!;
  try {
    const made = buildReturn(ws, message, opts.now);
    const c = (opts.client ?? shareClient)(facts.service);
    const meta = envelope(marker.me.name, 'return', marker.firm.name, made.index.message, opts.now ?? new Date());
    const sent = await sendPackage({
      client: c, build: () => ({ bytes: made.bytes }), isReturn: true,
      start: (bytes) => c.createReturn(facts.id, facts.returnToken!, { bytes, meta }),
      progress: opts.progress,
    });
    return { id: sent.id, changes: made.index.changes ?? 0, files: made.index.files.length, bytes: sent.status.bytes, to: marker.sharer };
  } catch (e) {
    writeFileSync(markerPath, markerBefore);
    if (e instanceof ShareServiceError && (e.code === 'revoked' || e.code === 'notFound')) {
      keepLinkFacts(ws.paths.root, { ...facts, withdrawnAt: new Date().toISOString() });
      throw new ShareFlowError('Die Freigabe ist zurückgezogen: die Änderungen gehen als Datei (.vanilla) zurück.', 'shareWithdrawn');
    }
    throw e;
  }
}
