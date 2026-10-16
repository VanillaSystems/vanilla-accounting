/**
 * What every demo company is made of. A demo is a story told as a list of Payments (every bank
 * movement, and every expense the owner paid privately) plus a few ManualEntries; the books, the
 * receipts, the camt053 statements and the filed return are all derived from it by
 * tools/demo/generate.ts, so they cannot disagree.
 */
import type { CorrectionCase, QuarterKey, ReceiptKind, VatRateGroup } from '../../src/types/index.js';
import type { Address, CustomerFields, Exemption, InvoiceCurrency, InvoiceLine, VatRate } from '../../src/invoices/model.js';
import type { VatSetup } from '../../src/workspace/vat-setup.js';

export const YEAR = '2026';

export interface Company { name: string; uid: string; owner: string; address: string[] }

/** A bank account with statements: a camt053 per quarter and a PDF per month. */
export interface StatementBank {
  bank: 'Raiffeisen' | 'Wise'; currency: 'CHF' | 'EUR'; account: string; label: string;
  iban: string; institution: string; opening: number;
}

/**
 * A counterparty on documents and bank lines. `public` marks a real company under its real
 * name and UID; every other UID must have a wrong check digit (generate.ts refuses one that
 * does not), so it can never belong to a real company.
 */
export interface Vendor { name: string; address: string[]; uid?: string; bankName: string; public?: true }

/** A printed document: the receipt facts the index stores, and the lines its PDF shows. */
export interface Doc {
  file: string;
  kind: ReceiptKind;
  date: string;
  description: string;
  currency: string;
  total: number;
  vatId?: string;
  vat: VatRateGroup[];
  lines: string[];
}

/** One booking line of a payment. amount is signed as it moves the bank: + money in, − money out. */
export interface Leg { account: string; amount: number; vatCode?: string; text: string; key?: string }

/**
 * One payment inside a bank booking. A Sammelzahlung has several. A part that pays an issued
 * invoice names its number: its legs only give the amount, the invoice matcher books it
 * (src/invoices/payments.ts), with the invoice PDF as its receipt.
 */
export interface Part { counterparty: string; reference?: string; text: string; legs: Leg[]; doc?: Doc; noReceipt?: string; invoice?: string }

/**
 * Paid by the owner privately (Auslagen): a manual transaction booked on the owner's current
 * account, the way the app records one (POST /api/transactions), not a bank movement.
 */
export const PAID_PRIVATELY = 'owner';

/** `bank` is a key of the demo's banks, or PAID_PRIVATELY. */
export interface Payment { bank: string; date: string; text: string; parts: Part[] }

/**
 * An entry that moves no bank: a private share, a correction. `{id:key}` in the text names a
 * leg's entry id. Its ref is M<year>-nnn, numbered after the payments paid privately, in list order.
 */
export interface ManualEntry {
  date: string; debit: string; credit: string; amount: number; vatCode?: string;
  text: string; currency?: 'EUR'; corrects?: QuarterKey; key: string; doc?: Doc;
}

export interface Scenario {
  payments: Payment[];
  manual: ManualEntry[];
  /** The cases that explain the filed quarter's Korrekturabrechnung; entry ids are given as leg/entry keys. */
  correctionCases: CorrectionCase[];
  /** The bank payment of a filed period's tax, once its figure is known; a firm that files no return has none. */
  taxPayment?(payable: number): Payment;
  /** The bank payment of the filed quarter's Korrekturabrechnung (0535): what the corrections add to its tax. */
  correctionPayment?(difference: number): Payment;
}

/**
 * A demo company's invoicing: its address, the manifest's invoicing block, a logo, customers, and
 * what happened to its invoices in order (tools/demo/invoices.ts plays it through the app's own
 * invoicing service). Invoices are numbered in the order they are issued.
 */
export interface DemoInvoicing {
  address: Address;
  /** The invoicing block of belege.workspace.yaml, as YAML. */
  manifest: string;
  logo?: { file: string; svg: string };
  customers: Record<string, CustomerFields>;
  steps: InvoiceStep[];
}

interface Drafted { key: string; customer: string; at: string; date: string; subject: string; lines: InvoiceLine[]; currency?: InvoiceCurrency; exemption?: Exemption }
export type InvoiceStep =
  | ({ do: 'issue'; paid?: { date: string; bank: string } } & Drafted)
  | ({ do: 'draft' } & Drafted)
  | { do: 'credit'; key: string; of: string; at: string; amount?: number; vatRate?: VatRate; reason: string; settlement?: 'refund' | 'offset' }
  | { do: 'remind'; of: string; at: string; fee?: number }
  | { do: 'cancel'; of: string; at: string; reason: string }
  | { do: 'comment'; of: string; at: string; text: string };

/** One demo workspace: who the company is, its chart and banks, and its year as a Scenario. */
export interface Demo {
  /** The directory under the app root, which is also its VANILLA_WORKSPACE shortcut. */
  dir: string;
  company: Company;
  /** The firm's VAT setup; absent: registered, effective method, quarterly (src/workspace/vat-setup.ts). */
  vat?: VatSetup;
  /** The legal form the manifest names; absent: GmbH. */
  legalForm?: 'GmbH' | 'AG' | 'Einzelfirma';
  closedThrough: string;
  /** The period filed on `closedThrough`, whose return and seal the demo ships; absent (a firm without returns): only the seal of the closed period. */
  filed?: { period: QuarterKey; generationTime: string };
  /** When the closed period was sealed, for a firm without returns (`filed` carries it otherwise). */
  sealedAt?: string;
  banks: Record<string, StatementBank>;
  /** The owner's current account: the manifest's manual account, where PAID_PRIVATELY payments book. */
  ownerAccount: { account: string; label: string };
  /** The other opening balances (CHF) of 1 January; 2970 is derived so the opening balance sheet balances. */
  openingOther: Record<string, number>;
  accounts: ReadonlyArray<readonly [string, string]>;
  vendors: Record<string, Vendor>;
  /** knowledge/<role>/<file>: the workspace's own business files (bindings and private ones). */
  knowledge: Record<string, string>;
  scenario(seed: number): Scenario;
  invoicing?: DemoInvoicing;
}

// ─── numbers and dates ──────────────────────────────────────────────────────

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** Swiss notation, 1’234.50, without the runtime's locale data. */
export function chf(n: number): string {
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, '’')}.${dec}`;
}

/** The tax inside a gross amount, the way src/engines/return.ts extracts it. */
export function taxIn(gross: number, rate: number): number {
  const g = Math.round(gross * 100);
  return (g - Math.round(g * 100 / (100 + rate))) / 100;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A QR reference: 26 digits plus the recursive mod-10 check digit of Swiss payment slips. */
export function qrReference(base: string): string {
  const table = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];
  const digits = base.padStart(26, '0');
  let carry = 0;
  for (const d of digits) carry = table[(carry + Number(d)) % 10];
  return digits + String((10 - carry) % 10);
}

/** True when the UID's last digit is its mod-11 check digit, i.e. it could belong to a real company. */
export function uidChecksumValid(uid: string): boolean {
  const d = uid.replace(/\D/g, '');
  const sum = [5, 4, 3, 2, 7, 6, 5, 4].reduce((s, w, i) => s + w * Number(d[i]), 0);
  const check = (11 - (sum % 11)) % 11;
  return check !== 10 && check === Number(d[8]);
}

export const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const lastDay = (m: number) => new Date(Date.UTC(2026, m, 0)).getUTCDate();

/** The next banking day on or after the date (Saturday and Sunday move to Monday). */
export function bankDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export const dmy = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// ─── documents ──────────────────────────────────────────────────────────────

export interface Item { text: string; gross: number; rate: number }

export interface InvoiceSpec {
  file: string; vendor: Vendor; date: string; title: string; number: string; description: string;
  currency: string; items: Item[]; footer?: string[]; kind?: ReceiptKind;
  /** Who the document is addressed to; the demo company by default. */
  to?: { name: string; address: string[] };
}

/** An invoice or receipt with its items and the MWST summary a Swiss invoice prints, addressed to `company`. */
export function invoicesFor(company: Company): (o: InvoiceSpec) => Doc {
  return (o) => {
    const total = r2(o.items.reduce((s, i) => s + i.gross, 0));
    const rates = [...new Set(o.items.map((i) => i.rate))].sort((a, b) => b - a);
    const vat: VatRateGroup[] = rates.filter((rate) => rate > 0 && o.vendor.uid).map((rate) => {
      const gross = r2(o.items.filter((i) => i.rate === rate).reduce((s, i) => s + i.gross, 0));
      const tax = taxIn(gross, rate);
      return { ratePercent: rate, net: r2(gross - tax), vat: tax, gross };
    });
    const to = o.to ?? company;
    const lines = [
      o.vendor.name, ...o.vendor.address,
      ...(o.vendor.uid ? [`${o.vendor.uid} MWST`] : []),
      '',
      to.name, ...to.address,
      '',
      `${o.title} ${o.number}`,
      `Datum: ${dmy(o.date)}`,
      '',
      ...o.items.map((i) => `${i.text}: ${o.currency} ${chf(i.gross)}`),
      '',
      `Total ${o.currency} ${chf(total)}`,
      ...(vat.length
        ? vat.map((g) => `MWST ${g.ratePercent}% auf ${o.currency} ${chf(g.net!)}: ${o.currency} ${chf(g.vat)}`)
        : [o.vendor.uid ? 'Ohne MWST' : 'Keine Schweizer MWST ausgewiesen']),
      ...(o.footer ? ['', ...o.footer] : []),
    ];
    return {
      file: `${o.file}.pdf`, kind: o.kind ?? 'invoice', date: o.date, description: o.description,
      currency: o.currency, total, ...(o.vendor.uid ? { vatId: o.vendor.uid } : {}), vat, lines,
    };
  };
}
