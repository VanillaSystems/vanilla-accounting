/**
 * What every demo company is made of. A demo is a story told as a list of Payments (every bank
 * movement, and every expense the owner paid privately) plus a few ManualEntries; the books, the
 * receipts, the camt053 statements and the filed return are all derived from it by
 * tools/demo/generate.ts, so they cannot disagree.
 */
import type { CorrectionCase, QuarterKey, ReceiptKind, VatRateGroup } from '../../src/types/index.js';
import type { ArticleInput } from '../../src/invoices/articles.js';
import type { Address, ContactFields, CustomerFields, DocumentKind, Exemption, InvoiceCurrency, InvoiceLine, Prices, Schedule, Stage, VatRate, WriteOffReason } from '../../src/invoices/model.js';
import type { VatSetup } from '../../src/workspace/vat-setup.js';
import { LEGACY_DUNNING } from '../../src/workspace/dunning.js';

export const YEAR = '2026';

/**
 * The Mahnwesen block a demo of a firm of before carries: what the manifest step 6 → 7 writes
 * (src/workspace/schema.ts, LEGACY_DUNNING), so a copy of the books that migrates gets the manifest
 * the app ships. Appended at the end of a demo's `invoicing:` section, where the step puts it.
 */
export const LEGACY_DUNNING_YAML = ['  dunning:', '    levels:', ...LEGACY_DUNNING.levels.flatMap((l) => [
  `      - name: ${l.name}`, `        days: ${l.days}`,
  ...(l.texts ? ['        texts:', ...Object.entries(l.texts).map(([lang, t]) => `          ${lang}: { title: ${t!.title} }`)] : []),
])].join('\n');

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
export interface Part {
  counterparty: string; reference?: string; text: string; legs: Leg[]; doc?: Doc; noReceipt?: string; invoice?: string;
  /**
   * A payment of the demo's invoices that no reference ties to one: the person settles it in the
   * app after the import (tools/demo/invoices.ts settle): `hand`, the statement row that confirms a
   * Zahlungseingang she entered by hand before; `allocate`, one payment she ausziffert over several
   * invoices. `step` is the key of that invoicing step. Its legs only give the amount.
   */
  settles?: { kind: 'hand' | 'allocate'; step: string };
}

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
  /** The CHF account has a QR-IBAN: a CHF invoice carries a QR reference, else a creditor reference (SCOR). */
  qrr: boolean;
  /** The cash box (role cash) a Zahlungseingang by hand may land on. */
  cash?: { account: string; label: string };
  /** The invoicing block of belege.workspace.yaml, as YAML. */
  manifest: string;
  logo?: { file: string; svg: string };
  customers: Record<string, CustomerFields>;
  /** Artikel the firm sells (invoices.json articles), made after the documents of `steps`, which name none of them; a Rechnung of `sales` may. */
  articles?: ArticleInput[];
  steps: InvoiceStep[];
  /**
   * Phase 2 of invoicing (spec 5 «Phase 2»): contacts of the new shape and the chain Angebot →
   * Auftrag → Lieferschein → Rechnung, played after the Artikel from a seed of their own, so every
   * record and entry made before keeps its id. A Rechnung here continues the firm's series.
   */
  sales?: { contacts?: Record<string, ContactFields>; steps: SalesStep[] };
}

/**
 * A step of phase 2. `customer` names a key of `customers` or of `sales.contacts`; `person` and
 * `address` the contact person's and the address's id there. A position `{ article, quantity }`
 * is the Artikel position «＋ Artikel» makes from the Artikel with that code.
 * `issue` makes a document of `kind` and issues it (only drafts it with `draft`); `convert` makes
 * the draft of `to` from the document `of` with the ticked positions (`lines`: the source's
 * position index and quantity) and issues it unless `draft`; `answer`: the customer's answer to an
 * Angebot, the person's click.
 */
export type SalesLine = InvoiceLine | { article: string; quantity: number };
interface Addressed { person?: string; address?: string }
export type SalesStep =
  | ({ do: 'issue'; key: string; kind: DocumentKind; customer: string; at: string; date: string; subject: string; lines: SalesLine[]; validUntil?: string; prices?: Prices; ordered?: string; send?: DemoSend; draft?: boolean } & Addressed)
  | ({ do: 'convert'; key: string; of: string; to: DocumentKind; at: string; lines: Array<{ line: number; quantity: number }>; confirm?: string[]; send?: DemoSend; draft?: boolean } & Addressed)
  | { do: 'answer'; of: string; at: string; answer: 'accepted' | 'declined' };

interface Drafted {
  key: string; customer: string; at: string; date: string; subject: string; lines: InvoiceLine[]; currency?: InvoiceCurrency; exemption?: Exemption;
  prices?: Prices; termsId?: string; supplied?: { from: string; to?: string };
}
/** How an issued document went out: by e-mail (the default), downloaded to be sent another way, or not yet. */
export type DemoSend = 'email' | 'download' | 'none';
export type InvoiceStep =
  /** `paid`: the customer pays by the invoice's reference, `amount` (absent: all of it) arrives on `date`. */
  | ({ do: 'issue'; send?: DemoSend; paid?: { date: string; bank: string; amount?: number } } & Drafted)
  | ({ do: 'draft' } & Drafted)
  /** An Auftrag with its Teilrechnungsplan (spec 4.4.9), issued and sent; numbered in its own series. */
  | ({ do: 'order'; send?: DemoSend; stages: Stage[] } & Drafted)
  /**
   * The Rechnung of stage `stage` of the Auftrag `of` (a Teilrechnung; the last stage or `final` the
   * Schlussrechnung, which deducts every Teilrechnung issued before it), issued and sent on `at`;
   * `schedule` a retention entered at issue; `paid` as an invoice's.
   */
  | { do: 'stage'; key: string; of: string; stage: number | 'final'; at: string; send?: DemoSend; schedule?: Schedule; paid?: { date: string; bank: string; amount?: number } }
  | { do: 'credit'; key: string; of: string; at: string; amount?: number; vatRate?: VatRate; reason: string; settlement?: 'refund' | 'offset'; send?: DemoSend }
  | { do: 'remind'; of: string; at: string; fee?: number }
  | { do: 'cancel'; of: string; at: string; reason: string }
  | { do: 'comment'; of: string; at: string; text: string }
  /**
   * What the person does in the app once the statements are imported, played on the books after
   * the import (tools/demo/invoices.ts settle), each on its own day:
   * `hand`: a Zahlungseingang entered by hand on `account` (a bank or the cash box); with
   * `statement`, the bank's row arrives later and confirms it, one booking.
   * `allocate`: one payment without a reference (on `bank`, `date`, its text) ausgeziffert over
   * several invoices, each part's rest left open or written off.
   * `write-off`: «Rest ausbuchen» of what an invoice has open.
   */
  | { do: 'hand'; key: string; of: string; at: string; account: string; amount?: number; statement?: { date: string; bank: string } }
  | { do: 'allocate'; key: string; at: string; bank: string; payer: string; text: string; parts: Array<{ of: string; amount: number; rest?: WriteOffReason }> }
  | { do: 'write-off'; of: string; at: string; reason: WriteOffReason; note?: string };

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
  /** knowledge/<role>/<file>: the workspace's own business files (bindings and private ones) and their notes (<id>.md); knowledge/company/<topic>.md: its pages of Arbeitsweise. */
  knowledge: Record<string, string>;
  scenario(seed: number): Scenario;
  invoicing?: DemoInvoicing;
  /** payroll.json: the firm's payroll in the app (docs/specs/payroll.md), for a demo that runs it. */
  payroll?: PayrollStore;
}

import type { PayrollStore } from '../../src/payroll/model.js';

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
