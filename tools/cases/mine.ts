/**
 * npm run mine-cases -- [out.md]
 *
 * Groups a workspace's journal into booking patterns, the raw material of the casebook
 * (examples/cases/, docs/casebook.md). A pattern names only generic features: the VAT code's
 * family, which side is the bank or the owner's current account, the KMU account group of
 * every other leg, foreign currency, `corrects`, and the shape of the whole transaction.
 * It never prints an account name, an amount, a description or a ref, so the inventory says
 * what kinds of booking exist without saying whose.
 *
 * Prints the inventory, or writes it to `out.md`. Reads the workspace; never writes it.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseVatCode } from '../../src/accounting/vat-report.js';
import { loadBooks, type Books } from '../../src/books/store.js';
import type { BankTransaction, JournalEntry } from '../../src/types/index.js';
import { openWorkspace, type LedgerBankAccount } from '../../src/workspace/workspace.js';

/** The KMU chart's account groups (Kontenrahmen KMU), by the first two digits. */
const KMU_GROUPS: Record<string, string> = {
  '10': 'Flüssige Mittel', '11': 'Forderungen', '12': 'Vorräte', '13': 'Aktive Rechnungsabgrenzung',
  '14': 'Finanzanlagen', '15': 'Mobile Sachanlagen', '16': 'Immobile Sachanlagen', '17': 'Immaterielle Werte',
  '20': 'Verbindlichkeiten L+L', '21': 'Kurzfristige verzinsliche Verbindlichkeiten', '22': 'Übrige kurzfristige Verbindlichkeiten',
  '23': 'Passive Rechnungsabgrenzung', '24': 'Langfristige verzinsliche Verbindlichkeiten', '25': 'Übrige langfristige Verbindlichkeiten',
  '26': 'Rückstellungen', '28': 'Eigenkapital', '29': 'Reserven, Gewinnvortrag',
  '30': 'Produktionserlöse', '32': 'Handelserlöse', '34': 'Dienstleistungserlöse', '36': 'Übrige Erlöse', '38': 'Erlösminderungen', '39': 'Bestandesänderungen',
  '40': 'Materialaufwand', '42': 'Handelswarenaufwand', '44': 'Bezogene Dienstleistungen', '45': 'Energieaufwand', '46': 'Übriger Aufwand', '47': 'Direkte Einkaufsspesen', '48': 'Bestandesänderungen',
  '50': 'Lohnaufwand', '57': 'Sozialversicherungsaufwand', '58': 'Übriger Personalaufwand', '59': 'Leistungen Dritter',
  '60': 'Raumaufwand', '61': 'Unterhalt, Reparaturen', '62': 'Fahrzeugaufwand', '63': 'Versicherungen', '64': 'Energie, Entsorgung',
  '65': 'Verwaltung, Informatik', '66': 'Werbeaufwand', '67': 'Übriger betrieblicher Aufwand', '68': 'Abschreibungen, Finanzerfolg', '69': 'Finanzaufwand',
  '70': 'Betrieblicher Nebenerfolg', '75': 'Betriebliche Liegenschaft', '79': 'Gewinn aus Veräusserung', '80': 'Betriebsfremder Erfolg',
  '85': 'Ausserordentlicher Erfolg', '89': 'Direkte Steuern', '90': 'Abschluss',
};

/** What an account is in a booking pattern: a bank, the owner's current account, or its KMU group. */
function role(account: string, banks: ReadonlySet<string>, ownerAccounts: ReadonlySet<string>): string {
  if (!account) return '(empty: VAT leg)';
  if (banks.has(account)) return 'bank';
  if (ownerAccounts.has(account)) return 'owner current account';
  const group = account.slice(0, 2);
  return `${group}xx ${KMU_GROUPS[group] ?? `class ${account[0]}`}`;
}

/** The VAT code with its rate kept and nothing company-specific: "-I81", "M81-2", "K81-B", "none". */
function vatFamily(code: string | undefined): string {
  if (!code) return 'none';
  return parseVatCode(code) ? code : `${code} (unknown to the engine)`;
}

/** One journal row's pattern. */
export interface RowPattern {
  vat: string;
  legs: 'two legs' | 'single leg, debit empty' | 'single leg, credit empty';
  debit: string;
  credit: string;
  currency: 'CHF' | 'foreign';
  corrects: boolean;
}

/** One transaction's shape: how many rows, and which booking situations it combines. */
export interface TransactionShape {
  direction: 'DBIT' | 'CRDT' | 'no transaction';
  rows: '1' | '2' | '3+';
  flags: string[];
}

export interface Inventory {
  entries: number;
  transactions: number;
  rows: Array<{ key: string; pattern: RowPattern; count: number }>;
  shapes: Array<{ key: string; shape: TransactionShape; count: number }>;
}

const rowKey = (p: RowPattern) =>
  [p.vat, p.legs, `D ${p.debit}`, `C ${p.credit}`, p.currency, p.corrects ? 'corrects a filed quarter' : ''].filter(Boolean).join(' | ');
const shapeKey = (s: TransactionShape) => [s.direction, `${s.rows} row(s)`, ...s.flags].join(' | ');

function rowPattern(e: JournalEntry, banks: ReadonlySet<string>, owner: ReadonlySet<string>): RowPattern {
  return {
    vat: vatFamily(e.vatCode),
    legs: !e.accountDebit ? 'single leg, debit empty' : !e.accountCredit ? 'single leg, credit empty' : 'two legs',
    debit: role(e.accountDebit, banks, owner),
    credit: role(e.accountCredit, banks, owner),
    currency: e.exchangeCurrency && e.exchangeCurrency !== 'CHF' ? 'foreign' : 'CHF',
    corrects: !!e.corrects,
  };
}

function transactionShape(tx: BankTransaction | undefined, rows: JournalEntry[], books: Books, banks: ReadonlySet<string>): TransactionShape {
  const flags: string[] = [];
  const codes = rows.map((r) => parseVatCode(r.vatCode ?? ''));
  const debits = new Set(rows.map((r) => r.accountDebit).filter((a) => a && !banks.has(a)));
  const credits = new Set(rows.map((r) => r.accountCredit).filter((a) => a && !banks.has(a)));
  if ((tx?.parts?.length ?? 0) > 1) flags.push('Sammelzahlung (parts)');
  if (rows.some((r) => r.exchangeCurrency && r.exchangeCurrency !== 'CHF')) flags.push('foreign currency');
  if (rows.some((r) => r.corrects)) flags.push('corrects a filed quarter');
  if (codes.some((c) => c?.isNegative)) flags.push('refund (minus code)');
  if (codes.some((c) => c?.amountIs === 'tax')) flags.push('VAT-only leg (-2)');
  if (codes.some((c) => c?.correctionZiffer)) flags.push('input-tax correction (K)');
  if (codes.some((c) => c?.acquisitionZiffer)) flags.push('Bezugsteuer');
  if ([...debits].some((a) => credits.has(a))) flags.push('clearing account (payout legs)');
  if (new Set(rows.map((r) => r.vatCode ?? '')).size > 1) flags.push('mixed codes');
  if (tx) {
    const receipts = books.mappings.filter((m) => m.transactionRef === tx.ref)
      .map((m) => books.receipts.find((r) => r.id === m.receiptId)).filter((r) => !!r);
    flags.push(receipts.length === 0 ? 'no receipt' : receipts.length > 1 ? 'several receipts' : 'one receipt');
    if (receipts.some((r) => r!.hasSwissVat)) flags.push('receipt shows Swiss MWST');
  }
  return {
    direction: tx?.direction ?? 'no transaction',
    rows: rows.length === 1 ? '1' : rows.length === 2 ? '2' : '3+',
    flags,
  };
}

/** The inventory of a workspace's journal. `bankAccounts` is the manifest's: manual ones are the owner's current account. */
export function minePatterns(books: Books, bankAccounts: readonly LedgerBankAccount[]): Inventory {
  const banks = new Set(bankAccounts.filter((b) => b.bank !== 'manual').map((b) => b.account));
  const owner = new Set(bankAccounts.filter((b) => b.bank === 'manual').map((b) => b.account));
  const count = <P>(into: Map<string, { pattern: P; count: number }>, key: string, pattern: P) => {
    const hit = into.get(key);
    if (hit) hit.count++;
    else into.set(key, { pattern, count: 1 });
  };

  const rows = new Map<string, { pattern: RowPattern; count: number }>();
  for (const e of books.journalEntries) {
    const p = rowPattern(e, banks, owner);
    count(rows, rowKey(p), p);
  }

  const byTx = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries) byTx.set(e.transactionRef, [...(byTx.get(e.transactionRef) ?? []), e]);
  const txs = new Map(books.transactions.map((t) => [t.ref, t]));
  const shapes = new Map<string, { pattern: TransactionShape; count: number }>();
  for (const [ref, entries] of byTx) {
    const s = transactionShape(txs.get(ref), entries, books, banks);
    count(shapes, shapeKey(s), s);
  }

  const sorted = <P>(m: Map<string, { pattern: P; count: number }>) =>
    [...m].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return {
    entries: books.journalEntries.length,
    transactions: byTx.size,
    rows: sorted(rows).map(({ key, pattern, count }) => ({ key, pattern, count })),
    shapes: sorted(shapes).map(({ key, pattern, count }) => ({ key, shape: pattern, count })),
  };
}

export function inventoryMarkdown(inv: Inventory): string {
  const table = (title: string, items: Array<{ key: string; count: number }>) =>
    [`## ${title}`, '', '| Count | Pattern |', '|---:|---|', ...items.map((i) => `| ${i.count} | ${i.key} |`), ''].join('\n');
  return [
    '# Booking pattern inventory',
    '',
    `${inv.entries} journal rows in ${inv.transactions} transactions. Generated by \`npm run mine-cases\`; no names, amounts or refs.`,
    '',
    table('Rows: VAT code, legs, account roles, currency', inv.rows),
    table('Transactions: direction, rows, situations', inv.shapes),
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ws = openWorkspace();
  const md = inventoryMarkdown(minePatterns(loadBooks(ws), ws.bankAccounts));
  const out = process.argv[2];
  if (out) {
    writeFileSync(out, md);
    console.log(`Wrote ${out}`);
  } else {
    console.log(md);
  }
}
