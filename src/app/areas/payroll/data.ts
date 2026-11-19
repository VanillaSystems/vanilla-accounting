/**
 * What the Löhne area reads from the API (src/server/routes/payroll.ts, payroll-settings.ts), each by its
 * URL, kept while the page is open and read again after every change: a close, a correction, a new entry
 * changes the year, the month, the payslips and the people at once.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { request } from '../../lib/api.js';
import { booksChanged } from './books-seen.js';
import type { EmployeeRow, MonthView, PayslipView, YearMonth } from '../../../payroll/views.js';
import type { Affected, Difference, EmployeeDetail, RateWarning, SettingsView } from '../../../payroll/settings.js';
import type { CloseWarning } from '../../../payroll/close.js';
import type { MonthLine, PayslipCorrection } from '../../../payroll/model.js';
import type { PaymentRow } from '../../../payroll/payments.js';
import type { InsurerRow, SettlementCompare } from '../../../payroll/insurers.js';
import type { DeclarationRow, Lohnkonto, LohnausweisData } from '../../../payroll/documents.js';
import type { LohnausweisSnapshot, PayslipMail, PayslipSent } from '../../../payroll/service.js';

export interface Overview {
  shown: boolean; year: string; today: string;
  months: YearMonth[]; employees: EmployeeRow[];
  insurances: Array<{ id: string; kind: string; name: string }>;
  federal: string[];
}

export type Payslip = PayslipView & { drift: Difference[]; monthLines: MonthLine[]; paidDifference?: { difference: number; paid: number; account: string; ref: string; date: string } };

export type Load<T> = { state: 'loading' } | { state: 'failed'; error: unknown } | { state: 'ready'; data: T };

const cache = new Map<string, Load<unknown>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const LOADING: Load<never> = { state: 'loading' };

function fetchInto(url: string): Promise<void> {
  return request<unknown>('GET', url).then(
    (data) => { cache.set(url, { state: 'ready', data }); emit(); },
    (error: unknown) => { if (cache.get(url)?.state !== 'ready') { cache.set(url, { state: 'failed', error }); emit(); } },
  );
}

/** The answer of a GET, read once and kept; undefined `url`: nothing to read yet. */
export function usePayroll<T>(url: string | undefined): Load<T> {
  const load = useSyncExternalStore(subscribe, () => (url ? cache.get(url) : undefined) ?? LOADING) as Load<T>;
  if (url && !cache.has(url)) { cache.set(url, LOADING); void fetchInto(url); }
  return load;
}

/** Reads everything shown again (after a change); resolves when it is in. */
export function reloadPayroll(): Promise<void> {
  return Promise.all([...cache.keys()].map(fetchInto)).then(() => undefined);
}

/**
 * Reads the area's data again whenever the books change under it (a bank statement dropped pays a wage,
 * a run books an insurer's payment): Lohnzahlungen says «bezahlt» without a reload.
 */
export function useReloadOnBooks(books: object): void {
  useEffect(() => { if (booksChanged(books)) void reloadPayroll(); }, [books]);
}

export const urls = {
  overview: (year: string) => `/api/payroll?year=${year}`,
  month: (month: string) => `/api/payroll/months/${month}`,
  payslip: (id: string) => `/api/payroll/payslips/${id}`,
  settings: '/api/payroll/settings',
  employee: (id: string, year: string) => `/api/payroll/employees/${encodeURIComponent(id)}?year=${year}`,
  payments: (month: string) => `/api/payroll/payments/${month}`,
  insurers: (year: string) => `/api/payroll/insurances?year=${year}`,
  documents: (year: string) => `/api/payroll/documents/${year}`,
  mail: (id: string) => `/api/payroll/payslips/${id}/mail`,
};

/** The files the server hands out as they are: an issued Lohnausweis, the year's tables as CSV. */
export const files = {
  lohnausweisPdf: (year: string, id: string) => `/payroll/documents/${year}/lohnausweis/${id}.pdf`,
  lohnausweisCsv: (year: string) => `/payroll/documents/${year}/lohnausweis.csv`,
  lohnkontoCsv: (year: string, employee?: string) => `/payroll/documents/${year}/lohnkonto.csv${employee ? `?employee=${encodeURIComponent(employee)}` : ''}`,
  declarationsCsv: (year: string) => `/payroll/documents/${year}/declarations.csv`,
  journalCsv: (month: string) => `/payroll/documents/journal/${month}.csv`,
};

export interface Payments { month: string; rows: PaymentRow[] }
export interface Insurers { year: string; rows: InsurerRow[] }
/** An issued Lohnausweis as the list names it: its figures stay on the server, in its PDF. */
export type Issued = Omit<LohnausweisSnapshot, 'data'>;
export interface Documents {
  year: string;
  people: Array<{ employee: string; name: string; lohnausweis: LohnausweisData }>;
  issued: Issued[];
  declarations: DeclarationRow[];
  lohnkonto: Lohnkonto;
  copyToTaxOffice: boolean;
}

/** A change's answer: saved, or the card of §19.3 first. */
export type Saved<T = object> = ({ saved: true; corrections: PayslipCorrection[]; warnings: RateWarning[] } & T) | { saved: false; affected: Affected[]; reopen?: string; warnings: RateWarning[] };
export type Backdated = 'correct' | 'keep';

export const payrollApi = {
  close: (id: string, confirm = false) => request<{ closed: false; warnings: CloseWarning[] } | { closed: true; id: string; accountsAdded: string[] }>('POST', `/api/payroll/payslips/${id}/close`, { confirm }),
  closeMonth: (month: string, confirm = false) => request<{ closed: string[]; warned: Array<{ id: string; name: string; warnings: CloseWarning[] }> }>('POST', `/api/payroll/months/${month}/close`, { confirm }),
  reopen: (id: string) => request<{ reopened: true; removed: string[]; kept: string[] }>('POST', `/api/payroll/payslips/${id}/reopen`),
  correct: (id: string, body: { wageType: string; amount?: number; base?: number; rateDiff?: number; text?: string }) => request<PayslipCorrection>('POST', `/api/payroll/payslips/${id}/corrections`, body),
  addLine: (body: { employee: string; month: string; wageType: string; amount?: number; quantity?: number; rate?: number; text?: string }) => request<MonthLine>('POST', '/api/payroll/month-lines', body),
  removeLine: (id: string) => request<{ removed: string }>('DELETE', `/api/payroll/month-lines/${id}`),
  monthText: (month: string, text: string) => request<{ text: string }>('PUT', `/api/payroll/months/${month}/text`, { text }),
  createEmployee: (body: Record<string, unknown>, backdated?: Backdated) => request<Saved<{ id: string }>>('POST', '/api/payroll/employees', { ...body, ...(backdated ? { backdated } : {}) }),
  patchEmployee: (id: string, body: Record<string, unknown>, backdated?: Backdated) => request<Saved>('PATCH', `/api/payroll/employees/${encodeURIComponent(id)}`, { ...body, ...(backdated ? { backdated } : {}) }),
  socialSecurityNumber: (id: string) => request<{ socialSecurityNumber: string | null }>('GET', `/api/payroll/employees/${encodeURIComponent(id)}/social-security-number`),
  addEntry: (body: { path: string; validFrom: string; validUntil?: string; value: unknown }, backdated?: Backdated) => request<Saved>('POST', '/api/payroll/entries', { ...body, ...(backdated ? { backdated } : {}) }),
  withdraw: (body: { path: string; validFrom: string; enteredAt: string }, backdated?: Backdated) => request<Saved>('POST', '/api/payroll/entries/withdraw', { ...body, ...(backdated ? { backdated } : {}) }),
  createInsurance: (body: Record<string, unknown>, backdated?: Backdated) => request<Saved<{ id: string }>>('POST', '/api/payroll/insurances', { ...body, ...(backdated ? { backdated } : {}) }),
  patchInsurance: (id: string, body: Record<string, unknown>, backdated?: Backdated) => request<Saved>('PATCH', `/api/payroll/insurances/${id}`, { ...body, ...(backdated ? { backdated } : {}) }),
  addSolution: (id: string, body: Record<string, unknown>, backdated?: Backdated) => request<Saved>('POST', `/api/payroll/insurances/${id}/solutions`, { ...body, ...(backdated ? { backdated } : {}) }),
  setWageType: (key: string, body: Record<string, unknown>, backdated?: Backdated) => request<Saved>('PUT', `/api/payroll/wage-types/${encodeURIComponent(key)}`, { ...body, ...(backdated ? { backdated } : {}) }),
  copyWageType: (body: Record<string, unknown>, backdated?: Backdated) => request<Saved<{ key: string }>>('POST', '/api/payroll/wage-types', { ...body, ...(backdated ? { backdated } : {}) }),
  removeWageType: (key: string, backdated?: Backdated) => request<Saved>('DELETE', `/api/payroll/wage-types/${encodeURIComponent(key)}`, backdated ? { backdated } : undefined),
  addAccount: (number: string) => request<{ number: string; name: string }>('POST', '/api/payroll/accounts', { number }),
  settle: (id: string, body: { year: string; total: number; date: string; confirm?: boolean }) => request<{ booked: string; amount: number; debit: string; credit: string; compare: SettlementCompare } | { booked: null; warning?: true; compare: SettlementCompare; decemberOpen?: string[] }>('POST', `/api/payroll/insurances/${encodeURIComponent(id)}/settle`, body),
  settleCompare: (id: string, year: string) => request<{ year: string; compare: SettlementCompare | null; why?: string; decemberOpen: string[] }>('GET', `/api/payroll/insurances/${encodeURIComponent(id)}/compare?year=${year}`),
  setOpening: (id: string, year: string, value: Record<string, unknown> | null, backdated?: Backdated) => request<Saved>('PUT', `/api/payroll/employees/${encodeURIComponent(id)}/opening/${year}`, { value, ...(backdated ? { backdated } : {}) }),
  issueLohnausweis: (year: string, body: { employee: string; kind?: 'replacement' | 'correction'; confirm?: boolean }) => request<Issued | { issued: false; openMonths: string[]; noSocialSecurityNumber?: true }>('POST', `/api/payroll/documents/${year}/lohnausweis`, body),
  mailOf: (id: string) => request<PayslipMail>('GET', `/api/payroll/payslips/${id}/mail`),
  send: (id: string) => request<PayslipSent>('POST', `/api/payroll/payslips/${id}/send`),
  mailPassword: (employee: string, body: { password?: string; confirm?: boolean }) => request<{ password?: string; warn?: 'birthDate' }>('POST', `/api/payroll/employees/${encodeURIComponent(employee)}/mail-password`, body),
};

export type { PaymentRow, InsurerRow, PayslipMail, PayslipSent, LohnausweisData };

export type { EmployeeDetail, SettingsView, MonthView, YearMonth, EmployeeRow, Affected, Difference };
