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

/**
 * The characters SPS 2022 permits in a text (its «Zeichensatz», Latin: the basic set, the Latin-1 letters and the
 * Latin Extended-A ones with their accents, and a few signs). Another letter loses its accent when that makes it
 * permitted (Ł is not decomposable, so it becomes «.»); anything else becomes «.». Whitespace collapses to one space.
 */
const PERMITTED = /[A-Za-z0-9 .,:'+\-/()?!"#%&*;<>=@_$£\[\]{}\\`´~\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u017F€]/;
export function spsText(raw: string): string {
  return [...raw.replace(/\s+/g, ' ').trim()].map((ch) => {
    if (PERMITTED.test(ch)) return ch;
    const bare = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return bare && [...bare].every((c) => PERMITTED.test(c)) ? bare : '.';
  }).join('');
}
/** An id SPS takes: permitted characters, not starting with «/», no «//». */
const spsId = (raw: string): string => spsText(raw).replace(/[^A-Za-z0-9 .,:'+\-/()?]/g, '.').replace(/\/{2,}/g, '/').replace(/^\/+/, '');
/** XML text: the five entities escaped. */
const x = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const cut = (s: string, n: number): string => [...spsText(s)].slice(0, n).join('');
const cutId = (s: string, n: number): string => [...spsId(s)].slice(0, n).join('');
const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/** A time as SPS wants it: local, with its offset (2026-09-24T12:15:00+02:00). */
export function localTime(iso: string): string {
  const d = new Date(iso);
  const off = -d.getTimezoneOffset();
  const p = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
}

/** A QR-IBAN (IID 30000 to 31999) is only for QR-bill references, never for a credit transfer of this kind. */
export const isReferenceIban = (iban: string): boolean => { const iid = iidOf(iban.replace(/\s/g, '')); return !!iid && Number(iid) >= 30000 && Number(iid) <= 31999; };

function address(a: PainAddress | undefined, indent: string): string {
  // A country that is no ISO code ("Schweiz") would print a wrong one: no address rather than a false one.
  if (!a?.town || !/^[A-Za-z]{2}$/.test(a.country ?? '')) return '';
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
  // The debtor's agent is named by its IID: only a Swiss or Liechtenstein account, and never a QR-IBAN.
  if (!iidOf(String(debtorIban))) throw new PainError('Belastet wird ein Schweizer oder Liechtensteiner Konto.');
  if (isReferenceIban(String(debtorIban))) throw new PainError('Eine QR-IBAN wird nicht belastet.');
  if (!spsText(order.debtor.name)) throw new PainError('Der Name der Firma fehlt.');
  const payments = order.payments.map((p) => {
    const iban = parseIban(p.iban);
    if (!iban) throw new PainError(`${p.name}: ${p.iban} ist keine IBAN.`);
    if (isReferenceIban(String(iban))) throw new PainError(`${p.name}: eine QR-IBAN nimmt keine Lohnzahlung.`);
    if (!spsText(p.name)) throw new PainError('Ein Empfänger ohne Namen.');
    if (!spsText(p.purpose)) throw new PainError(`${p.name}: der Zahlungszweck fehlt.`);
    if (!Number.isFinite(p.amount) || Math.round(p.amount * 100) < 1) throw new PainError(`${p.name}: ein Betrag ab 0.01.`);
    return { ...p, iban: String(iban), amount: Math.round(p.amount * 100) / 100 };
  });
  const total = money(payments.reduce((s, p) => s + Math.round(p.amount * 100), 0) / 100);
  const created = localTime(order.created);
  const iid = iidOf(String(debtorIban));
  const agent = `<ClrSysMmbId><ClrSysId><Cd>CHBCC</Cd></ClrSysId><MmbId>${iid}</MmbId></ClrSysMmbId>`;
  const tx = payments.map((p, i) => [
    '      <CdtTrfTxInf>',
    `        <PmtId><InstrId>${x(cutId(`${order.messageId}-${i + 1}`, 35))}</InstrId><EndToEndId>${x(cutId(p.id, 35))}</EndToEndId></PmtId>`,
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
    `      <MsgId>${x(cutId(order.messageId, 35))}</MsgId>`,
    `      <CreDtTm>${created}</CreDtTm>`,
    `      <NbOfTxs>${payments.length}</NbOfTxs>`,
    `      <CtrlSum>${total}</CtrlSum>`,
    `      <InitgPty><Nm>${x(cut(order.debtor.name, 70))}</Nm></InitgPty>`,
    '    </GrpHdr>',
    '    <PmtInf>',
    `      <PmtInfId>${x(cutId(`${order.messageId}-1`, 35))}</PmtInfId>`,
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
