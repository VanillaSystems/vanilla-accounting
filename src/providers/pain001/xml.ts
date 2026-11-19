/**
 * A credit transfer order as ISO 20022 pain.001.001.09 in the Swiss Payment Standards' shape (SPS 2022,
 * «Swiss Implementation Guidelines Customer Credit Transfer»), for the wage payments of a month: one payment
 * information block (one debit of the firm's account on the payday), category purpose SALA (the bank shows the
 * debit as salaries without the single payments), one transaction per person to her IBAN with the purpose as
 * unstructured remittance text. Addresses are structured (street, number, postcode, town, country): SPS no
 * longer takes unstructured ones. The debtor's agent is named by the IID inside a Swiss or Liechtenstein IBAN.
 * Pure: the caller picks the payments; the same input gives the same bytes.
 */
import { parseIban } from '../../workspace/banks.js';

export interface PainAddress { street?: string; number?: string; postcode?: string; town: string; country: string }

export interface PainPayment {
  /** The payment's own id (end to end), at most 35 characters: the payslip's id. */
  id: string;
  name: string;
  address?: PainAddress;
  iban: string;
  amount: number;
  /** The text the person's bank shows, at most 140 characters. */
  purpose: string;
}

export interface PainOrder {
  /** The message's id, at most 35 characters, unique per file the bank receives. */
  messageId: string;
  /** When the file is made (ISO time, to the second). */
  created: string;
  executionDate: string;
  currency: string;
  debtor: { name: string; address?: PainAddress; iban: string };
  payments: readonly PainPayment[];
}

export class PainError extends Error {}

const NS = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09';

/** XML text: the five entities escaped, and the characters SPS refuses (control characters) left out. */
const x = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const cut = (s: string, n: number): string => [...s.trim()].slice(0, n).join('');
const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

function address(a: PainAddress | undefined, indent: string): string {
  if (!a?.town || !a.country) return '';
  const parts = [
    a.street ? `<StrtNm>${x(cut(a.street, 70))}</StrtNm>` : '',
    a.number ? `<BldgNb>${x(cut(a.number, 16))}</BldgNb>` : '',
    a.postcode ? `<PstCd>${x(cut(a.postcode, 16))}</PstCd>` : '',
    `<TwnNm>${x(cut(a.town, 35))}</TwnNm>`,
    `<Ctry>${x(a.country.toUpperCase().slice(0, 2))}</Ctry>`,
  ].filter(Boolean);
  return `${indent}<PstlAdr>${parts.join('')}</PstlAdr>\n`;
}

/** The bank's IID inside a Swiss or Liechtenstein IBAN (positions 5 to 9). */
export const iidOf = (iban: string): string | undefined => (/^(CH|LI)\d{7}/.test(iban) ? iban.slice(4, 9) : undefined);

export function pain001(order: PainOrder): string {
  if (!order.payments.length) throw new PainError('Keine Zahlung im Auftrag.');
  const debtorIban = parseIban(order.debtor.iban);
  if (!debtorIban) throw new PainError(`${order.debtor.iban} ist keine IBAN.`);
  const payments = order.payments.map((p) => {
    const iban = parseIban(p.iban);
    if (!iban) throw new PainError(`${p.name}: ${p.iban} ist keine IBAN.`);
    if (!(p.amount > 0)) throw new PainError(`${p.name}: ein Betrag über 0.`);
    return { ...p, iban: String(iban) };
  });
  const total = money(payments.reduce((s, p) => s + Math.round(p.amount * 100), 0) / 100);
  const created = order.created.slice(0, 19);
  const iid = iidOf(String(debtorIban));
  const agent = iid ? `<ClrSysMmbId><ClrSysId><Cd>CHBCC</Cd></ClrSysId><MmbId>${iid}</MmbId></ClrSysMmbId>` : '<Othr><Id>NOTPROVIDED</Id></Othr>';
  const tx = payments.map((p, i) => [
    '      <CdtTrfTxInf>',
    `        <PmtId><InstrId>${x(cut(`${order.messageId}-${i + 1}`, 35))}</InstrId><EndToEndId>${x(cut(p.id, 35))}</EndToEndId></PmtId>`,
    `        <Amt><InstdAmt Ccy="${x(order.currency)}">${money(p.amount)}</InstdAmt></Amt>`,
    '        <Cdtr>',
    `          <Nm>${x(cut(p.name, 70))}</Nm>`,
    address(p.address, '          ').trimEnd(),
    '        </Cdtr>',
    `        <CdtrAcct><Id><IBAN>${p.iban}</IBAN></Id></CdtrAcct>`,
    `        <RmtInf><Ustrd>${x(cut(p.purpose, 140))}</Ustrd></RmtInf>`,
    '      </CdtTrfTxInf>',
  ].filter(Boolean).join('\n'));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Document xmlns="${NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    '  <CstmrCdtTrfInitn>',
    '    <GrpHdr>',
    `      <MsgId>${x(cut(order.messageId, 35))}</MsgId>`,
    `      <CreDtTm>${created}</CreDtTm>`,
    `      <NbOfTxs>${payments.length}</NbOfTxs>`,
    `      <CtrlSum>${total}</CtrlSum>`,
    `      <InitgPty><Nm>${x(cut(order.debtor.name, 70))}</Nm></InitgPty>`,
    '    </GrpHdr>',
    '    <PmtInf>',
    `      <PmtInfId>${x(cut(`${order.messageId}-1`, 35))}</PmtInfId>`,
    '      <PmtMtd>TRF</PmtMtd>',
    '      <BtchBookg>true</BtchBookg>',
    `      <NbOfTxs>${payments.length}</NbOfTxs>`,
    `      <CtrlSum>${total}</CtrlSum>`,
    '      <PmtTpInf><CtgyPurp><Cd>SALA</Cd></CtgyPurp></PmtTpInf>',
    `      <ReqdExctnDt><Dt>${order.executionDate}</Dt></ReqdExctnDt>`,
    '      <Dbtr>',
    `        <Nm>${x(cut(order.debtor.name, 70))}</Nm>`,
    address(order.debtor.address, '        ').trimEnd(),
    '      </Dbtr>',
    `      <DbtrAcct><Id><IBAN>${String(debtorIban)}</IBAN></Id></DbtrAcct>`,
    `      <DbtrAgt><FinInstnId>${agent}</FinInstnId></DbtrAgt>`,
    ...tx,
    '    </PmtInf>',
    '  </CstmrCdtTrfInitn>',
    '</Document>',
    '',
  ].filter((l) => l !== '').join('\n') + '\n';
}
