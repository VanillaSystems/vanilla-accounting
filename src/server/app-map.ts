/**
 * The AI sidebar's map of the app, given to its prompt by the route (src/server/routes/assistant.ts): every area, every section of Firma and the export dialog,
 * named as the person sees them (the UI's own dictionaries, src/app/i18n/locales), never by a path the person does not see, what a person does there, and which changes of the ```vanilla-changes block
 * (src/assistant/changes.ts) do the same from the sidebar. It is the view layer's: it reads the
 * app's own places. The tables are keyed by the app's own
 * lists (AreaId, COMPANY_SECTIONS, PRESETS), so an area or section added without a line here does
 * not compile, and tests/assistant-app-map.test.ts checks every area folder is one of them.
 */
import type { AreaId, CompanySection } from '../app/shell/route.js';
import { PRESETS } from '../export/model.js';
import { wordsIn } from '../export/texts.js';
import type { Change } from '../types/assistant.js';

interface Place {
  /** What a person does there, in English for the model; `{key}` is a text of the UI's in the person's language. */
  does: string;
  /** The changes the sidebar makes that do what a person does there. */
  kinds?: ReadonlyArray<Change['kind']>;
}

export const AREA_PLACES: { readonly [A in AreaId]: Place } = {
  receipts: { does: 'the receipts and supplier invoices: files dropped here (PDFs, photos) are read, matched to their payment and booked; each shows its facts, its payment and its booking; a possible duplicate asks «{drop.twin.same}»', kinds: ['receipt', 'link', 'unlink', 'receiptKind'] },
  invoices: { does: 'the company\'s own invoices to its customers: N writes a new draft (customer, lines with quantity, unit, price, VAT rate); a draft is issued (its number, a PDF with its payment slip), sent by e-mail or downloaded, reminded, cancelled or credited; the customers with address, language and payment term; incoming payments are matched to open invoices', kinds: ['invoiceDraft'] },
  bank: { does: 'the bank statements per account (an XML or PDF statement dropped here), their balance checked; each payment with its booking' },
  journal: { does: 'the bookings: accounts, VAT code, amount, date, text; N adds a booking by hand; filtered by VAT code', kinds: ['entry', 'newEntry', 'deleteEntry'] },
  vat: { does: 'the VAT return per quarter (the tax form\'s lines), each line with the bookings behind it, the file for the tax authority, and the corrections of filed quarters' },
  codes: { does: 'the VAT codes: what each means, which form lines it feeds, when it is used' },
  reports: { does: 'income statement, balance sheet and trial balance, each account\'s ledger' },
  close: { does: 'the year-end close step by step: exchange differences, the closing, the opening of the next year' },
  company: { does: 'the company\'s settings, one section each (below)' },
  automation: { does: 'the workflows (the inbox run that reads, matches and books receipts and payments; collecting receipts from the sources; the VAT filing), their runs, the queue, and the tasks that wait for the person (a payment a rule asks about waits here as «Frag: …»); under «{automation.tasks}» also the questions between the people who keep the books («{questions.forMe}», «{questions.mine}»), each answered there or on its payment, receipt or booking; «{automation.toRules}» leads to the company\'s rules', kinds: ['bookAgain', 'question'] },
  changes: { does: 'changes to how the app works that are not a rule (a workflow, other knowledge) wait here as a draft until the person presses «{changes.save}»; «{changes.history}» lists every save with «{changes.undo}». A rule you draft is kept with «{rules.draft.keep}» on its card under your answer, not here' },
};

export const COMPANY_PLACES: { readonly [S in CompanySection]: Place } = {
  profile: { does: 'name, UID, owner, address' },
  vat: { does: 'the VAT registration and method' },
  banks: { does: 'the bank accounts with their IBAN; a new account' },
  'invoice-layout': { does: 'how invoices look and read: font, colour, logo, envelope window, shown elements, the payment term in days, and per language (de, fr, it, en) the text above and below the table and the e-mail', kinds: ['invoicing'] },
  mail: { does: 'the mailbox the invoices are sent from' },
  sources: { does: 'where receipts come from: mailboxes and web logins; once one is set up, Automatisierung fetches it' },
  rules: { does: 'the company\'s rules, each in plain words with where it came from and how many payments it booked; «{rules.switchOff}» and «{rules.delete}» with an undo. A rule you draft (AGENTS.md, "Rules the app carries out") shows as a card under your answer: the person keeps it with «{rules.draft.keep}» or drops it with «{rules.draft.discard}»; a rule you take out asks «{rules.draft.remove}» there. That one click is all the person does; until then the rule does nothing' },
  phone: { does: 'receipts from the phone: switch on, scan the QR code with the iPhone app to pair; a new code locks out old phones' },
  accounts: { does: 'the chart of accounts: an account renamed or added', kinds: ['account'] },
  periods: { does: 'the filed quarters and their seals' },
  opening: { does: 'the opening balances of the year' },
  display: { does: 'language, theme, the app\'s version' },
};

/** The export dialog (⇧E, «Exportieren»): the presets, each a set of reports, data and originals for a period. */
const EXPORT_DOES = '(⇧E, or the top bar\'s export chip): a dialog, not a place; it packs reports as PDF, data as CSV/Excel/Banana and the original receipts and statements into one ZIP, by preset';

type T = ReturnType<typeof wordsIn>['t'];
const line = (t: T, label: string, p: Place) =>
  `- ${label}: ${p.does.replace(/\{([\w.-]+)\}/g, (_, k: string) => t(k as Parameters<T>[0]))}.${p.kinds?.length ? ` You: ${p.kinds.join(', ')}.` : ''}`;

/** The map as the prompt gives it, the names in the person's language. */
export function appMap(language: string): string {
  const { t } = wordsIn(language);
  const presets = PRESETS.map((p) => `«${t(`export.preset.${p.id}` as 'export.title')}» (preset "${p.id}": ${t(`export.preset.${p.id}Note` as 'export.title')})`).join(', ');
  return [
    'The app, as the person sees it: its places by the names on screen, what a person does there, and which changes of your block do the same. Point the person only to these places, by these names; anything else the app does not have.',
    ...(Object.entries(AREA_PLACES) as Array<[AreaId, Place]>).flatMap(([id, p]) => [
      line(t, t(`area.${id}` as 'export.title'), p),
      ...(id === 'company'
        ? (Object.entries(COMPANY_PLACES) as Array<[CompanySection, Place]>).map(([s, q]) => `  ${line(t, `${t('area.company')} › ${t(`company.${s}` as 'export.title')}`, q)}`)
        : []),
    ]),
    `- ${t('export.dialog')} ${EXPORT_DOES}: ${presets}. You: export.`,
    '- ⌘K searches everything; ⌘J opens and closes you.',
    `Words the person knows: a quarter whose VAT return went to the tax authority is «${t('period.filedShort')}».`,
  ].join('\n');
}
