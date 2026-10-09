import { XMLParser } from 'fast-xml-parser';
import type { BankTransaction } from '../types/index.js';

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

function getDate(bookgDt: any): string {
  if (!bookgDt) return '';
  const raw = bookgDt.Dt ?? bookgDt.DtTm ?? '';
  return String(raw).substring(0, 10);
}

function deriveBankFromRef(ref: string): 'Raiffeisen' | 'Wise' {
  return ref.startsWith('W') ? 'Wise' : 'Raiffeisen';
}

// Reference number prefixes vary by export batch (older Wise exports use "WEUR..."/"WCHF...",
// newer ones use "CARD-"/"TRANSFER-"/"FEE-"), so the ref alone isn't a reliable signal.
// The statement's institution name (Stmt.Acct.Svcr.FinInstnId.Nm) is stable across exports —
// prefer that, and only fall back to the ref-prefix guess if it's missing.
function deriveBankFromStatement(stmt: any, ref: string): 'Raiffeisen' | 'Wise' {
  const institution = String(stmt?.Acct?.Svcr?.FinInstnId?.Nm ?? '');
  if (/wise/i.test(institution)) return 'Wise';
  if (/raiffeisen/i.test(institution)) return 'Raiffeisen';
  return deriveBankFromRef(ref);
}

export function parseCamt053(xml: string, filename?: string): BankTransaction[] {
  // Only process uuid_-prefixed files
  if (filename && !filename.startsWith('uuid_')) return [];

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['Ntry', 'TxDtls'].includes(name),
    // QR / creditor references are 27-digit strings; parsed as numbers they become 3.03e+26.
    numberParseOptions: { hex: false, leadingZeros: false, skipLike: /^\d{16,}$/ },
  });
  const parsed = parser.parse(xml);

  const stmt = parsed.Document?.BkToCstmrStmt?.Stmt;
  if (!stmt) return [];
  const deriveBank = (ref: string) => deriveBankFromStatement(stmt, ref);

  const entries: any[] = stmt.Ntry ?? [];
  const transactions: BankTransaction[] = [];

  for (const entry of entries) {
    const { amount, currency } = getAmt(entry.Amt);
    const direction = String(entry.CdtDbtInd ?? 'DBIT') as 'CRDT' | 'DBIT';
    const date = getDate(entry.BookgDt);
    const ref = String(entry.AcctSvcrRef ?? entry.BkTxCd?.Prtry?.Cd ?? '');

    // Each statement entry (Ntry) is exactly one booked balance movement, so it
    // becomes exactly one transaction — keyed by the stable entry-level
    // AcctSvcrRef and carrying the entry-level amount. Nested TxDtls are only
    // per-invoice *detail* of that single booking (e.g. a Sammelzahlung /
    // batch payment covering several invoices, or Wise grouping several card
    // charges): splitting them into separate transactions would double-count
    // the balance and derive unstable refs (child EndToEndId is often
    // NOTPROVIDED). Receipts that belong to a grouped payment are attached via
    // multiple mappings to this one transaction instead.
    //
    // When there is a single detail record, prefer its remittance text — it is
    // usually more specific than the entry-level AddtlNtryInf.
    const ntryDtls = entry.NtryDtls;
    const txDtlsArr: any[] = ntryDtls
      ? Array.isArray(ntryDtls.TxDtls)
        ? ntryDtls.TxDtls
        : ntryDtls.TxDtls
        ? [ntryDtls.TxDtls]
        : []
      : [];

    // A batch keeps its parts, so each payment inside it can be matched and booked.
    const parts = txDtlsArr.length > 1
      ? txDtlsArr.map((d) => {
          const side = direction === 'DBIT' ? d.RltdPties?.Cdtr : d.RltdPties?.Dbtr;
          const ref = d.RmtInf?.Strd?.CdtrRefInf?.Ref ?? d.RmtInf?.Ustrd;
          return {
            ...getAmt(d.Amt ?? d.AmtDtls?.TxAmt?.Amt),
            counterparty: String(side?.Pty?.Nm ?? side?.Nm ?? ''),
            ...(ref !== undefined ? { reference: String(ref) } : {}),
          };
        })
      : undefined;

    const single = txDtlsArr.length === 1 ? txDtlsArr[0] : undefined;
    const reference = single ? (single.RmtInf?.Strd?.CdtrRefInf?.Ref ?? single.RmtInf?.Ustrd) : undefined;

    let description = String(entry.AddtlNtryInf ?? '');
    if (txDtlsArr.length === 1) {
      const only = txDtlsArr[0];
      description = String(only.RmtInf?.Ustrd ?? only.AddtlTxInf ?? description);
    }

    transactions.push({
      ref,
      bank: deriveBank(ref),
      date,
      amount,
      currency,
      direction,
      description,
      ...(parts ? { parts } : {}),
      ...(reference !== undefined && String(reference).trim() ? { reference: String(reference).trim() } : {}),
      ...(description.startsWith('Wise Charges for: CARD-') ? { type: 'wise-fee' as const } : {}),
    });
  }

  return transactions;
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
