/**
 * A statement read without camt.053 (#217), written as one: the file the bank did not give. It
 * lands in bank-statements/<bank>/ beside the PDF it was read from, and from there it is read like
 * every camt.053 (src/workspace/bank-statements.ts, src/providers/camt053/camt053.ts), so its
 * account, its refs, its balances and the books' merge are the camt path's. Stmt/AddtlStmtInf names
 * the file it was read from and who read it (READ_MARK), which tells it apart from a bank's export.
 *
 * Each movement's ref is its AcctSvcrRef: the ref the books hold for it when it is a payment they
 * have already (`refs`, the line's index → ref), so the bank's export and this one are the same
 * payment; else `<statement id>#<line>`, stable because the file never changes.
 */
import type { ReadBy, ReadStatement } from '../../types/statement-read.js';

/** What Stmt/AddtlStmtInf of a statement read without camt.053 starts with. */
export const READ_MARK = 'vanilla-accounting:read';

/** The file a statement was read from, and how, when it is one this writer wrote (undefined for a bank's export). */
export function readMarkOf(info: unknown): { from: string; by: ReadBy } | undefined {
  const m = /^vanilla-accounting:read (model|hand|csv) (.+)$/.exec(String(info ?? '').trim());
  return m ? { by: m[1] as ReadBy, from: m[2] } : undefined;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amt = (n: number) => Math.abs(n).toFixed(2);
const side = (n: number) => (n < 0 ? 'DBIT' : 'CRDT');

export interface WriteOptions {
  /** The statement's id (Stmt/Id): the same file read again is the same statement. */
  id: string;
  /** The file it was read from, as kept beside it. */
  source: string;
  by: ReadBy;
  /** Refs the books hold for lines that are payments they have already, by the line's index. */
  refs?: ReadonlyMap<number, string>;
  /** When it was written (GrpHdr/CreDtTm). */
  at?: string;
}

export function toStatementXml(s: ReadStatement, o: WriteOptions): string {
  const ccy = esc(s.currency);
  const from = s.period?.from ?? s.opening.date;
  const to = s.period?.to ?? s.closing.date;
  const balance = (code: 'OPBD' | 'CLBD', b: { date: string; amount: number }) =>
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${ccy}">${amt(b.amount)}</Amt><CdtDbtInd>${side(b.amount)}</CdtDbtInd><Dt><Dt>${b.date}</Dt></Dt></Bal>`;
  const entries = s.movements.map((m, i) => {
    const ref = o.refs?.get(i) ?? `${o.id}#${i + 1}`;
    const party = m.counterparty ? `<RltdPties><${m.amount < 0 ? 'Cdtr' : 'Dbtr'}><Nm>${esc(m.counterparty)}</Nm></${m.amount < 0 ? 'Cdtr' : 'Dbtr'}></RltdPties>` : '';
    const remittance = m.text || m.reference
      ? `<RmtInf>${m.text ? `<Ustrd>${esc(m.text)}</Ustrd>` : ''}${m.reference ? `<Strd><CdtrRefInf><Ref>${esc(m.reference)}</Ref></CdtrRefInf></Strd>` : ''}</RmtInf>` : '';
    // The amount in the currency the payment was made in, as a bank export gives it (ISO 20022 InstdAmt, #187).
    const instructed = m.original ? `<AmtDtls><InstdAmt><Amt Ccy="${esc(m.original.currency)}">${amt(m.original.amount)}</Amt></InstdAmt></AmtDtls>` : '';
    return `<Ntry><Amt Ccy="${ccy}">${amt(m.amount)}</Amt><CdtDbtInd>${side(m.amount)}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>`
      + `<BookgDt><Dt>${m.date}</Dt></BookgDt><ValDt><Dt>${m.valueDate ?? m.date}</Dt></ValDt><AcctSvcrRef>${esc(ref)}</AcctSvcrRef>${instructed}`
      + `${party || remittance ? `<NtryDtls><TxDtls>${party}${remittance}</TxDtls></NtryDtls>` : ''}${m.text ? `<AddtlNtryInf>${esc(m.text)}</AddtlNtryInf>` : ''}</Ntry>`;
  });
  const account = `<Acct><Id>${s.iban ? `<IBAN>${esc(s.iban)}</IBAN>` : `<Othr><Id>${esc(o.source)}</Id></Othr>`}</Id><Ccy>${ccy}</Ccy>`
    + `${s.owner ? `<Ownr><Nm>${esc(s.owner)}</Nm></Ownr>` : ''}${s.bankName ? `<Svcr><FinInstnId><Nm>${esc(s.bankName)}</Nm></FinInstnId></Svcr>` : ''}</Acct>`;
  const at = o.at ?? new Date().toISOString().slice(0, 19);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">',
    `<BkToCstmrStmt><GrpHdr><MsgId>${esc(o.id)}</MsgId><CreDtTm>${at}</CreDtTm></GrpHdr>`,
    `<Stmt><Id>${esc(o.id)}</Id><CreDtTm>${at}</CreDtTm><FrToDt><FrDtTm>${from}T00:00:00</FrDtTm><ToDtTm>${to}T23:59:59</ToDtTm></FrToDt>`,
    account,
    balance('OPBD', s.opening),
    balance('CLBD', s.closing),
    ...entries,
    `<AddtlStmtInf>${esc(`${READ_MARK} ${o.by} ${o.source}`)}</AddtlStmtInf>`,
    '</Stmt></BkToCstmrStmt></Document>',
    '',
  ].join('\n');
}
