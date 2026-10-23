/**
 * A report as the app ran it (src/reports/run.ts): its rows, groups and totals, what the sidebar's
 * card, Eigene Berichte and the files show. Every figure in it is computed by code.
 */
import type { Period } from '../accounting/periods.js';
import type { ReportSection, ReportSpec } from './spec.js';

export interface ReportRow {
  date: string;
  text: string;
  account: string;
  counterAccount: string;
  vatCode: string;
  amount: number;
  net: number;
  tax: number;
  /** The currency of `amount`: a booking's is the books' currency, whatever the payment was paid in. */
  currency: string;
  /** The receipts' file names, ` | ` between them. */
  receipt: string;
  counterparty: string;
  /** What the row is, for a link to it. */
  link: { kind: 'entry' | 'payment' | 'receipt' | 'invoice'; id: string };
  /** A booking's reporting dimensions (#127): what a tag grouping groups by. */
  tags?: Record<string, string>;
}

/** The sums of rows in one currency. */
export interface Totals { currency: string; count: number; amount: number; net: number; tax: number }

export interface ReportGroup {
  /** The month (2026-07), the quarter (2026-Q3), the account, the other party or the VAT code; '' for none of them. */
  key: string;
  /** The account's or the other party's name; '' where the key says it. */
  label: string;
  rows: ReportRow[];
  totals: Totals[];
}

export interface SectionResult {
  section: ReportSection;
  groups: ReportGroup[];
  totals: Totals[];
  count: number;
}

export interface ReportResult {
  spec: ReportSpec;
  period: Period;
  currency: string;
  sections: SectionResult[];
  totals: Totals[];
  count: number;
  /** The VAT the shown bookings hold in their gross amounts, not yet settled (as Bilanz and ER say it); absent when none carries a code. */
  vat?: { owed: number; input: number; acquisition: number; net: number };
  /** Where Bilanz and ER put that VAT within the year, on a jurisdiction whose statements are net: the rows' net is what they show. */
  vatAccount?: string;
}
