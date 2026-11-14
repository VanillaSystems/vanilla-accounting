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
 * The `.vanilla` file stays the way for every step without the service (B3.7).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { secrets } from '../secrets/secrets.js';
import { sendText, sendingAddress } from '../invoices/mail.js';
import type { Workspace } from '../workspace/workspace.js';
import { prepareShare, HANDOVER_DIR, type ShareRequest } from '../handover/share.js';
import { readPackage } from '../handover/package.js';
import { buildReturn, durchsichtHome, markerOf, openPackage, type Opened } from '../handover/durchsicht.js';
import { receiveReturn } from '../handover/returns.js';
import { DURCHSICHT_MARKER } from '../handover/content.js';
import type { Party } from '../handover/versions.js';
import { shareClient, ShareServiceError, type ShareClient } from './client.js';
import { decodeKey, encodeKey, encryptMeta, generateKey, unwrapKey, wrapKey } from './crypto/index.js';
import { renderInvitation, type Invitation } from './invitation.js';
import { linkOf, parseLink, shareService } from './service.js';
import { receivePackage, sendPackage, type Progress } from './transport.js';

/** A step of the flow refused before or beside the service: the UI says it by its code. */
export type ShareFlowRefusal = 'shareNoService' | 'shareNoSecretStore' | 'shareSenderMissing' | 'shareSenderUnconfirmed' | 'shareLinkInvalid' | 'shareNoLink' | 'shareUnknown';

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
  const out: Registered = { email: email.trim(), confirmed: reg.confirmed, confirmation: reg.confirmation, mailed: false, confirmationExpiresAt: reg.confirmation.expiresAt };
  if (!reg.confirmed && sendingAddress(ws)?.toLowerCase() === email.trim().toLowerCase()) {
    try {
      await sendText(ws, { to: reg.confirmation.to, subject: reg.confirmation.subject, body: reg.confirmation.text });
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

function writeShares(ws: Pick<Workspace, 'paths'>, shares: ShareRecord[]): void {
  mkdirSync(dirname(sharesFile(ws)), { recursive: true });
  writeFileSync(sharesFile(ws), JSON.stringify({ schema: 1, shares }, null, 1) + '\n');
}

interface ShareKeys { key: string; revokeToken: string }
const keysOf = async (id: string): Promise<ShareKeys | undefined> => {
  const raw = await secrets.get(`share:${id}`);
  return raw ? (JSON.parse(raw) as ShareKeys) : undefined;
};

export interface Shared { record: ShareRecord; link: string; invitation: Invitation; mailed: boolean; mailError?: string }

/**
 * «Teilen» by link: builds the next version's package, seals and uploads it, then writes the
 * version (only once the service holds it), keeps the share, and sends the invitation from the
 * books' mailbox when `mail` and the mailbox can send; else the person sends the link herself.
 */
export async function shareByLink(ws: Workspace, req: ShareRequest, from: Party, opts: { mail?: boolean; progress?: Progress; now?: Date; publisher?: string } = {}): Promise<Shared> {
  needSecretStore();
  const service = serviceNow();
  const sender = await senderKept();
  if (!sender || sender.service !== service) throw new ShareFlowError('Zuerst die eigene E-Mail-Adresse bestätigen.', 'shareSenderMissing');
  const client = shareClient(service);
  const me = await client.sender(sender.token);
  if (!me.confirmed) throw new ShareFlowError(`${sender.email} ist noch nicht bestätigt.`, 'shareSenderUnconfirmed', { email: sender.email });
  const now = opts.now ?? new Date();
  const prepared = await prepareShare(ws, req, from, now);
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
  const invitation = renderInvitation({
    senderName: from.name, link, expiresAt: new Date(expiresAt),
    company: ws.company.name, ...(message ? { message } : {}), ...(opts.publisher ? { publisher: opts.publisher } : {}),
  });
  await secrets.set(`share:${sent.id}`, JSON.stringify({ key: encodeKey(key), revokeToken: sent.revokeToken } satisfies ShareKeys));
  // Written only now, with the service holding the package: the version the person is then known to hold.
  const version = prepared.commit();
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
  writeShares(ws, [record, ...readShares(ws)]);
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
  const all = readShares(ws);
  const r = all.find((x) => x.id === id);
  const keys = r ? await keysOf(id) : undefined;
  if (!r || !keys) throw new ShareFlowError('Diesen Link kennt die App nicht (mehr).', 'shareUnknown');
  const status = await shareClient(r.service).revoke(id, keys.revokeToken);
  r.state = status.state;
  r.revokedAt = now.toISOString();
  writeShares(ws, all);
  await secrets.set(`share:${id}`, null);
  return r;
}

/** A share ends at the service 30 days after it was made at the latest (returns too): no use asking later. */
const ASK_DAYS = 31;

export interface Arrived { share: string; id: string; from: Party; changes: number; basedOn: number }

/**
 * Asks the service about every share still running (on opening the books and on demand): its
 * openings and its returns. A return that is ready is fetched, decrypted with the key from the
 * sharer's own link and kept for review, like a `.vanilla` file opened by hand. Nothing is taken over.
 */
export async function refreshShares(ws: Workspace, now = new Date(), client: (service: string) => ShareClient = shareClient): Promise<{ shares: ShareRecord[]; arrived: Arrived[] }> {
  const all = readShares(ws);
  const arrived: Arrived[] = [];
  for (const r of all) {
    if (r.revokedAt || r.state === 'gone' || now.getTime() - Date.parse(r.at) > ASK_DAYS * 86400_000) continue;
    const keys = await keysOf(r.id);
    if (!keys) continue;
    const c = client(r.service);
    try {
      const s = await c.status(r.id, keys.revokeToken);
      r.state = s.state;
      r.opens = s.opens;
      if (s.firstOpenedAt) r.firstOpenedAt = s.firstOpenedAt;
      if (s.expiresAt) r.expiresAt = s.expiresAt;
      delete r.error;
      for (const ret of s.returns) {
        const kept = r.returns.find((x) => x.id === ret.id) ?? (r.returns.push({ id: ret.id, state: ret.state, at: ret.createdAt, bytes: ret.bytes }), r.returns.at(-1)!);
        kept.state = ret.state;
        kept.bytes = ret.bytes;
        if (kept.received || ret.state !== 'ready' || !ret.wrappedKey) continue;
        try {
          const returnKey = await unwrapKey(decodeKey(keys.key), ret.wrappedKey, ret.id);
          const { bytes } = await receivePackage({ client: c, id: ret.id, key: returnKey, token: keys.revokeToken });
          const got = receiveReturn(ws, bytes, now);
          kept.received = got.id;
          delete kept.error;
          arrived.push({ share: r.id, ...got });
        } catch (e) { kept.error = (e as Error).message.slice(0, 300); }
      }
    } catch (e) {
      if (e instanceof ShareServiceError && e.code === 'notFound') r.state = 'gone';
      else r.error = (e as Error).message.slice(0, 300);
    }
    r.checkedAt = now.toISOString();
  }
  writeShares(ws, all);
  return { shares: all, arrived };
}

// ─── the recipient's copy ───────────────────────────────────────────────────

/** What a copy keeps of the link it came by: where its return goes. */
interface LinkFacts { service: string; id: string; key: string; returnToken?: string; at: string }
const linkFile = (root: string) => join(root, dirname(DURCHSICHT_MARKER), 'link.json');

export function linkOfCopy(root: string): LinkFacts | undefined {
  const f = linkFile(root);
  if (!existsSync(f)) return undefined;
  try { return JSON.parse(readFileSync(f, 'utf8')) as LinkFacts; } catch { return undefined; }
}

/** Whether a return from this copy can go back through the service. */
export const canReturnByLink = (root: string): boolean => !!linkOfCopy(root)?.returnToken;

/**
 * Opens a link (pasted, or handed over by the system's `vanilla-accounting://`): one opening at the
 * service, every file decrypted and checked, then the package opened as a Durchsicht copy through
 * the hand-over code, exactly as the `.vanilla` file would be.
 */
export async function openLink(text: string, opts: { at?: string; progress?: Progress; now?: Date; client?: (service: string) => ShareClient } = {}): Promise<Opened> {
  const link = parseLink(text);
  if (!link) throw new ShareFlowError('Das ist kein Link einer geteilten Buchhaltung.', 'shareLinkInvalid');
  const c = (opts.client ?? shareClient)(link.service);
  const { bytes, index } = await receivePackage({ client: c, id: link.id, key: decodeKey(link.key), progress: opts.progress });
  const opened = openPackage(bytes, opts.now ?? new Date(), opts.at ?? durchsichtHome());
  const facts: LinkFacts = { service: link.service, id: link.id, key: link.key, ...(index.returnToken ? { returnToken: index.returnToken } : {}), at: (opts.now ?? new Date()).toISOString() };
  mkdirSync(dirname(linkFile(opened.root)), { recursive: true });
  writeFileSync(linkFile(opened.root), JSON.stringify(facts, null, 2) + '\n', { mode: 0o600 });
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
