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
import { filing } from '../engines/index.js';
import { wordsIn } from '../export/texts.js';
import type { Change } from '../types/assistant.js';
import { CHOICES, PRIVATE_CHOICES, SALE_CHOICES, type Choice } from '../questions/model.js';
import { normalRate } from '../accounting/sales-without-vat.js';
import { sourcesRunHere } from '../platform/sources/launcher.js';

interface Place {
  /** What a person does there, in English for the model; `{key}` is a text of the UI's in the person's language. */
  does: string;
  /** The changes the sidebar makes that do what a person does there. */
  kinds?: ReadonlyArray<Change['kind']>;
}

export const AREA_PLACES: { readonly [A in AreaId]: Place } = {
  receipts: { does: 'the receipts and supplier invoices: files dropped here (PDFs, photos) are read, matched to their payment and booked; each shows its facts, its payment and its booking; a possible duplicate asks «{drop.twin.same}»; above the list, the ways receipts come in: dragging files, the phone (paired in {area.company} › {company.phone}), and the automatic collection from connected sources (a mailbox is connected in {area.company} › {company.sources}, or by you) with «{inflow.fetch}» and its last run; a receipt no bank payment pays, because the owner paid it privately or in cash, is paid with «{receipts.linkPayment}» › «{receipts.privatePaid}», for its whole amount or only its business part (the rest private and never booked)', kinds: ['receipt', 'link', 'unlink', 'receiptKind', 'privatePayment'] },
  invoices: { does: 'the company\'s sales, in the views Angebote, Aufträge, Lieferscheine, Rechnungen, Gutschriften, Offene Posten, Kontakte, Artikel and Versendet. An Angebot (AN-…), an Auftrag (AU-…, printed as Auftragsbestätigung or Proformarechnung) and a Lieferschein (LS-…, no prices) are written on the same sheet and book nothing; an Angebot holds until its «gültig bis», the person marks it Angenommen or Abgelehnt, and it is Abgelaufen after that day; a position of an Angebot or Auftrag may be an Option, printed but never in the total. From an Angebot «Auftrag erstellen» or «Rechnung erstellen», from an Auftrag «Lieferschein erstellen» or «Rechnung erstellen»: a dialog lists the positions with what is still open, ticked and editable (options unticked); an expired or declined Angebot and more than is open warn («Trotzdem erstellen», «Trotzdem übernehmen»). An Auftrag is Offen, Teilweise or Erledigt by what was delivered and invoiced of it (a Gutschrift takes its quantities back); its Storno is refused while a Rechnung of it stands. The margin\'s Belegkette links every document of the chain. An Angebot or Auftrag goes «Zurück zum Entwurf» keeping its number, after sending only on «Trotzdem bearbeiten». Each kind has its number series ({area.company} › Rechnungslayout › Nummern: a prefix, the year if wanted and the digits, from the next number on). Rechnungen and Gutschriften are tables with status tabs from facts (Alle, Entwürfe, Offen, Überfällig, Teilbezahlt, Bezahlt, Storniert; for Gutschriften Offen, Teilweise, Abgerechnet, Storniert) and «Nicht gesendet» for issued documents that never went out; a column Versand says when and how each went; ticked rows are sent by e-mail together (Senden), their PDFs saved or exported as CSV; a row opens the document beside the table. N writes a new draft (contact, then its contact person for «z. Hd.» and an address, the billing address unless another is picked; positions: items with quantity, unit from the firm\'s list, price, VAT rate and an optional discount %, texts as a title or plain, a Zwischentotal, a Rabatt or Zuschlag on the total above it, a page break, «＋ Artikel» (a search by code or name: code, text, unit, price, VAT rate and revenue account come from the Artikel and stay editable on the position), «＋ Gruppe» (a title over sub-positions, printed with their sum, each counted once in the totals); each position shows the revenue account it books on and its VAT code; prices excl. or incl. VAT for the whole document); positions move by drag or Alt+↑/↓; a position without text or amount is issued only on «Trotzdem ausstellen»; a draft is issued (its number, a PDF with its payment slip), sent by e-mail or downloaded (the detail\'s «PDF herunterladen» of one never sent asks whether to record the download as its sending: «Ja, festhalten» or «Nur ansehen»), reminded, cancelled or credited. Offene Posten lists what is open on a reference date by customer with its age, to print as the Debitorenliste or export as CSV; Kontakte is a table of the firms and persons the firm sells to (number, name, town, what is open, documents, tags; tabs Firmen, Personen, Archiviert), a row opens the contact: its customer number (K-00001, given at its first issued document or by hand), contact persons, addresses marked Rechnungsadresse or Lieferadresse, language, e-mails, UID, its defaults (terms, currency, revenue account, a standing discount every new position takes, «keine Mahnungen»), notes, tags, its documents and open items and its business file of Geschäftspartner (code proposes one by UID, IBAN or name, the person keeps it); a contact a document names is archived, never deleted, one without documents is deleted; «Importieren» reads contacts from a CSV with a column mapping, a preview names each row\'s problem and proposes rows of the same name or UID as the same contact; the units and the default prices are set in {area.company} › Rechnungslayout; Artikel is a table of the products and services (code, name, Ware or Dienstleistung, unit, price net or incl. VAT, VAT kind normal, reduziert, Beherbergung or keine, whose percent comes from the law for the supply day, revenue account, group); a row opens its form; an Artikel a document names is archived, one no document names is deleted; «Importieren» reads Artikel from a CSV with a column mapping and proposes a row of a code already there as the same Artikel; Versendet is every document sent with time, recipient, channel and checksum. Incoming payments are matched to open invoices: by reference, or by number and amount; a payment short by the Skonto of the printed payment terms, within its days, is matched and the Skonto written off by code. An issued invoice shows four figures above its sheet (Betrag, erhalten, gutgeschrieben, offen) and in its margin «Zahlungen» its payments, write-offs and their bookings. «Zahlungseingang erfassen» records money no statement shows (cash, another account) on a bank or the cash box; the statement line that comes later confirms it instead of booking it again. «Weitere» holds «Rest ausbuchen» (the rest written off as Skonto, Rabatt, Verlust, Spesen or Rundung: on the cash basis nothing is booked, on the agreed basis RE-<number>-wo-<k> with the minus VAT codes) and «Ausziffern» (one incoming payment over several open invoices of a customer, an amount each and what becomes of each rest; a surplus stays unallocated; also from the bank\'s page of the payment, with the contact code proposes by invoice number, IBAN or name, and from a contact as «Zahlung ausziffern»); a rest of at most the shortfall limit is offered as Spesen. Cancelling a paid invoice warns: a credit note instead, or «Trotzdem stornieren», which leaves the payment unallocated. «Weitere» also holds «Zurück zum Entwurf», possible only while the document was never sent or downloaded (a sent one\'s dialog says why not), nothing was received, credited or written off, and (agreed basis) its RE- booking lies in an open period: it keeps its number, its PDF stays in the history as replaced; a sent one stays issued and is corrected by a credit note or a Storno. «Konten ändern» changes the revenue account of positions of an issued invoice, never an amount, rate or code: its open bookings change account, a booking of a filed period gets a reclassification RE-<number>-kk-<k> without a VAT code in the open period. Payment terms with an optional Skonto are kept in {area.company} › Rechnungslayout › Konditionen and picked on the draft. You draft invoices; payments, write-offs and allocations are the person\'s clicks', kinds: ['invoiceDraft'] },
  bank: { does: 'the bank statements per account (an XML or PDF statement dropped here), their balance checked; each payment with its booking' },
  journal: { does: 'the bookings: accounts, VAT code, amount, date, text; N adds a booking by hand; filtered by VAT code; a booking without a payment (a depreciation, an accrual) takes its document with «{journal.linkReceipt}», and in {area.receipts} «{receipts.linkPayment}» lists it under «{receipts.bookingsWithoutPayment}»', kinds: ['entry', 'newEntry', 'deleteEntry', 'link'] },
  vat: { does: 'the VAT return per filing period (a quarter, or a half year on the net tax rate method; the tax form\'s lines), each line with the bookings behind it, the file for the tax authority, and the corrections of filed periods; a firm not registered sees its turnover against the registration threshold instead' },
  codes: { does: 'the VAT codes: what each means, which form lines it feeds, when it is used' },
  reports: { does: 'income statement, balance sheet and trial balance, each account\'s ledger' },
  close: { does: 'the year-end close step by step: exchange differences, the closing, the opening of the next year' },
  company: { does: 'the company\'s settings, one section each (below)' },
  automation: { does: 'the workflows (the inbox run that reads, matches and books receipts and payments; collecting receipts from the sources; the VAT filing), their runs, the queue, and the tasks that wait for the person (a payment a rule asks about waits here as «Frag: …»); under «{automation.tasks}» also the questions between the people who keep the books («{questions.forMe}», «{questions.mine}»), each answered there or on its payment, receipt or booking; «{automation.toRules}» leads to the company\'s rules', kinds: ['bookAgain', 'question'] },
  changes: { does: 'changes to how the app works that are not a rule (a workflow, other knowledge) wait here as a draft until the person presses «{changes.save}»; «{changes.history}» lists every save with «{changes.undo}». A rule you draft is kept with «{rules.draft.keep}» on its card under your answer, not here' },
  partners: { does: 'the business partners (suppliers, customers, authorities), one page each: its notes, the prose the person and you write together (knowledge/<role>/<id>.md, edited on the page with «{partners.notes.edit}»), the rules the app carries out for it with how often they booked, and its bookings, receipts, payments and invoices of the open year; a customer of {area.invoices} is the same partner. A sentence of the notes that a rule could carry out is drafted as a rule (AGENTS.md, "Rules the app carries out"), the sentence stays' },
  knowledge: { does: 'how the company works, one prose page per topic (knowledge/company/<topic>.md, «{knowledge.newPage}» adds one), «{knowledge.gaps}» (who decided the open year\'s bookings, payments of no partner, open questions) and «{knowledge.app}» (what the app knows for every company, read only)' },
  payroll: { does: 'the payroll ({area.payroll}): the year\'s months, each month\'s payslips (closed by the person with «{payroll.close}», corrected with «{payroll.correction.add}»), the employees with their dated values, and the settings (social insurances, wage types, accounts). Everything there is done by hand by the person; you never read payroll files and see no salary, name or social security number of it' },
};

export const COMPANY_PLACES: { readonly [S in CompanySection]: Place } = {
  profile: { does: 'name, UID, owner, address' },
  vat: { does: 'the VAT registration and method' },
  banks: { does: 'the bank accounts with their IBAN; «{company.addBank}» adds one (on a ledger account of its own); under «{company.editBanks}» each has «{company.removeBank}», which takes it out again with an undo, refused with the reason while its statements, payments or invoices use it. You cannot add or remove one' },
  'invoice-layout': { does: 'how invoices look and read: font, colour, logo, envelope window, shown elements, the payment term in days, the payment terms (Konditionen: days, an optional Skonto, the text printed, one default), and per language (de, fr, it, en) the text above and below the table and the e-mail', kinds: ['invoicing'] },
  mail: { does: 'the mailbox the invoices are sent from' },
  sources: {
    does: 'where receipts come from: mailboxes and web logins. The person connects a mailbox here with «{sources.addMailbox}» (its address, IMAP server, login and app password), checks it with «{sources.check}», which lists the recent mails it would read, and switches it on with «{sources.approve}»; any source shows what it may reach, «{sources.preview}» runs it without delivering, and «{sources.signIn}» opens the own window of a browser source, where the person signs in. You connect one too: "mailbox" in your block drafts a mailbox as that form does, "source" takes a source you wrote with the person (any channel) into the sources of the company; its card under your answer has the password or key field, «{sources.check}» or «{sources.preview}» and «{sources.approve}»; never ask for or take a password in the chat. '
      + (sourcesRunHere()
        ? 'Once switched on, a mailbox is fetched daily: {area.automation} checks every hour which sources are due, and «{inflow.fetch}» fetches at once'
        : 'This is the Mac app: it fetches through the Mail app of this Mac (a source binding the app\'s Mail code); a mailbox\'s server and a source\'s own code are fetched by the app started on a computer with npm start, and meanwhile the person drags invoices into {area.receipts}'),
    kinds: ['mailbox', 'source'],
  },
  rules: { does: 'the company\'s rules, each in plain words with where it came from and how many payments it booked; «{rules.switchOff}» and «{rules.delete}» with an undo. A rule you draft (AGENTS.md, "Rules the app carries out") shows as a card under your answer: the person keeps it with «{rules.draft.keep}» or drops it with «{rules.draft.discard}»; a rule you take out asks «{rules.draft.remove}» there. That one click is all the person does; until then the rule does nothing' },
  phone: { does: 'receipts from the phone: switch on, scan the QR code with the iPhone app to pair; a new code locks out old phones' },
  accounts: { does: 'the chart of accounts: an account renamed or added', kinds: ['account'] },
  dimensions: { does: 'the reporting dimensions (a project, a cost centre, a location) a booking may carry one value each of, with the values each offers; the person adds, renames and sets values aside here. A booking\'s values are set on the booking (Buchungen) or by a rule (`then.tags`); the income statement filters and groups by them; no VAT figure reads them' },
  periods: { does: 'the filed periods and their seals' },
  opening: { does: 'the opening balances of the year' },
  display: { does: 'language, theme, the app\'s version' },
  ai: { does: 'which AI the app asks for each step on this computer: the Claude subscription (Claude Code), an Anthropic, OpenAI or TypeSafe Jev API key the person pastes there (Jev answers only yes/no and choice questions, such as whether a mail brings a receipt) (kept in the keychain, never in the books; never ask for a key in the chat), and a model per step. The setting belongs to this computer, not to the books' },
};

/** The export dialog (⇧E, «Exportieren»): the presets, each a set of reports, data and originals for a period. */
const EXPORT_DOES = '(⇧E, or the top bar\'s export chip): a dialog, not a place; it packs reports as PDF, data as CSV/Excel/Banana and the original receipts and statements into one ZIP, by preset';

type T = ReturnType<typeof wordsIn>['t'];
const line = (t: T, label: string, p: Place) =>
  `- ${label}: ${p.does.replace(/\{([\w.-]+)\}/g, (_, k: string) => t(k as Parameters<T>[0]))}.${p.kinds?.length ? ` You: ${p.kinds.join(', ')}.` : ''}`;

/**
 * The question cards' buttons as they read (w25, x08): the person answers a question only with
 * these, so the model names no other.
 */
function questionCards(t: T): string {
  const label = (c: Choice) => `«${t(`questions.choice.${c}` as 'questions.choice.private', { rate: String(normalRate()) })}»`;
  const sale = t('questions.sale.text', { who: '…', amount: '…', date: '…' });
  return `- A question's card (${t('automation.tasks')}, and on its item) has the buttons ${PRIVATE_CHOICES.map(label).join(' / ')} for «privat oder geschäftlich?»; the app's own question about a customer payment without an invoice («${sale}») has ${SALE_CHOICES.map(label).join(' / ')}; any question also takes «${t('questions.answerPlaceholder')}». No card has other buttons (${CHOICES.length} in all).`;
}

/** The map as the prompt gives it, the names in the person's language. */
export function appMap(language: string): string {
  const { t } = wordsIn(language);
  // A preset's note names the firm's filing period («Quartal», «Semester», r6f-29).
  const period = t(filing().length === 'half' ? 'period.word.half' : 'period.word.quarter');
  const presets = PRESETS.map((p) => `«${t(`export.preset.${p.id}` as 'export.title')}» (preset "${p.id}": ${t(`export.preset.${p.id}Note` as 'export.title').replace('{period}', period)})`).join(', ');
  return [
    'The app, as the person sees it: its places by the names on screen, what a person does there, and which changes of your block do the same. Point the person only to these places, by these names; anything else the app does not have.',
    ...(Object.entries(AREA_PLACES) as Array<[AreaId, Place]>).flatMap(([id, p]) => [
      line(t, t(`area.${id}` as 'export.title'), p),
      ...(id === 'company'
        ? (Object.entries(COMPANY_PLACES) as Array<[CompanySection, Place]>).map(([s, q]) => `  ${line(t, `${t('area.company')} › ${t(`company.${s}` as 'export.title')}`, q)}`)
        : []),
    ]),
    `- ${t('export.dialog')} ${EXPORT_DOES}: ${presets}. You: export.`,
    questionCards(t),
    '- ⌘K searches everything; ⌘J opens and closes you.',
    `Words the person knows: a quarter whose VAT return went to the tax authority is «${t('period.filedShort')}».`,
  ].join('\n');
}
