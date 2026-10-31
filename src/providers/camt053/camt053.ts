/**
 * ISO 20022 camt.053 bank statements, as every Swiss bank exports them (SIX Swiss Payment
 * Standards). `readCamt` reads the statements of a file with the account they are for; which
 * ledger account that is, the manifest decides (src/accounting/bank-accounts.ts), and
 * `transactionsOf` then turns each entry into a BankTransaction.
 *
 * Shapes the banks differ in, all read here: the entry reference (AcctSvcrRef, NtryRef, or only
 * on the TxDtls), one or several NtryDtls with or without a Btch, remittance as Ustrd lines or a
 * Strd creditor reference (QR, SCOR), the counterparty as Cdtr/Nm or Cdtr/Pty/Nm, Dt or DtTm.
 */
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { BankTransaction, StatementClosingBalance } from '../../types/index.js';
import { parseStatementBalances } from './statement-balances.js';
import type { StatementKind } from '../../workspace/banks.js';
import { readMarkOf } from '../statement-read/camt-writer.js';
import type { ReadBy } from '../../types/statement-read.js';

/** The ISO 20022 cash-management message a file holds: only camt.053 is a statement. */
export type CamtMessage = 'camt.053' | 'camt.052' | 'camt.054' | 'other';

/** fast-xml-parser's view of an element: the XML is the boundary, so fields stay untyped until read. */
type Node = Record<string, any>;

/** One <Stmt>: the account it is for, its balances and entries, not yet tied to a ledger account. */
export interface CamtStatement {
  /** Stmt/Id; a statement without one is identified by its content. */
  id: string;
  iban?: string;
  currency: string;
  /** Acct/Svcr/FinInstnId/Nm: the bank that keeps the account, as it names itself. */
  bankName?: string;
  /** Acct/Svcr/FinInstnId/BICFI (BIC in older versions): the bank's identifier code. */
  bic?: string;
  /** Acct/Ownr/Nm: the account holder, as the bank names them. */
  ownerName?: string;
  /** Stmt/FrToDt: the days the bank says the statement covers (r9k-10); absent when the bank leaves it out. */
  period?: { from: string; to: string };
  /** A statement the app wrote from a PDF, a scan, a table or a CSV (#217): the file it was read from, and how. */
  read?: { from: string; by: ReadBy };
  node: Node;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  isArray: (name) => ['Stmt', 'Ntry', 'NtryDtls', 'TxDtls', 'Bal', 'Ustrd', 'Strd'].includes(name),
  // QR / creditor references are 27-digit strings; parsed as numbers they become 3.03e+26.
  numberParseOptions: { hex: false, leadingZeros: false, skipLike: /^\d{16,}$/ },
});

const MESSAGES: [string, CamtMessage][] = [
  ['BkToCstmrStmt', 'camt.053'], ['BkToCstmrAcctRpt', 'camt.052'], ['BkToCstmrDbtCdtNtfctn', 'camt.054'],
];

export function readCamt(xml: string): { message: CamtMessage; statements: CamtStatement[] } {
  const doc: Node | undefined = parser.parse(xml)?.Document;
  const message = MESSAGES.find(([el]) => doc?.[el] !== undefined)?.[1] ?? 'other';
  if (message !== 'camt.053') return { message, statements: [] };
  const stmts: Node[] = doc!.BkToCstmrStmt.Stmt ?? [];
  return {
    message,
    statements: stmts.map((node, i) => ({
      id: node.Id !== undefined ? String(node.Id) : `${createHash('sha256').update(xml).digest('hex').slice(0, 16)}#${i + 1}`,
      ...(node.Acct?.Id?.IBAN ? { iban: String(node.Acct.Id.IBAN) } : {}),
      currency: String(node.Acct?.Ccy ?? node.Ntry?.[0]?.Amt?.['@_Ccy'] ?? node.Bal?.[0]?.Amt?.['@_Ccy'] ?? 'CHF'),
      ...(node.Acct?.Svcr?.FinInstnId?.Nm ? { bankName: String(node.Acct.Svcr.FinInstnId.Nm).trim() } : {}),
      ...(bicOf(node.Acct?.Svcr?.FinInstnId) ? { bic: bicOf(node.Acct?.Svcr?.FinInstnId) } : {}),
      ...(node.Acct?.Ownr?.Nm ? { ownerName: String(node.Acct.Ownr.Nm).trim() } : {}),
      ...(periodOf(node.FrToDt) ? { period: periodOf(node.FrToDt) } : {}),
      ...(readMarkOf(node.AddtlStmtInf) ? { read: readMarkOf(node.AddtlStmtInf) } : {}),
      node,
    })),
  };
}

/** The servicer's BIC, when it is shaped as one (8 or 11 letters and digits). */
function bicOf(fin: Node | undefined): string | undefined {
  const bic = String(fin?.BICFI ?? fin?.BIC ?? '').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic) ? bic : undefined;
}

/** Stmt/FrToDt as two days, when both are there and in order. */
function periodOf(frToDt: Node | undefined): { from: string; to: string } | undefined {
  const from = String(frToDt?.FrDtTm ?? frToDt?.FrDt ?? '').slice(0, 10);
  const to = String(frToDt?.ToDtTm ?? frToDt?.ToDt ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to ? { from, to } : undefined;
}

function getAmt(amtEl: any): { amount: number; currency: string } {
  if (amtEl === null || amtEl === undefined) return { amount: 0, currency: 'CHF' };
  if (typeof amtEl === 'object') {
    return {
      amount: parseFloat(String(amtEl['#text'] ?? 0)),
      currency: String(amtEl['@_Ccy'] ?? 'CHF'),
    };
  }
  return { amount: parseFloat(String(amtEl)), currency: 'CHF' };
}

function getDate(dt: any): string {
  if (!dt) return '';
  const raw = dt.Dt ?? dt.DtTm ?? '';
  return String(raw).substring(0, 10);
}

/** Remittance text: Ustrd lines joined. */
function ustrd(rmtInf: Node | undefined): string | undefined {
  const lines: unknown[] | undefined = rmtInf?.Ustrd;
  return lines?.length ? lines.map(String).join(' ') : undefined;
}

/** The structured creditor reference (QR or SCOR), else the remittance text. */
function remittanceRef(rmtInf: Node | undefined): unknown {
  const strd = (rmtInf?.Strd as Node[] | undefined)?.find((s) => s?.CdtrRefInf?.Ref !== undefined);
  return strd?.CdtrRefInf.Ref ?? ustrd(rmtInf);
}

/**
 * The entry's stable id. Wise names its transaction (CARD-…, TRANSFER-…) in BkTxCd/Prtry/Cd and
 * often leaves AcctSvcrRef out. Other banks give AcctSvcrRef or NtryRef on the entry, or only
 * on its TxDtls; an entry without any is numbered within its statement.
 */
function entryRef(entry: Node, txDtls: Node[], kind: StatementKind, statementId: string, n: number): string {
  if (kind === 'wise') return String(entry.AcctSvcrRef ?? entry.BkTxCd?.Prtry?.Cd ?? '');
  const ref = entry.AcctSvcrRef ?? entry.NtryRef ?? (txDtls.length === 1 ? txDtls[0].Refs?.AcctSvcrRef : undefined);
  return ref !== undefined && String(ref).trim() ? String(ref).trim() : `${statementId}#${n}`;
}

/** The bank transactions of a statement, booked on the ledger account of `bank` (a manifest label). */
export function transactionsOf(statement: CamtStatement, account: { bank: string; statements: StatementKind }): BankTransaction[] {
  const entries: Node[] = statement.node.Ntry ?? [];
  return entries.map((entry, i): BankTransaction => {
    const { amount, currency } = getAmt(entry.Amt);
    const direction = String(entry.CdtDbtInd ?? 'DBIT') as 'CRDT' | 'DBIT';
    const date = getDate(entry.BookgDt) || getDate(entry.ValDt);

    // Each statement entry (Ntry) is exactly one booked balance movement, so it
    // becomes exactly one transaction — keyed by the stable entry-level
    // reference and carrying the entry-level amount. Nested TxDtls are only
    // per-invoice *detail* of that single booking (e.g. a Sammelzahlung /
    // batch payment covering several invoices, or Wise grouping several card
    // charges): splitting them into separate transactions would double-count
    // the balance and derive unstable refs (child EndToEndId is often
    // NOTPROVIDED). Receipts that belong to a grouped payment are attached via
    // multiple mappings to this one transaction instead.
    const txDtlsArr: Node[] = ((entry.NtryDtls ?? []) as Node[]).flatMap((d) => d?.TxDtls ?? []);
    const ref = entryRef(entry, txDtlsArr, account.statements, statement.id, i + 1);
    const counterpartyOf = (d: Node) => {
      const side = direction === 'DBIT' ? d.RltdPties?.Cdtr : d.RltdPties?.Dbtr;
      return String(side?.Pty?.Nm ?? side?.Nm ?? '');
    };

    // A batch keeps its parts, so each payment inside it can be matched and booked. A part without
    // remittance info carries its invoice number in AddtlTxInf (Raiffeisen): kept as its reference (r9k-6).
    const parts = txDtlsArr.length > 1
      ? txDtlsArr.map((d) => {
          const ref = remittanceRef(d.RmtInf) ?? (String(d.AddtlTxInf ?? '').trim() || undefined);
          const iban = String((direction === 'DBIT' ? d.RltdPties?.CdtrAcct : d.RltdPties?.DbtrAcct)?.Id?.IBAN ?? '').replace(/\s+/g, '').toUpperCase();
          return {
            ...getAmt(d.Amt ?? d.AmtDtls?.TxAmt?.Amt),
            counterparty: counterpartyOf(d),
            ...(ref !== undefined ? { reference: String(ref) } : {}),
            ...(iban ? { counterpartyIban: iban } : {}),
          };
        })
      : undefined;

    // When there is a single detail record, prefer its remittance text — it is
    // usually more specific than the entry-level AddtlNtryInf.
    const single = txDtlsArr.length === 1 ? txDtlsArr[0] : undefined;
    const reference = single ? remittanceRef(single.RmtInf) : undefined;
    let description = String(entry.AddtlNtryInf ?? '');
    if (single) description = String(ustrd(single.RmtInf) ?? single.AddtlTxInf ?? description);
    if (!description.trim() && single) description = counterpartyOf(single);
    const named = single ? counterpartyOf(single).trim() : '';
    const sideAccount = single && (direction === 'DBIT' ? single.RltdPties?.CdtrAcct : single.RltdPties?.DbtrAcct);
    const counterpartyIban = String(sideAccount?.Id?.IBAN ?? '').replace(/\s+/g, '').toUpperCase();
    // Kept even when the text repeats it («Belastung Marco Rossi»): routing and rules read this field.
    const counterparty = named;
    // The amount as instructed, in the currency the payment was made in (ISO 20022 InstdAmt), when that is not the account's: receipts in that currency match it to the Rappen (#187).
    const instructed = single?.AmtDtls?.InstdAmt?.Amt ?? entry.AmtDtls?.InstdAmt?.Amt;
    const original = instructed !== undefined ? getAmt(instructed) : undefined;
    const wiseId = account.statements === 'wise' ? String(entry.BkTxCd?.Prtry?.Cd ?? '').trim() : '';

    return {
      ref,
      bank: account.bank,
      date,
      amount,
      currency,
      direction,
      description,
      ...(parts ? { parts } : {}),
      ...(reference !== undefined && String(reference).trim() ? { reference: String(reference).trim() } : {}),
      ...(counterparty ? { counterparty } : {}),
      ...(counterpartyIban ? { counterpartyIban } : {}),
      ...(original && original.currency !== currency && Number.isFinite(original.amount) ? { original: { amount: Math.abs(original.amount), currency: original.currency } } : {}),
      ...(wiseId && wiseId !== ref ? { bankTxId: wiseId } : {}),
      ...(account.statements === 'wise' && description.startsWith('Wise Charges for: CARD-') ? { type: 'wise-fee' as const } : {}),
    };
  });
}

// A single card ref can carry more than one booking: a charge and its later
// refund/reversal, or the Raiffeisen "NOTPROVIDED" placeholder that unrelated
// payments share. Those are distinct transactions and each needs its own
// identity so the UI can select them, map receipts to them, and journal them
// independently (otherwise selecting one highlights both and receipt/detail
// lookups by ref match the wrong leg).
//
// The exception is a Wise multi-currency split — one payment drawn from several
// currency buckets (e.g. a CHF charge taken mostly from EUR and the rest from CHF).
// Those legs share one direction but span currencies and represent a single
// economic transaction, so they intentionally keep the shared ref.
//
// The assigned suffix is deterministic and stable (same input always yields the
// same ref), so mappings and journal entries keyed to it survive re-extraction.
export function assignUniqueRefs(transactions: BankTransaction[]): BankTransaction[] {
  const byRef = new Map<string, BankTransaction[]>();
  for (const t of transactions) {
    const group = byRef.get(t.ref);
    if (group) group.push(t);
    else byRef.set(t.ref, [t]);
  }

  for (const [ref, legs] of byRef) {
    if (!ref || legs.length < 2) continue;
    const directions = new Set(legs.map((l) => l.direction));
    const currencies = new Set(legs.map((l) => l.currency));
    const isCurrencySplit = directions.size === 1 && currencies.size > 1;
    if (isCurrencySplit) continue; // one payment across buckets — keep shared ref

    for (const leg of legs) {
      // (date, direction, amount, currency) is unique within the group because
      // true duplicate bookings don't occur. `~`, `-`, `.` are all URL-safe.
      leg.ref = `${ref}~${leg.date}-${leg.direction}-${leg.amount.toFixed(2)}${leg.currency}`;
    }
  }

  return transactions;
}

/**
 * The days a camt.053 covers and the balances it states. The days are the bank's own (FrToDt) when
 * it names them (r9k-10), else read off the balances and bookings. Its opening (OPBD) is the balance
 * at the start of its date: the close of the day before when the bank booked on that date, else the
 * close of that date itself (with nothing booked that day the two are the same amount).
 */
export function statementSpan(camts: CamtStatement[], account: { account: string; bank: string; currency: string; statements: StatementKind }, filename: string): { from: string; to: string; balances: StatementClosingBalance[] } | null {
  const booked = new Set(camts.flatMap((c) => transactionsOf(c, account).map((t) => t.date)).filter(Boolean));
  const stated = camts.flatMap((c) => parseStatementBalances(c, account.bank, filename)).filter((b) => b.date && b.currency === account.currency);
  const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
  const opening = stated.filter((b) => b.type === 'OPBD').sort(byDate)[0];
  const closing = stated.filter((b) => b.type === 'CLBD').sort(byDate).at(-1);
  const days = [...booked].sort();
  const openedOn = opening && (booked.has(opening.date) ? shiftDays(opening.date, -1) : opening.date);
  const periods = camts.flatMap((c) => (c.period ? [c.period] : []));
  const from = periods.map((p) => p.from).sort()[0] ?? (openedOn ? shiftDays(openedOn, 1) : days[0]);
  const to = periods.map((p) => p.to).sort().at(-1) ?? closing?.date ?? days.at(-1);
  if (!from || !to || to < from) return null;
  const balance = (date: string, amount: number): StatementClosingBalance =>
    ({ account: account.account, bank: account.bank, currency: account.currency, date, amount, source: 'camt', sourceFile: filename });
  return { from, to, balances: [...(openedOn ? [balance(openedOn, opening.amount)] : []), ...(closing ? [balance(closing.date, closing.amount)] : [])] };
}

const shiftDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
