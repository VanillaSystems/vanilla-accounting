/**
 * Sharing the books by link (docs/specs/e2e-and-fiduciary.md B3, ADR 0016): the hand-over package
 * of src/handover/ sealed file by file under a key that stays in the link's fragment, uploaded to
 * the share service, and the invitation sent from the sharer's own mailbox. The recipient's app
 * opens the link as a Durchsicht copy and sends its return into the same share; the sharer's app
 * fetches it and keeps it for review. Nothing reaches the books before the sharer takes it over.
 *
 * Kept where: the shares' facts (id, recipient, version, state) in handover/shares.json of the
 * books; each share's key and revoke token in the secret store (src/secrets/), never in the books,
 * which are often a repository; this computer's confirmed sender in the secret store too. A copy
 * keeps its link (service, id, key, return token) in its own data/durchsicht/, which lives in the
 * app's folder and travels nowhere.
 *
 * A link is someone else's data until the person says otherwise (review of PR #538): a link naming
 * another service than this app's, or one that would move an existing copy to another sharer or
 * service, opens only when the person confirmed it, after seeing whose books, from whom and through
 * which service (`previewLink`).
 *
 * The `.vanilla` file stays the way for every step without the service (B3.7).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { secrets } from '../secrets/secrets.js';
import { sendText, sendingAddress } from '../invoices/mail.js';
import type { Workspace } from '../workspace/workspace.js';
import { prepareShare, HANDOVER_DIR, type ShareRequest } from '../handover/share.js';
import { readPackage, writePackage } from '../handover/package.js';
import { buildReturn, copyRootOf, durchsichtHome, markerOf, openPackage, type Opened } from '../handover/durchsicht.js';
import { receiveReturn } from '../handover/returns.js';
import { DURCHSICHT_MARKER } from '../handover/content.js';
import type { Party } from '../handover/versions.js';
import { shareClient, ShareServiceError, type ShareClient } from './client.js';
import { decodeKey, decryptMeta, encodeKey, encryptMeta, generateKey, unwrapKey, wrapKey } from './crypto/index.js';
import { renderInvitation, type Invitation } from './invitation.js';
import { linkOf, parseLink, shareService } from './service.js';
import { receivePackage, sendPackage, type Progress } from './transport.js';

/** A step of the flow refused before or beside the service: the UI says it by its code. */
export type ShareFlowRefusal =
  | 'shareNoService' | 'shareNoSecretStore' | 'shareSenderMissing' | 'shareSenderUnconfirmed' | 'shareLinkInvalid' | 'shareNoLink' | 'shareUnknown'
  | 'shareForeignService' | 'shareCopyOther' | 'shareConfirmationOdd';

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
  if (!secrets.inApp()) throw new ShareFlowError('Diese App kann den Schlüssel des Links hier nicht sicher aufbewahren: die Buchhaltung geht als Datei (.vanilla).', 'shareNoSecretStore');
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

/** The subject the service's inbound address reads (its docs/api.md); nothing else goes out from her mailbox. */
const CONFIRM_SUBJECT = /^Vanilla Accounting confirmation [A-Za-z0-9]{8,64}$/;

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
  /** When the app sent the invitation from the books' mailbox. */
  mailed?: string;
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
const updateShare = (ws: Pick<Workspace, 'paths'>, id: string, fn: (r: ShareRecord) => void): ShareRecord | undefined => {
  let out: ShareRecord | undefined;
  updateShares(ws, (all) => all.map((r) => { if (r.id !== id) return r; const c = structuredClone(r); fn(c); out = c; return c; }));
  return out;
};

/**
 * The versions handed over by link that never reached their person: no opening at the service.
 * The next share to that person builds on none of them (a full package after a link withdrawn or
 * ended unopened; versions.ts heldBy).
 */
export const unopenedVersions = (ws: Pick<Workspace, 'paths'>): number[] =>
  readShares(ws).filter((r) => !r.opens.length && !r.returns.some((x) => x.received)).map((r) => r.version);

interface ShareKeys { key: string; revokeToken: string }
const keysOf = async (id: string): Promise<ShareKeys | undefined> => {
  const raw = await secrets.get(`share:${id}`);
  return raw ? (JSON.parse(raw) as ShareKeys) : undefined;
};

export interface Shared { record: ShareRecord; link: string; invitation: Invitation; mailed: boolean; mailError?: string }

/**
 * The chain of hand-overs to one person (review of #538): a random token, made with the first link
 * to that person and carried, encrypted, in every link after it. Only the sharer's app and the
 * recipient's copy know it: a link from anyone else, even one naming the same firm and sharer,
 * cannot carry it, and moves no copy without the person's confirmation (openLink). Kept in the
 * secret store, never in the books.
 */
async function chainFor(to: Party): Promise<string> {
  const name = `share:chain:${(to.email ?? to.name).trim().toLowerCase()}` as const;
  const kept = await secrets.get(name);
  if (kept) return kept;
  const made = encodeKey(generateKey());
  await secrets.set(name, made);
  return made;
}

/** One share, and one check of the shares, of the same books at a time: two shares at once would both build on the same next version, two checks would fetch a return twice. */
const running = new Map<string, Promise<unknown>>();
function oneAtATime<T>(ws: Pick<Workspace, 'paths'>, fn: () => Promise<T>): Promise<T> {
  const key = ws.paths.root;
  const before = running.get(key) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(fn);
  running.set(key, next.catch(() => undefined));
  return next;
}

/**
 * «Teilen» by link: builds the next version's package, seals and uploads it, then writes the
 * version (only once the service holds it), keeps the share, and sends the invitation from the
 * books' mailbox when `mail` and the mailbox can send; else the person sends the link herself.
 * The person holds the version only once the link was opened (unopenedVersions).
 */
export function shareByLink(ws: Workspace, req: ShareRequest, from: Party, opts: { mail?: boolean; progress?: Progress; now?: Date; publisher?: string } = {}): Promise<Shared> {
  return oneAtATime(ws, () => shareNow(ws, req, from, opts));
}

async function shareNow(ws: Workspace, req: ShareRequest, from: Party, opts: { mail?: boolean; progress?: Progress; now?: Date; publisher?: string }): Promise<Shared> {
  needSecretStore();
  const service = serviceNow();
  const sender = await senderKept();
  if (!sender || sender.service !== service) throw new ShareFlowError('Zuerst die eigene E-Mail-Adresse bestätigen.', 'shareSenderMissing');
  const client = shareClient(service);
  const me = await client.sender(sender.token);
  if (!me.confirmed) throw new ShareFlowError(`${sender.email} ist noch nicht bestätigt.`, 'shareSenderUnconfirmed', { email: sender.email });
  // Whether the earlier links were opened decides between a full package and an update.
  await refreshNow(ws).catch(() => undefined);
  const now = opts.now ?? new Date();
  const prepared = await prepareShare(ws, { ...req, notHeld: [...(req.notHeld ?? []), ...unopenedVersions(ws)] }, from, now);
  prepared.index.chain = await chainFor(req.to);
  const key = generateKey();
  const message = prepared.index.message;
  const meta = await encryptMeta(key, { v: 1, senderName: from.name, direction: 'send', company: ws.company.name, ...(message ? { note: message.slice(0, 1000) } : {}), asOf: now.toISOString().slice(0, 10) });
  const sent = await sendPackage({
    client, key, out: { index: prepared.index, files: prepared.files }, carriesReturnToken: true,
    start: (s) => client.create(sender.token, { ...s, meta }),
    progress: opts.progress,
  });
  // The link is made here from the service and the id; the key goes only into the fragment.
  const link = linkOf(`${service}/${sent.id}`, encodeKey(key));
  const expiresAt = sent.status.expiresAt ?? new Date(now.getTime() + 10 * 86400_000).toISOString();
  let version;
  let invitation: Invitation;
  try {
    invitation = renderInvitation({
      senderName: from.name, link, expiresAt: new Date(expiresAt),
      company: ws.company.name, ...(message ? { message } : {}), ...(opts.publisher ? { publisher: opts.publisher } : {}),
    });
    await secrets.set(`share:${sent.id}`, JSON.stringify({ key: encodeKey(key), revokeToken: sent.revokeToken } satisfies ShareKeys));
    // Written only now, with the service holding the package.
    version = prepared.commit();
  } catch (e) {
    // A share the books keep no version of (another version written meanwhile): gone at the service, its key dropped.
    await client.revoke(sent.id, sent.revokeToken).catch(() => undefined);
    await secrets.set(`share:${sent.id}`, null).catch(() => undefined);
    throw e;
  }
  const record: ShareRecord = {
    id: sent.id, service, to: req.to, version: version.n, kind: prepared.index.kind as 'full' | 'update',
    bytes: sent.status.bytes, files: prepared.files.size, at: now.toISOString(), state: sent.status.state, expiresAt, opens: [], returns: [],
  };
  let mailed = false;
  let mailError: string | undefined;
  if (opts.mail && req.to.email && sendingAddress(ws)) {
    try {
      await sendText(ws, { to: req.to.email, subject: invitation.subject, body: invitation.text, html: invitation.html });
      mailed = true;
      record.mailed = new Date().toISOString();
    } catch (e) { mailError = (e as Error).message; }
  }
  updateShares(ws, (all) => [record, ...all.filter((r) => r.id !== record.id)]);
  return { record, link, invitation, mailed, ...(mailError ? { mailError } : {}) };
}

/** The link of a share again («Link kopieren» later), while its key is kept. */
export async function linkFor(ws: Workspace, id: string): Promise<string> {
  const r = readShares(ws).find((x) => x.id === id);
  const keys = r ? await keysOf(id) : undefined;
  if (!r || !keys) throw new ShareFlowError('Diesen Link kennt die App nicht (mehr).', 'shareUnknown');
  return linkOf(`${r.service}/${r.id}`, keys.key);
}

/** «Zurückziehen»: the service deletes the share at once. A copy already opened stays where it was opened. */
export async function revokeShare(ws: Workspace, id: string, now = new Date()): Promise<ShareRecord> {
  const r = readShares(ws).find((x) => x.id === id);
  const keys = r ? await keysOf(id) : undefined;
  if (!r || !keys) throw new ShareFlowError('Diesen Link kennt die App nicht (mehr).', 'shareUnknown');
  const status = await shareClient(r.service).revoke(id, keys.revokeToken);
  const next = updateShare(ws, id, (x) => { x.state = status.state; x.revokedAt = now.toISOString(); });
  await secrets.set(`share:${id}`, null);
  return next ?? r;
}

/** A share ends at the service 30 days after it was made at the latest (returns too): no use asking later. */
const ASK_DAYS = 31;

export interface Arrived { share: string; id: string; from: Party; changes: number; basedOn: number }

/**
 * Asks the service about every share still running (on opening the books and on demand): its
 * openings and its returns. A return that is ready is fetched, decrypted with the key from the
 * sharer's own link and kept for review, like a `.vanilla` file opened by hand. Nothing is taken over.
 * Each share's facts are written by id as they arrive, never the list read before the waits.
 */
export function refreshShares(ws: Workspace, now = new Date(), client: (service: string) => ShareClient = shareClient): Promise<{ shares: ShareRecord[]; arrived: Arrived[] }> {
  return oneAtATime(ws, () => refreshNow(ws, now, client));
}

async function refreshNow(ws: Workspace, now = new Date(), client: (service: string) => ShareClient = shareClient): Promise<{ shares: ShareRecord[]; arrived: Arrived[] }> {
  const arrived: Arrived[] = [];
  for (const r of readShares(ws)) {
    if (r.revokedAt || r.state === 'gone' || now.getTime() - Date.parse(r.at) > ASK_DAYS * 86400_000) continue;
    const keys = await keysOf(r.id);
    if (!keys) continue;
    const c = client(r.service);
    try {
      const s = await c.status(r.id, keys.revokeToken);
      updateShare(ws, r.id, (x) => {
        x.state = s.state;
        x.opens = s.opens;
        if (s.firstOpenedAt) x.firstOpenedAt = s.firstOpenedAt;
        if (s.expiresAt) x.expiresAt = s.expiresAt;
        delete x.error;
        for (const ret of s.returns) {
          const kept = x.returns.find((y) => y.id === ret.id);
          if (kept) { kept.state = ret.state; kept.bytes = ret.bytes; } else x.returns.push({ id: ret.id, state: ret.state, at: ret.createdAt, bytes: ret.bytes });
        }
        x.checkedAt = now.toISOString();
      });
      const received = new Set(r.returns.filter((x) => x.received).map((x) => x.id));
      for (const ret of s.returns) {
        if (received.has(ret.id) || ret.state !== 'ready' || !ret.wrappedKey) continue;
        try {
          const returnKey = await unwrapKey(decodeKey(keys.key), ret.wrappedKey, ret.id);
          const { contents } = await receivePackage({ client: c, id: ret.id, key: returnKey, token: keys.revokeToken });
          const got = receiveReturn(ws, writePackage(contents), now);
          updateShare(ws, r.id, (x) => { const k = x.returns.find((y) => y.id === ret.id); if (k) { k.received = got.id; delete k.error; } });
          arrived.push({ share: r.id, ...got });
        } catch (e) {
          updateShare(ws, r.id, (x) => { const k = x.returns.find((y) => y.id === ret.id); if (k) k.error = (e as Error).message.slice(0, 300); });
        }
      }
    } catch (e) {
      updateShare(ws, r.id, (x) => {
        if (e instanceof ShareServiceError && e.code === 'notFound') x.state = 'gone';
        else x.error = (e as Error).message.slice(0, 300);
        x.checkedAt = now.toISOString();
      });
    }
  }
  return { shares: readShares(ws), arrived };
}

// ─── the recipient's copy ───────────────────────────────────────────────────

/** What a copy keeps of the link it came by: where its return goes. */
interface LinkFacts { service: string; id: string; key: string; returnToken?: string; /** The chain token of the hand-overs this copy belongs to (chainFor). */ chain?: string; at: string }
const linkFile = (root: string) => join(root, dirname(DURCHSICHT_MARKER), 'link.json');

export function linkOfCopy(root: string): LinkFacts | undefined {
  const f = linkFile(root);
  if (!existsSync(f)) return undefined;
  try { return JSON.parse(readFileSync(f, 'utf8')) as LinkFacts; } catch { return undefined; }
}

/** Whether a return from this copy can go back through the service. */
export const canReturnByLink = (root: string): boolean => !!linkOfCopy(root)?.returnToken;

/** What a link holds, read without opening it (no opening is spent): what the person confirms. */
export interface LinkPreview {
  service: string;
  host: string;
  /** The link names another service than this app's. */
  foreign: boolean;
  state: string;
  expiresAt?: string;
  /** From the share's encrypted envelope: who shares which books, as the link itself claims (whoever made it wrote it). */
  senderName?: string;
  company?: string;
  note?: string;
}

/**
 * What a link holds, without spending an opening: its service and its envelope's claims. Whether it
 * would move a copy here is not guessed from those claims; openLink decides it from the package.
 */
export async function previewLink(text: string, opts: { client?: (service: string) => ShareClient } = {}): Promise<LinkPreview> {
  const link = parseLink(text);
  if (!link) throw new ShareFlowError('Das ist kein Link einer geteilten Buchhaltung.', 'shareLinkInvalid');
  const info = await (opts.client ?? shareClient)(link.service).info(link.id);
  let meta: Awaited<ReturnType<typeof decryptMeta>> | undefined;
  try { meta = info.meta ? await decryptMeta(decodeKey(link.key), info.meta) : undefined; } catch { meta = undefined; }
  return {
    service: link.service, host: new URL(link.service).host, foreign: link.foreign, state: info.state,
    ...(info.expiresAt ? { expiresAt: info.expiresAt } : {}),
    ...(meta ? { senderName: meta.senderName, ...(meta.company ? { company: meta.company } : {}), ...(meta.note ? { note: meta.note } : {}) } : {}),
  };
}

/**
 * A link's download, kept a while after a refusal that waits for the person (shareCopyOther): her
 * «Öffnen» opens it from here, so the question spends no second opening of the link.
 */
const downloaded = new Map<string, { at: number; got: Awaited<ReturnType<typeof receivePackage>> }>();
const KEEP_MS = 15 * 60_000;

/**
 * Opens a link (pasted, or handed over by the system's `vanilla-accounting://`): one opening at the
 * service, every file decrypted and checked, then the package opened as a Durchsicht copy through
 * the hand-over code, exactly as the `.vanilla` file would be.
 *
 * Refused unless the person confirmed it (and then nothing is written, neither the copy nor its link):
 * - a link naming another service than this app's (`trust`);
 * - a link whose package would move an existing copy (the copy of its firm, by the package's UID)
 *   without carrying that copy's chain token (`replace`). The package's names and firm are whatever
 *   its maker wrote; only the chain token, which the copy got with its first link and only that
 *   sharer's app knows, shows that it continues the same hand-overs.
 */
export async function openLink(text: string, opts: { at?: string; progress?: Progress; now?: Date; client?: (service: string) => ShareClient; trust?: boolean; replace?: boolean } = {}): Promise<Opened> {
  const link = parseLink(text);
  if (!link) throw new ShareFlowError('Das ist kein Link einer geteilten Buchhaltung.', 'shareLinkInvalid');
  const host = new URL(link.service).host;
  if (link.foreign && !opts.trust) throw new ShareFlowError(`Der Link führt zu ${host}, nicht zum Teil-Dienst dieser App.`, 'shareForeignService', { host });
  const at = opts.at ?? durchsichtHome();
  const stash = `${link.service}/${link.id}#${link.key}`;
  for (const [k, v] of downloaded) if (Date.now() - v.at > KEEP_MS) downloaded.delete(k);
  const got = downloaded.get(stash)?.got ?? await receivePackage({ client: (opts.client ?? shareClient)(link.service), id: link.id, key: decodeKey(link.key), progress: opts.progress });
  downloaded.delete(stash);
  const { contents, index } = got;
  const root = copyRootOf(contents.index, at);
  const had = markerOf(root);
  const chain = linkOfCopy(root)?.chain;
  if (had && !opts.replace && (!chain || contents.index.chain !== chain)) {
    downloaded.set(stash, { at: Date.now(), got });
    const claimed = contents.index.from.name.slice(0, 120);
    throw new ShareFlowError(`Hier liegt schon eine Kopie von ${had.firm.name} (Version ${had.version.n}, von ${had.sharer.name}). Dieser Link gehört nicht zu ihren Übergaben; laut Link ist er von ${claimed} über ${host}.`, 'shareCopyOther', {
      firm: had.firm.name, version: String(had.version.n), was: had.sharer.name, now: claimed, claimed: contents.index.firm.name.slice(0, 120), host,
    });
  }
  const opened = openPackage(contents, opts.now ?? new Date(), at);
  const kept: LinkFacts = {
    service: link.service, id: link.id, key: link.key, ...(index.returnToken ? { returnToken: index.returnToken } : {}),
    ...(contents.index.chain ? { chain: contents.index.chain } : {}), at: (opts.now ?? new Date()).toISOString(),
  };
  mkdirSync(dirname(linkFile(opened.root)), { recursive: true });
  writeFileSync(linkFile(opened.root), JSON.stringify(kept, null, 2) + '\n', { mode: 0o600 });
  chmodSync(linkFile(opened.root), 0o600);
  return opened;
}

export interface Returned { id: string; changes: number; files: number; bytes: number; to: Party }

/**
 * «Zurückschicken» on a copy that came by link: the return package, sealed under a new key, uploaded
 * into the same share; its key goes along sealed under the share's key and bound to the return's id.
 * A failure leaves the copy as it was (no «zurückgeschickt» noted).
 */
export async function returnByLink(ws: Workspace, message: string | undefined, opts: { progress?: Progress; now?: Date; client?: (service: string) => ShareClient } = {}): Promise<Returned> {
  const facts = linkOfCopy(ws.paths.root);
  if (!facts?.returnToken) throw new ShareFlowError('Diese Kopie kam nicht über einen Link: die Änderungen gehen als Datei (.vanilla) zurück.', 'shareNoLink');
  const markerPath = join(ws.paths.root, DURCHSICHT_MARKER);
  const markerBefore = readFileSync(markerPath);
  const marker = markerOf(ws.paths.root)!;
  try {
    const made = buildReturn(ws, message, opts.now);
    const p = readPackage(made.bytes);
    const returnKey = generateKey();
    const shareKey = decodeKey(facts.key);
    const c = (opts.client ?? shareClient)(facts.service);
    const meta = await encryptMeta(returnKey, { v: 1, senderName: marker.me.name, direction: 'return', company: marker.firm.name, ...(p.index.message ? { note: p.index.message.slice(0, 1000) } : {}) });
    const sent = await sendPackage({
      client: c, key: returnKey, out: { index: p.index, files: p.files, changes: p.changes }, carriesReturnToken: false,
      start: (s) => c.createReturn(facts.id, facts.returnToken!, { ...s, meta }),
      finish: async (id) => ({ wrappedKey: await wrapKey(shareKey, returnKey, id) }),
      progress: opts.progress,
    });
    return { id: sent.id, changes: p.changes?.length ?? 0, files: p.files.size, bytes: sent.status.bytes, to: marker.sharer };
  } catch (e) {
    writeFileSync(markerPath, markerBefore);
    throw e;
  }
}
