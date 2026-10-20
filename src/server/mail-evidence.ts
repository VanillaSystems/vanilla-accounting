/**
 * What the app can see by itself about how the person handles mail, so the setup AI finds out
 * before it proposes (processes/receipt-collection.guide.yaml#setup, docs/personas/README.md «Find
 * out first, then propose what fits»): the computer, the mail programs on a Mac and the one macOS
 * opens for an e-mail link, the company's mail domains with their provider, and how receipts came
 * in so far. Read-only and cheap: no mail is opened, no program is asked (macOS asks nothing), and
 * receipts give only counts and domains, never an address or a text.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolveMx } from 'node:dns/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Receipt } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { APP_ROOT } from '../workspace/workspace.js';
import { sources } from '../platform/sources/index.js';
import { readLedger, type LedgerLine } from '../platform/sources/ledger.js';
import { domainOf, lookupMailHost, mailHostOf } from '../platform/sources/mail-host.js';
import { capturedDay } from '../intake/captured.js';

export type Os = 'macos' | 'windows' | 'linux' | 'other';
type AppKind = 'mail' | 'browser';

/** A program known by its bundle: the mail programs people use on a Mac, and the browsers a webmail sets as the mail program. */
interface KnownApp { name: string; kind: AppKind; bundleIds: string[]; apps: string[] }

const MAC_APPS: readonly KnownApp[] = [
  { name: 'Apple Mail', kind: 'mail', bundleIds: ['com.apple.mail'], apps: ['Mail.app'] },
  { name: 'Microsoft Outlook', kind: 'mail', bundleIds: ['com.microsoft.outlook'], apps: ['Microsoft Outlook.app'] },
  { name: 'Thunderbird', kind: 'mail', bundleIds: ['org.mozilla.thunderbird'], apps: ['Thunderbird.app'] },
  { name: 'Spark', kind: 'mail', bundleIds: ['com.readdle.sparkdesktop', 'com.readdle.smartemail-mac'], apps: ['Spark Desktop.app', 'Spark.app'] },
  { name: 'Airmail', kind: 'mail', bundleIds: ['it.bloop.airmail2'], apps: ['Airmail 5.app', 'Airmail 4.app'] },
  { name: 'Mimestream', kind: 'mail', bundleIds: ['com.mimestream.mimestream'], apps: ['Mimestream.app'] },
  { name: 'Canary Mail', kind: 'mail', bundleIds: ['io.canarymail.mac'], apps: ['Canary Mail.app'] },
  { name: 'Postbox', kind: 'mail', bundleIds: ['com.postbox-inc.postbox'], apps: ['Postbox.app'] },
  { name: 'MailMate', kind: 'mail', bundleIds: ['com.freron.mailmate'], apps: ['MailMate.app'] },
  { name: 'eM Client', kind: 'mail', bundleIds: ['com.emclient.mail.client'], apps: ['eM Client.app'] },
  { name: 'Google Chrome', kind: 'browser', bundleIds: ['com.google.chrome'], apps: [] },
  { name: 'Safari', kind: 'browser', bundleIds: ['com.apple.safari'], apps: [] },
  { name: 'Firefox', kind: 'browser', bundleIds: ['org.mozilla.firefox'], apps: [] },
  { name: 'Microsoft Edge', kind: 'browser', bundleIds: ['com.microsoft.edgemac'], apps: [] },
  { name: 'Arc', kind: 'browser', bundleIds: ['company.thebrowser.browser'], apps: [] },
  { name: 'Brave', kind: 'browser', bundleIds: ['com.brave.browser'], apps: [] },
];

export interface MacSigns {
  /** The mail programs installed besides Apple Mail, which every Mac has and so tells nothing. */
  installed: string[];
  /**
   * The program macOS opens for an e-mail link: a known one, an app the table does not know, never
   * chosen (Apple Mail, the Mac's default: a guess, no sign), or a preference the app could not read.
   */
  defaultMail: { name: string; kind: AppKind } | { unknownApp: string } | 'never-chosen' | 'unreadable';
}

export type DomainSeenIn = 'outgoing-mail' | 'mailbox-source' | 'receipts';

export interface DomainSign {
  domain: string;
  seenIn: DomainSeenIn[];
  /** A free mail provider's domain (gmail.com, gmx.ch): the person reads it at that provider's web page or app. */
  webmail: boolean;
  /** Who hosts the domain's mail, from the domain or its MX records. */
  provider?: string;
  /** On how many receipts, and from how many different senders, an address of the domain stands. */
  onReceipts?: { receipts: number; senders: number };
}

export interface ArrivalSigns {
  receipts: number;
  /** Taken with the phone (the upload's name, src/intake/captured.ts). */
  phone: number;
  /** Documents each source delivered (its collected ledger). */
  collected: Array<{ source: string; documents: number }>;
  /** The domains the collected mails came from, most first: which suppliers send by mail. */
  senders: Array<{ domain: string; documents: number }>;
}

export interface MailEvidence { os: Os; mac?: MacSigns; domains: DomainSign[]; arrivals: ArrivalSigns }

/** What the workspace shows, gathered once (`seenIn`) so the evidence is a function of data. */
export interface Seen {
  addresses: Array<{ address: string; where: Exclude<DomainSeenIn, 'receipts'> }>;
  receipts: ReadonlyArray<Pick<Receipt, 'filename' | 'originalFilename' | 'extractedText' | 'vatId' | 'title' | 'kind'>>;
  ledgers: Array<{ source: string; lines: readonly LedgerLine[] }>;
}

/** The machine, behind one seam for the tests. */
export interface Probes {
  platform: NodeJS.Platform;
  home: string;
  exists(path: string): boolean;
  /** LaunchServices' LSHandlers array; undefined when the file is missing; throws when unreadable. */
  launchHandlers(): Promise<unknown>;
  mx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
}

const LAUNCH_PREFS = 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist';

export const machine: Probes = {
  platform: process.platform,
  home: homedir(),
  exists: existsSync,
  launchHandlers: () => new Promise((resolve, reject) => {
    const file = join(homedir(), LAUNCH_PREFS);
    if (!existsSync(file)) return resolve(undefined);
    execFile('/usr/bin/plutil', ['-extract', 'LSHandlers', 'json', '-o', '-', file], { timeout: 5000 }, (err, out) => {
      if (err) return /No value at that key path/i.test(String(err.message)) ? resolve(undefined) : reject(err);
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  }),
  mx: resolveMx,
};

const osOf = (p: NodeJS.Platform): Os => (p === 'darwin' ? 'macos' : p === 'win32' ? 'windows' : p === 'linux' ? 'linux' : 'other');

async function macSigns(p: Probes): Promise<MacSigns> {
  const dirs = ['/Applications', join(p.home, 'Applications'), '/System/Applications'];
  const installed = MAC_APPS.filter((a) => a.kind === 'mail' && a.name !== 'Apple Mail' && a.apps.some((app) => dirs.some((d) => p.exists(join(d, app))))).map((a) => a.name);
  let defaultMail: MacSigns['defaultMail'];
  try {
    const handlers = await p.launchHandlers();
    const mailto = Array.isArray(handlers) ? handlers.find((h) => (h as { LSHandlerURLScheme?: unknown })?.LSHandlerURLScheme === 'mailto') as { LSHandlerRoleAll?: unknown } | undefined : undefined;
    const id = typeof mailto?.LSHandlerRoleAll === 'string' ? mailto.LSHandlerRoleAll.toLowerCase() : undefined;
    const known = id && MAC_APPS.find((a) => a.bundleIds.includes(id));
    defaultMail = !id ? 'never-chosen' : known ? { name: known.name, kind: known.kind } : { unknownApp: id };
  } catch {
    defaultMail = 'unreadable';
  }
  return { installed, defaultMail };
}

const ADDRESS_DOMAIN = /[a-z0-9._%+-]@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi;

/** Domains that stand on receipts of two or more different senders: the company's own address as its suppliers write it, not a supplier's. */
function receiptDomains(receipts: Seen['receipts']): Map<string, { receipts: number; senders: number }> {
  const by = new Map<string, { receipts: number; senders: Set<string> }>();
  for (const r of receipts) {
    if (r.kind === 'duplicate' || r.kind === 'noise') continue;
    const sender = r.vatId ?? r.title?.vendor;
    for (const d of new Set([...(r.extractedText ?? '').matchAll(ADDRESS_DOMAIN)].map((m) => m[1].toLowerCase()))) {
      const e = by.get(d) ?? { receipts: 0, senders: new Set<string>() };
      e.receipts += 1;
      if (sender) e.senders.add(sender);
      by.set(d, e);
    }
  }
  return new Map([...by].filter(([, e]) => e.senders.size >= 2).sort((a, b) => b[1].senders.size - a[1].senders.size).slice(0, 3).map(([d, e]) => [d, { receipts: e.receipts, senders: e.senders.size }]));
}

function arrivals(seen: Seen): ArrivalSigns {
  const got = seen.ledgers.map(({ source, lines }) => ({ source, docs: lines.flatMap((l) => ('got' in l && l.got.kind === 'document' ? [l.got] : [])) }));
  const senders = new Map<string, number>();
  for (const { docs } of got) for (const g of docs) { const d = g.from && domainOf(g.from.replace(/^.*<|>.*$/g, '')); if (d) senders.set(d, (senders.get(d) ?? 0) + 1); }
  return {
    receipts: seen.receipts.length,
    phone: seen.receipts.filter((r) => capturedDay(r.originalFilename ?? r.filename)).length,
    collected: got.filter((g) => g.docs.length).map((g) => ({ source: g.source, documents: g.docs.length })),
    senders: [...senders].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([domain, documents]) => ({ domain, documents })),
  };
}

export async function mailEvidence(seen: Seen, p: Probes): Promise<MailEvidence> {
  const os = osOf(p.platform);
  const where = new Map<string, Set<DomainSeenIn>>();
  const add = (d: string | undefined, w: DomainSeenIn) => { if (d) where.set(d, (where.get(d) ?? new Set()).add(w)); };
  for (const a of seen.addresses) add(domainOf(a.address), a.where);
  const onReceipts = receiptDomains(seen.receipts);
  for (const d of onReceipts.keys()) add(d, 'receipts');
  const domains = await Promise.all([...where].map(async ([domain, w]): Promise<DomainSign> => {
    const known = mailHostOf(domain, []);
    const host = known.public ? known : await lookupMailHost(domain, p.mx);
    return { domain, seenIn: [...w], webmail: host.public, ...(host.provider ? { provider: host.provider } : {}), ...(onReceipts.has(domain) ? { onReceipts: onReceipts.get(domain) } : {}) };
  }));
  return { os, ...(os === 'macos' ? { mac: await macSigns(p) } : {}), domains, arrivals: arrivals(seen) };
}

/** The workspace's side of the evidence: its sending address, its mailbox sources' addresses, its receipts, its collected ledgers. */
export function seenIn(ws: Workspace, receipts: Seen['receipts']): Seen {
  const decls = sources(ws, APP_ROOT).flatMap((v) => (v.kind === 'invalid' || v.decl.origin !== 'company' ? [] : [v.decl]));
  const out = ws.outgoingMail;
  return {
    addresses: [
      ...(out ? [out.fromAddress, ...(out.replyTo ? [out.replyTo] : [])].map((address) => ({ address, where: 'outgoing-mail' as const })) : []),
      ...decls.flatMap((d) => (d.reach.mail ? [{ address: d.reach.mail.account, where: 'mailbox-source' as const }] : [])),
    ],
    receipts,
    ledgers: decls.map((d) => ({ source: d.id, lines: readLedger(ws, d.id) })),
  };
}

const OS_NAME: Record<Os, string> = { macos: 'a Mac', windows: 'Windows', linux: 'Linux', other: 'an unknown system' };
const SEEN_IN: Record<DomainSeenIn, string> = { 'outgoing-mail': 'the address invoices are sent from', 'mailbox-source': 'a connected mailbox', receipts: 'the company\'s address on receipts' };

/** The evidence as lines of the AI's message: facts and what each tells, no advice. */
export function evidenceLines(e: MailEvidence): string[] {
  const d = e.mac?.defaultMail;
  const mac = e.mac ? [
    `- mail programs installed besides Apple Mail (which every Mac has, so it tells nothing): ${e.mac.installed.join(', ') || 'none'}`,
    `- the program this Mac opens for an e-mail link: ${
      d === 'never-chosen' ? 'never chosen, so Apple Mail by default (no sign that the person uses it)'
        : d === 'unreadable' ? 'could not be read'
          : typeof d === 'object' && 'unknownApp' in d ? `an app the app does not know (${d.unknownApp})`
            : d!.kind === 'browser' ? `${d!.name}, a web browser (a sign the person reads mail in the browser)` : `${d!.name} (chosen by the person: a strong sign)`}`,
  ] : [];
  const a = e.arrivals;
  return [
    'What the app can see about how the person handles mail (gathered by the app, no mail read; never ask what this answers):',
    `- the computer the app runs on: ${OS_NAME[e.os]}`,
    ...mac,
    ...(e.domains.length ? e.domains.map((x) => `- mail domain ${x.domain} (${x.seenIn.map((w) => SEEN_IN[w]).join(', ')}${x.onReceipts ? `: on ${x.onReceipts.receipts} receipts from ${x.onReceipts.senders} senders` : ''}): ${x.webmail ? `a free mail service (${x.provider ?? 'webmail'}), read in its web page or app` : x.provider ? `mail hosted by ${x.provider}` : 'its mail host is unknown'}`) : ['- no mail domain of the company is known yet']),
    `- receipts so far: ${a.receipts}, of them ${a.phone} taken with the phone; documents delivered by connected sources: ${a.collected.length ? a.collected.map((c) => `${c.documents} from ${c.source}`).join(', ') : 'none'}`,
    ...(a.senders.length ? [`- the collected mails came most from: ${a.senders.map((s) => `${s.domain} (${s.documents})`).join(', ')}`] : []),
  ];
}

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; key: string; lines: Promise<string[]> }>();

/** The evidence lines for the message, gathered at most every ten minutes per workspace (the MX lookups take up to 3 s). */
export function mailEvidenceNow(ws: Workspace, receipts: Seen['receipts'], p: Probes = machine): Promise<string[]> {
  const key = `${receipts.length}`;
  const hit = cache.get(ws.paths.root);
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) return hit.lines;
  const lines = mailEvidence(seenIn(ws, receipts), p).then(evidenceLines);
  cache.set(ws.paths.root, { at: Date.now(), key, lines });
  return lines;
}
