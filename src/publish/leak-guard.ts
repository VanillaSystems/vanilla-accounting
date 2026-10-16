/**
 * The leak guard of the public app repo. Two halves, both pure:
 *
 * - Structural (needs no workspace, so the public repo's CI can run it): every file is named by
 *   public-files.txt, binaries only at exact listed paths or under a demo workspace (demo/,
 *   demo-<name>/), no valid IBAN and no Swiss UID except the ones the demos and the public business
 *   files of the app layer declare, and in prose no amount
 *   with cents and no number of six digits or more: those are one company's items (invoice,
 *   order, account numbers, figures). A rate below 1 (0.91) and a date (31.12) pass.
 * - Secrets (needs the real workspace): every string that identifies the company, derived from
 *   its own data at run time (secretsOf), so the list of secrets is never written into the app.
 */
import type { Books } from '../books/store.js';
import type { Counterparty, RawCounterparty } from '../knowledge/counterparties.js';
import { GUIDE_DIR, ROLE_DIRS } from '../knowledge/layers.js';
import { namesOf } from '../knowledge/mentions.js';
import { DEMO_NAME, type Company } from '../workspace/workspace.js';

export type SecretKind =
  | 'company' | 'owner' | 'uid' | 'company-domain' | 'mailbox' | 'iban' | 'bank-account-id'
  | 'private-counterparty' | 'binding-signal' | 'secret-term'
  | 'tx-ref' | 'receipt-id' | 'receipt-filename' | 'journal-id' | 'amount' | 'personal-email';
export type StructuralKind = 'not-allowlisted' | 'binary-not-listed' | 'iban-pattern' | 'foreign-uid' | 'amount-in-prose' | 'long-number';

/**
 * `token`: equal to a whole token of the text (ids, refs, filenames, numbers), compared lowercase.
 * `phrase`: the words in sequence, any case, joined by space, "-" or "_" (names).
 */
export interface Secret { term: string; kind: SecretKind; match: 'token' | 'phrase' }
export interface Finding { path: string; line: number; kind: SecretKind | StructuralKind; term: string }
/** `text` is null for a binary file. */
export interface PublicFile { path: string; text: string | null }

/** The README may say whose books the app runs (owner decision 2026-10-09); nothing else may. */
const IDENTITY_FILES = new Set(['README.md']);
const IDENTITY_KINDS = new Set<Finding['kind']>(['company', 'owner', 'company-domain']);
/** Files whose amounts are prose, not code or test data. */
const PROSE = /\.(md|ya?ml)$/;
const FREE_MAIL = /@(gmail|googlemail|hotmail|outlook|live|yahoo|gmx|web|icloud|me|bluewin|protonmail|proton)\.[a-z.]+$/i;

// ─── Allowlist ──────────────────────────────────────────────────────────────

export interface Allowlist { patterns: RegExp[]; exact: Set<string> }

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',' && re.lastIndexOf('(?:') > re.lastIndexOf(')')) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** public-files.txt: one glob per line, `#` comments. A line without glob characters is an exact path. */
export function parseAllowlist(text: string): Allowlist {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return { patterns: lines.map(globToRegExp), exact: new Set(lines.filter((l) => !/[*?{]/.test(l))) };
}

export const isAllowed = (path: string, list: Allowlist): boolean => list.patterns.some((re) => re.test(path));

// ─── Secrets ────────────────────────────────────────────────────────────────

export interface SecretSources {
  company: Company;
  /** Mailbox addresses the company collects receipts from (mail.yaml) and the logins behind them (.env). */
  mailboxes: readonly string[];
  books: Pick<Books, 'transactions' | 'receipts' | 'journalEntries' | 'bankStatements'>;
  /** Merged counterparties; one without a vendor file is private as a whole. */
  counterparties: readonly Counterparty[];
  /** The workspace layer's counterparty files: their match signals are the company's. */
  bindings: readonly RawCounterparty[];
  /** Bank statement files: names carry the IBAN and account ids, camt053 texts the IBANs. */
  statements: readonly { name: string; text: string | null }[];
  /** Extra terms the workspace declares secret (secret-terms.txt), for what no data names. A trailing `*` also matches the word's compounds (Speiche* finds Speichenmaterial). */
  terms: readonly string[];
}

/** 20260131 or 20260414150127 in a statement's file name is when, not whose. */
const DATE_STAMP = /^20\d\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(\d{6})?$/;
/** An IBAN written compact or in groups of four; isIban then checks its digits. */
const IBAN = /(?<![A-Z0-9])[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?)(?![A-Z0-9])/g;
const compact = (s: string) => s.replace(/\s/g, '').toUpperCase();

/** ISO 13616 check: the four first characters moved to the end, letters as numbers, mod 97 = 1. */
export function isIban(candidate: string): boolean {
  const s = compact(candidate);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

/** Pure. Every string that identifies the company, drawn from its own data. */
export function secretsOf(src: SecretSources): Secret[] {
  const out = new Map<string, Secret>();
  const add = (kind: SecretKind, match: Secret['match'], term: string | undefined) => {
    const t = term?.trim();
    // A term the workspace declares is meant, however short; a derived one must be specific.
    if (!t || (kind !== 'secret-term' && t.length < (match === 'token' ? 6 : 5))) return;
    const key = `${match}:${t.toLowerCase()}`;
    if (!out.has(key)) out.set(key, { term: t, kind, match });
  };
  const { company } = src;

  add('company', 'phrase', company.name);
  add('company', 'phrase', company.name.replace(/\s+(GmbH|AG|SA|Sàrl|Sarl|KlG|KG)$/i, ''));
  add('owner', 'phrase', company.owner);
  add('uid', 'token', company.uid);
  add('uid', 'token', company.uid.replace(/^CHE-/, ''));
  add('uid', 'token', company.uid.replace(/\D/g, ''));

  for (const box of src.mailboxes) {
    add('mailbox', 'token', box);
    const domain = box.split('@')[1];
    if (domain && !FREE_MAIL.test(box)) {
      add('company-domain', 'phrase', domain);
      add('company-domain', 'phrase', domain.split('.')[0]);
    }
  }

  for (const cp of src.counterparties.filter((c) => !c.origin.vendor)) {
    for (const n of namesOf(cp)) add('private-counterparty', 'phrase', n);
    for (const s of [...cp.match.uid, ...cp.match.iban, ...cp.match.domain]) add('private-counterparty', 'phrase', s);
  }
  for (const b of src.bindings) {
    for (const s of [...(b.match?.tx ?? []), ...(b.match?.uid ?? []), ...(b.match?.iban ?? []), ...(b.match?.domain ?? [])]) {
      add('binding-signal', 'phrase', s);
    }
  }
  for (const t of src.terms) add('secret-term', 'phrase', t);

  for (const s of src.statements) {
    for (const m of [...s.name.toUpperCase().matchAll(IBAN), ...(s.text ?? '').matchAll(IBAN)]) {
      if (isIban(m[0])) {
        add('iban', 'token', compact(m[0]));
        add('iban', 'phrase', compact(m[0]).replace(/(.{4})(?!$)/g, '$1 '));
      }
    }
    for (const m of s.name.matchAll(/(?<!\d)\d{6,}(?!\d)/g)) {
      if (!DATE_STAMP.test(m[0])) add('bank-account-id', 'token', m[0]);
    }
  }

  const { books } = src;
  for (const t of books.transactions) {
    // A generated ref (WEUR000042, M2026-001) names nothing; a bank's long number does.
    const base = t.ref.split('~')[0];
    if (/\d{7,}/.test(base)) { add('tx-ref', 'token', base); add('tx-ref', 'token', base.match(/\d{7,}/)![0]); }
  }
  for (const r of books.receipts) {
    add('receipt-id', 'token', r.id);
    for (const f of [r.filename, r.originalFilename]) {
      // A name like invoice.pdf is anyone's; one with a number or a long name is this company's.
      if (!f || !(/\d{4}/.test(f) || f.length >= 16)) continue;
      add('receipt-filename', /\s/.test(f) ? 'phrase' : 'token', f);
      const stem = f.replace(/\.[a-z]{3,4}$/i, '');
      if (stem.length >= 12) add('receipt-filename', /\s/.test(stem) ? 'phrase' : 'token', stem);
    }
    for (const m of (r.extractedText ?? '').matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
      if (FREE_MAIL.test(m[0])) add('personal-email', 'token', m[0]);
    }
  }
  for (const j of books.journalEntries) add('journal-id', 'token', j.id);
  for (const s of books.bankStatements ?? []) add('receipt-filename', 'phrase', s.filename);

  for (const a of [...books.transactions.map((t) => t.amount), ...books.journalEntries.map((j) => j.amount)]) {
    const v = Math.abs(a);
    if (v >= 10 && Math.round(v * 100) % 100 !== 0) add('amount', 'token', v.toFixed(2));
  }
  return [...out.values()];
}

// ─── Scan ───────────────────────────────────────────────────────────────────

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_.~@+\-]*/gu;
const UID = /CHE-?\d{3}\.?\d{3}\.?\d{3}/g;
const AMOUNT = /(?<![\d.'’])(?:\d{1,3}(?:['’]\d{3})+|\d+)\.\d{2}(?!\d)/g;
/** A zero-padded counter (WEUR000042) names nothing. */
const LONG_NUMBER = /(?<!\d)(?!000)\d{6,}(?!\d)/g;
/** 31.12 is a date, and an amount that small names no one. */
const looksLikeDate = (n: string) => /^(0?[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])$/.test(n);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ways a token can carry a secret: itself, its parts around ~ / @, its long digit and hex runs. */
function candidates(token: string): string[] {
  const t = token.toLowerCase().replace(/[.\-]+$/, '');
  return [
    t, ...t.split(/[~/@]/),
    ...(t.match(/\d{7,}/g) ?? []),
    ...(t.match(/[0-9a-f]{16}/g) ?? []),
  ];
}

function lineAt(starts: number[], index: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

export interface ScanOptions {
  /** A public repo or an export: every file must be listed. Off when scanning the private repo's public view. */
  requireAllowlisted: boolean;
}

/**
 * Pure. The findings of the structural half, then of the secrets (an empty list runs only the
 * structural half). IBANs and UIDs that a demo workspace (or, for UIDs, a public business file)
 * declares are fine elsewhere too, so the demo's tests and the vendor rules may name them.
 */
/** A public business file of the app layer: processes/suppliers/, customers/ or authorities/. */
const isAppBusinessFile = (p: string) => Object.values(ROLE_DIRS).some((d) => p.startsWith(`${GUIDE_DIR}/${d}/`));

export function scan(files: readonly PublicFile[], secrets: readonly Secret[], allowlist: Allowlist, opts: ScanOptions): Finding[] {
  const findings: Finding[] = [];
  const declares = (f: PublicFile, re: RegExp) => [...(f.text ?? '').matchAll(re)].map((m) => m[0]);
  const isDemo = (p: string) => DEMO_NAME.test(p.split('/')[0]) && p.includes('/');
  const publicUids = new Set(files.filter((f) => isDemo(f.path) || isAppBusinessFile(f.path))
    .flatMap((f) => declares(f, UID)).map((u) => u.replace(/\D/g, '')));
  const publicIbans = new Set(files.filter((f) => isDemo(f.path)).flatMap((f) => declares(f, IBAN)).map(compact));

  const tokens = new Map<string, Secret>();
  for (const s of secrets) if (s.match === 'token' && s.kind !== 'amount') tokens.set(s.term.toLowerCase(), s);
  const amounts = new Map(secrets.filter((s) => s.kind === 'amount').map((s) => [s.term, s]));
  const phrases = secrets.filter((s) => s.match === 'phrase').map((s) => {
    const prefix = s.kind === 'secret-term' && s.term.endsWith('*');
    const words = (prefix ? s.term.slice(0, -1) : s.term).split(/[\s_-]+/).map(escape).join('[\\s_-]+');
    return { s, re: new RegExp(`(?<![\\p{L}\\p{N}])${words}${prefix ? '\\p{L}*' : '(?![\\p{L}\\p{N}])'}`, 'giu') };
  });

  for (const f of files) {
    const at = (kind: Finding['kind'], term: string, line = 0) => {
      if (IDENTITY_FILES.has(f.path) && IDENTITY_KINDS.has(kind)) return;
      findings.push({ path: f.path, line, kind, term });
    };
    if (opts.requireAllowlisted && !isAllowed(f.path, allowlist)) at('not-allowlisted', f.path);
    if (f.text === null) {
      if (!isDemo(f.path) && !allowlist.exact.has(f.path)) at('binary-not-listed', f.path);
      continue;
    }
    const text = f.text;
    const starts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    const line = (i: number) => lineAt(starts, i);
    const seen = new Set<string>();
    const hit = (kind: Finding['kind'], term: string, index: number) => {
      const l = line(index);
      const key = `${l}:${kind}:${term.toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); at(kind, term, l); }
    };

    if (!isDemo(f.path)) {
      for (const m of text.matchAll(IBAN)) if (isIban(m[0]) && !publicIbans.has(compact(m[0]))) hit('iban-pattern', m[0], m.index!);
      for (const m of text.matchAll(UID)) if (!publicUids.has(m[0].replace(/\D/g, ''))) hit('foreign-uid', m[0], m.index!);
      const prose = PROSE.test(f.path);
      // The casebook's figures are invented like the demo's; a real amount of the books is still caught.
      const synthetic = f.path.startsWith('examples/');
      // App code holds no figure of the books either (an example in a comment); tests and the demo
      // hold synthetic amounts that may equal a real one by chance, so only src/ is checked.
      if (prose || f.path.startsWith('src/')) {
        for (const m of text.matchAll(AMOUNT)) {
          const plain = m[0].replace(/['’]/g, '');
          if (amounts.has(plain)) hit('amount', m[0], m.index!);
          else if (prose && !synthetic && Number(plain) >= 1 && !looksLikeDate(plain)) hit('amount-in-prose', m[0], m.index!);
        }
      }
      if (prose) for (const m of text.matchAll(LONG_NUMBER)) hit('long-number', m[0], m.index!);
    }
    if (secrets.length === 0) continue;
    for (const m of text.matchAll(TOKEN)) {
      for (const c of candidates(m[0])) {
        const s = tokens.get(c);
        if (s) { hit(s.kind, s.term, m.index!); break; }
      }
    }
    for (const { s, re } of phrases) for (const m of text.matchAll(re)) hit(s.kind, s.term, m.index!);
  }
  return findings;
}

/** Pure. Findings grouped by file, at most `perFile` lines each, then a count per kind. */
export function formatFindings(findings: readonly Finding[], perFile = 5): string {
  if (findings.length === 0) return 'check-public: 0 findings.';
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f]);
  const out: string[] = [];
  for (const [path, list] of byFile) {
    out.push(`${path} (${list.length})`);
    for (const f of list.slice(0, perFile)) out.push(`  ${f.line ? `${f.line}: ` : ''}${f.kind} "${f.term}"`);
    if (list.length > perFile) out.push(`  … ${list.length - perFile} more`);
  }
  const kinds = new Map<string, number>();
  for (const f of findings) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
  out.push('', `check-public: ${findings.length} findings in ${byFile.size} files: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  return out.join('\n');
}
