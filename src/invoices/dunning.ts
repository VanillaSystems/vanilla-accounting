/**
 * Mahnwesen (spec docs/specs/invoicing.md 4.4.7): the firm's Mahnstufen, the next Mahnung of an
 * invoice, default interest, the Mahnlauf's list and what an automatic reminder sends. Pure over the
 * invoice book and the settings, so the API, the run, the automatic reminder and the screens decide
 * the same way.
 *
 * A Mahnung is a document of its own about one invoice: it carries every position, what is still
 * open, a fee and default interest (both without VAT: damages for paying late, no consideration for
 * a supply), a new due date and its level's texts. It books nothing; what a payment pays of its fee
 * and interest is booked with the payment (src/invoices/payments.ts bookPayment).
 */
import { roundCHF } from '../accounting/rappen.js';
import { baseCurrency, invoicing } from '../engines/index.js';
import {
  INVOICE_LANGUAGES,
  type Contact, type DunningLevel, type DunningSettings, type DunningTexts, type Invoice, type InvoiceBook, type InvoiceLanguage, type InvoicingSettings, type Issued, type Reminder, type ReminderInterest,
} from './model.js';
import { InvoiceRuleError, addDays, openAmount, openCharges } from './rules.js';

export { chargesOf, openCharges } from './rules.js';
import { TEXTS, formatDate, kindTitle } from './texts.js';
import { DEFAULT_DUNNING, LEGACY_DUNNING, readDunning } from '../workspace/dunning.js';
import { reminderTitle } from './texts.js';

export { DEFAULT_DUNNING, LEGACY_DUNNING, readDunning, reminderTitle };
import { daysBetween } from './lists.js';

/** At most this many Mahnungen go out in one Mahnlauf; the rest are named («12 weitere nicht»). */
export const MAX_RUN = 40;
/** A comment on an invoice this recent keeps it out of the Mahnlauf: someone spoke to the customer. */
export const COMMENT_DAYS = 7;

/** The Mahnungen sent (kept as sent), oldest first. */
export const sentReminders = (inv: Issued): Reminder[] => inv.reminders.filter((r) => r.documentId);
/** The Mahnung written and not sent yet, if any: at most one, always the last. */
export const reminderDraftOf = (inv: Issued): Reminder | undefined => inv.reminders.find((r) => !r.documentId);


/** A level's title in a language: its own text, else its name. */
export const levelTitle = (level: DunningLevel, lang: InvoiceLanguage): string => level.texts?.[lang]?.title?.trim() || level.name;

/** The Mahnstufe a new Mahnung of `inv` takes: the one after the last sent; at the last, the last again (`repeat`). */
export function nextLevel(inv: Issued, settings: DunningSettings): { level: number; def: DunningLevel; repeat: boolean } {
  const last = sentReminders(inv).at(-1)?.level ?? 0;
  const level = Math.max(1, Math.min(last + 1, settings.levels.length));
  return { level, def: settings.levels[level - 1]!, repeat: last >= settings.levels.length };
}

/** The day what came last fell due: the invoice's, else the last Mahnung's. */
export const dueBase = (inv: Issued): string => sentReminders(inv).at(-1)?.dueDate ?? inv.dueDate;

/** To the books' smallest coin in their own currency, to the cent in another. */
const round = (inv: Pick<Issued, 'currency'>, n: number) => (inv.currency === baseCurrency() ? roundCHF(n) : Math.round(n * 100) / 100);

/**
 * Default interest on what is open, from the printed due date to `date`, at the firm's rate a year
 * (365 days); undefined while the firm charges none or nothing is late.
 */
export function interestOf(inv: Issued, invoices: readonly Invoice[], date: string, settings: DunningSettings): ReminderInterest | undefined {
  const rate = settings.interest?.rate;
  if (!rate) return undefined;
  const days = daysBetween(inv.dueDate, date);
  if (days <= 0) return undefined;
  const amount = round(inv, openAmount(inv, invoices) * rate / 100 * days / 365);
  return amount > 0 ? { rate, from: inv.dueDate, to: date, days, amount } : undefined;
}

/** The financial income account default interest is booked on: the firm's, else the jurisdiction's. */
export const interestAccount = (settings: Pick<InvoicingSettings, 'dunning' | 'revenueAccount'>): string =>
  settings.dunning.interest?.account ?? invoicing().interest?.account ?? settings.revenueAccount;

/** Why an invoice gets no Mahnung at all: not a Rechnung, not issued, cancelled, or nothing open. */
export function assertRemindable(inv: Invoice, invoices: readonly Invoice[]): asserts inv is Issued {
  if (inv.status !== 'issued') throw new InvoiceRuleError('notIssued', 'Nur eine ausgestellte Rechnung wird gemahnt.');
  if (inv.kind !== 'invoice') throw new InvoiceRuleError('creditNote', 'Nur eine Rechnung wird gemahnt.');
  if (inv.cancelled) throw new InvoiceRuleError('cancelled', `Rechnung ${inv.number} ist storniert.`);
  if (openAmount(inv, invoices) === 0) throw new InvoiceRuleError('nothingOpen', `Rechnung ${inv.number} ist bezahlt.`);
}

/**
 * The next Mahnung of an open invoice on `date`, in the invoice's language: its level, title, due
 * date (`date` plus the level's days), fee (the level's, or `fee` when the person names one), default
 * interest and the level's texts (else the app's), all editable before it is sent.
 */
export function draftReminder(inv: Invoice, invoices: readonly Invoice[], date: string, settings: DunningSettings, over: { fee?: number } = {}): Reminder {
  assertRemindable(inv, invoices);
  const { level, def } = nextLevel(inv, settings);
  const lang = inv.language;
  const L = TEXTS[lang];
  const own = def.texts?.[lang];
  const d = (iso: string) => formatDate(iso, lang);
  const previous = sentReminders(inv).at(-1);
  const fill = (s: string) => s.replaceAll('{number}', inv.number).replaceAll('{date}', d(inv.date)).replaceAll('{due}', d(inv.dueDate))
    .replaceAll('{days}', String(def.days)).replaceAll('{previous}', previous ? d(previous.date) : '');
  const fee = over.fee ?? def.fee;
  const interest = interestOf(inv, invoices, date, settings);
  return {
    level,
    title: levelTitle(def, lang),
    date,
    dueDate: addDays(date, def.days),
    ...(fee ? { fee: round(inv, fee) } : {}),
    ...(interest ? { interest } : {}),
    intro: own?.intro ? fill(own.intro) : L.reminderIntro(level, inv.number, d(inv.date), d(inv.dueDate), previous && d(previous.date), def.days),
    closing: own?.closing ? fill(own.closing) : L.reminderClosing,
  };
}

/**
 * Where a Mahnung of `inv` goes by e-mail: the contact person it was sent to, else the contact's
 * first address as it stands now (one added since counts), else the address the invoice froze.
 */
export function reminderAddress(book: Pick<InvoiceBook, 'contacts'>, inv: Issued): string | undefined {
  const c = book.contacts.find((x) => x.id === inv.customerId && !x.deleted);
  const person = c?.persons.find((p) => p.id === inv.personId)?.email;
  return person || c?.emails[0] || inv.customer.email || undefined;
}

// ─── the Mahnlauf ────────────────────────────────────────────────────────────

/** One Mahnung a run proposes. `to`: the e-mail it goes to; absent, it is downloaded. */
export interface RunItem {
  invoiceId: string; number: string; customerId: string; customerName: string; currency: Issued['currency'];
  level: number; title: string; open: number; fee: number; interest: number;
  /** The day what came last fell due, and how many days ago that is on the run's date. */
  dueSince: string; days: number;
  to?: string;
  /** The Mahnung is written already (a draft): the run sends it as it stands. */
  draft?: true;
}

export const LEFT_OUT = ['noReminders', 'comment', 'auto', 'lastLevel', 'notOverdue'] as const;
export type LeftOutReason = (typeof LEFT_OUT)[number];
/** An invoice the run leaves out, with why: `date` is the comment's day, or the day the automatic reminder sends. */
export interface LeftOut { invoiceId: string; number: string; customerName: string; reason: LeftOutReason; date?: string }

export interface RunPlan { date: string; items: RunItem[]; leftOut: LeftOut[]; limit: number; more: number }

/** An invoice overdue on `date`: open, and what came last (the invoice, or its last Mahnung) fell due before it. */
export const overdueOn = (inv: Invoice, invoices: readonly Invoice[], date: string): boolean =>
  inv.status === 'issued' && inv.kind === 'invoice' && !inv.cancelled && inv.date <= date && openAmount(inv, invoices) > 0 && dueBase(inv) < date;

const commentWithin = (inv: Issued, date: string): string | undefined => {
  const from = addDays(date, -COMMENT_DAYS);
  return inv.comments.filter((c) => !c.deleted && c.createdAt.slice(0, 10) >= from && c.createdAt.slice(0, 10) <= date).at(-1)?.createdAt.slice(0, 10);
};

/** The day the next level's automatic reminder sends, when it has one and can (an address, mail set up); undefined otherwise. */
export function autoDay(inv: Issued, book: Pick<InvoiceBook, 'contacts'>, settings: DunningSettings, canMail: boolean): string | undefined {
  const { def, repeat } = nextLevel(inv, settings);
  if (!def.auto || repeat || reminderDraftOf(inv)) return undefined;
  return canMail && reminderAddress(book, inv) ? addDays(dueBase(inv), def.auto.afterDays) : undefined;
}

const contactOf = (book: Pick<InvoiceBook, 'contacts'>, inv: Issued): Contact | undefined => book.contacts.find((c) => c.id === inv.customerId && !c.deleted);

/**
 * The Mahnlauf on `date` (spec 4.4.7): every invoice overdue then with its next level, fee and
 * interest, oldest due first, at most MAX_RUN (`more` counts the rest). Left out, each named with its
 * reason: a contact with «keine Mahnungen», an invoice commented on in the last COMMENT_DAYS days, one
 * whose next level an automatic reminder sends (it would go twice), one at its last level already.
 * `only`: the rows ticked in the table; a ticked one not overdue is named too. `canMail`: the firm's
 * mail is set up, so a Mahnung with an address goes by e-mail.
 */
export function dunningRun(book: InvoiceBook, invoices: readonly Invoice[], settings: DunningSettings, date: string, opts: { only?: readonly string[]; canMail: boolean }): RunPlan {
  const items: RunItem[] = [];
  const leftOut: LeftOut[] = [];
  const pool = opts.only ? invoices.filter((i) => opts.only!.includes(i.id)) : invoices;
  for (const doc of pool) {
    if (doc.status !== 'issued') continue;
    const inv = doc;
    if (!overdueOn(inv, invoices, date)) {
      if (opts.only) leftOut.push({ invoiceId: inv.id, number: inv.number, customerName: inv.customer.name, reason: 'notOverdue' });
      continue;
    }
    const out = (reason: LeftOutReason, day?: string) => leftOut.push({ invoiceId: inv.id, number: inv.number, customerName: inv.customer.name, reason, ...(day ? { date: day } : {}) });
    if (contactOf(book, inv)?.noReminders) { out('noReminders'); continue; }
    const commented = commentWithin(inv, date);
    if (commented) { out('comment', commented); continue; }
    const auto = autoDay(inv, book, settings, opts.canMail);
    if (auto) { out('auto', auto); continue; }
    const draft = reminderDraftOf(inv);
    const { level, repeat } = nextLevel(inv, settings);
    if (repeat && !draft) { out('lastLevel'); continue; }
    const r = draft ?? draftReminder(inv, invoices, date, settings);
    const charges = openCharges(inv);
    const to = opts.canMail ? reminderAddress(book, inv) : undefined;
    items.push({
      invoiceId: inv.id, number: inv.number, customerId: inv.customerId, customerName: inv.customer.name, currency: inv.currency,
      level: draft?.level ?? level, title: reminderTitle(r, inv.language), open: openAmount(inv, invoices),
      fee: Math.round(((r.fee ?? 0) + charges.fee) * 100) / 100, interest: r.interest?.amount ?? charges.interest,
      dueSince: dueBase(inv), days: daysBetween(dueBase(inv), date),
      ...(to ? { to } : {}), ...(draft ? { draft: true as const } : {}),
    });
  }
  items.sort((a, b) => a.dueSince.localeCompare(b.dueSince) || a.number.localeCompare(b.number));
  return { date, items: items.slice(0, MAX_RUN), leftOut, limit: MAX_RUN, more: Math.max(0, items.length - MAX_RUN) };
}

/**
 * What the automatic reminders send on `today`: each overdue invoice whose next level is automatic
 * and whose day («N Tage nach Fälligkeit» of what came last) has come, unless its contact takes no
 * Mahnungen, a person commented on it in the last COMMENT_DAYS days, or a Mahnung of it is being
 * written. Each level is sent once: the next is the level after the last sent.
 */
export function autoDue(book: InvoiceBook, invoices: readonly Invoice[], settings: DunningSettings, today: string): Issued[] {
  return invoices.filter((inv): inv is Issued => {
    if (inv.status !== 'issued' || !overdueOn(inv, invoices, today)) return false;
    const { def, repeat } = nextLevel(inv, settings);
    if (!def.auto || repeat || reminderDraftOf(inv) || contactOf(book, inv)?.noReminders || commentWithin(inv, today)) return false;
    return addDays(dueBase(inv), def.auto.afterDays) <= today;
  });
}
