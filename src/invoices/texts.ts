/**
 * The words printed on an invoice, in the invoice's language. These are document texts, not UI
 * texts: an invoice to a customer in Geneva is French whatever language the app speaks.
 */
import type { Exemption, InvoiceLanguage, OWN_TEXTS, Unit } from './model.js';

export interface InvoiceTexts {
  invoice: string; credit: string; draft: string; reminder: (level: number) => string;
  date: string; due: string; forInvoice: string; yourVat: string; vatSuffix: string; supplied: string;
  desc: string; qty: string; price: string; vat: string; amount: string;
  /** After a line's rate: its price has the VAT in it. */
  included: string;
  net: string; vatOn: (rate: string, net: string) => string; total: string;
  intro: string; closing: (days: number) => string; creditClosing: string;
  /** The e-mail that sends a document; {document} and {company} are filled in. */
  mailSubject: string; mailBody: string;
  reminderIntro: (level: number, no: string, date: string, due: string, previous?: string) => string; reminderClosing: string; fee: string; paidSoFar: string; openNow: string;
  ofInvoice: (no: string, date: string) => string; paidOn: (date: string) => string; creditLine: string;
  refund: (amount: string) => string; offset: (amount: string) => string; stillOpen: (no: string, amount: string) => string;
  stamp: string; cancelledOn: (date: string, reason: string) => string; cancelNotice: (no: string, date: string) => string;
  exemption: Record<Exemption, string>;
  page: (k: number, n: number) => string; cut: string; bank: string; vatNo: string; uidNo: string; payment: string; iban: string; reference: string;
  units: Record<Unit, string>;
}

export const TEXTS: Record<InvoiceLanguage, InvoiceTexts> = {
  de: {
    invoice: 'Rechnung', credit: 'Gutschrift', draft: 'Entwurf', reminder: (n) => `${n}. Mahnung`,
    date: 'Datum', due: 'zahlbar bis', forInvoice: 'zu Rechnung', yourVat: 'Ihre MWST-Nr.', vatSuffix: 'MWST', supplied: 'Leistung',
    desc: 'Beschreibung', qty: 'Menge', price: 'Preis', vat: 'MWST', amount: 'Betrag', included: 'inkl.',
    net: 'Total netto', vatOn: (r, n) => `MWST ${r} % auf ${n}`, total: 'Total',
    intro: 'Vielen Dank für Ihren Auftrag. Wir stellen Ihnen folgende Leistungen in Rechnung:',
    mailSubject: '{document} · {company}', mailBody: 'Guten Tag\n\nIm Anhang finden Sie {document}.\n\nFreundliche Grüsse\n{company}',
    closing: (d) => `Zahlbar innert ${d} Tagen.\nFreundliche Grüsse`, creditClosing: 'Freundliche Grüsse',
    reminderIntro: (lv, no, d, due, prev) => lv === 1
      ? `Unsere Rechnung ${no} vom ${d} war am ${due} fällig. Bis heute haben wir keine Zahlung erhalten. Bitte überweisen Sie den offenen Betrag innert 10 Tagen.`
      : `Trotz unserer Mahnung${prev ? ` vom ${prev}` : ''} ist die Rechnung ${no} vom ${d} noch offen. Bitte überweisen Sie den Betrag innert 10 Tagen.`,
    reminderClosing: 'Falls Sie inzwischen bezahlt haben, betrachten Sie dieses Schreiben als gegenstandslos.\nFreundliche Grüsse', fee: 'Mahngebühr', paidSoFar: 'bereits bezahlt oder gutgeschrieben', openNow: 'Offener Betrag',
    ofInvoice: (no, d) => `Rechnung ${no} vom ${d}`, paidOn: (d) => `bezahlt am ${d}`, creditLine: 'Gutschrift',
    refund: (a) => `Wir überweisen Ihnen ${a} auf Ihr Konto.`, offset: (a) => `Wir verrechnen ${a} mit Ihrer nächsten Rechnung.`,
    stillOpen: (no, a) => `Von Rechnung ${no} bleiben ${a} offen.`,
    stamp: 'STORNIERT', cancelledOn: (d, r) => `Storniert am ${d}${r ? `: ${r}` : ''}. Diese Rechnung ist nicht mehr zu bezahlen.`,
    cancelNotice: (no, d) => `Storno-Mitteilung zu Rechnung ${no} vom ${d}`,
    exemption: {
      abroad: 'Leistung im Ausland, nicht der Schweizer MWST unterstellt (Art. 8 Abs. 1 MWSTG).',
      export: 'Ausfuhr, von der Steuer befreit (Art. 23 Abs. 2 Ziff. 1 MWSTG).',
    },
    page: (k, n) => `Seite ${k} von ${n}`, cut: 'Vor der Einzahlung abzutrennen', bank: 'Bank', vatNo: 'MWST-Nr.', uidNo: 'UID', payment: 'Zahlung', iban: 'IBAN', reference: 'Referenz',
    units: { h: 'h', day: 'Tag', pcs: 'Stk.', flat: 'pauschal', km: 'km' },
  },
  fr: {
    invoice: 'Facture', credit: 'Note de crédit', draft: 'Projet', reminder: (n) => (n === 1 ? '1er rappel' : `${n}e rappel`),
    date: 'Date', due: 'payable jusqu’au', forInvoice: 'concernant la facture', yourVat: 'Votre n° TVA', vatSuffix: 'TVA', supplied: 'Prestation',
    desc: 'Description', qty: 'Quantité', price: 'Prix', vat: 'TVA', amount: 'Montant', included: 'TTC',
    net: 'Total net', vatOn: (r, n) => `TVA ${r} % sur ${n}`, total: 'Total',
    intro: 'Nous vous remercions de votre mandat et vous facturons les prestations suivantes :',
    mailSubject: '{document} · {company}', mailBody: 'Bonjour\n\nVous trouverez en annexe {document}.\n\nMeilleures salutations\n{company}',
    closing: (d) => `Payable dans les ${d} jours.\nMeilleures salutations`, creditClosing: 'Meilleures salutations',
    reminderIntro: (lv, no, d, due, prev) => lv === 1
      ? `Notre facture ${no} du ${d} était payable le ${due}. À ce jour, nous n’avons reçu aucun paiement. Nous vous prions de régler le montant dans les 10 jours.`
      : `Malgré notre rappel${prev ? ` du ${prev}` : ''}, la facture ${no} du ${d} reste impayée. Nous vous prions de régler le montant dans les 10 jours.`,
    reminderClosing: 'Si vous avez entre-temps effectué le paiement, veuillez ne pas tenir compte de ce courrier.\nMeilleures salutations', fee: 'Frais de rappel', paidSoFar: 'déjà payé ou crédité', openNow: 'Montant ouvert',
    ofInvoice: (no, d) => `Facture ${no} du ${d}`, paidOn: (d) => `payée le ${d}`, creditLine: 'Note de crédit',
    refund: (a) => `Nous vous versons ${a} sur votre compte.`, offset: (a) => `Nous déduirons ${a} de votre prochaine facture.`,
    stillOpen: (no, a) => `Il reste ${a} à payer sur la facture ${no}.`,
    stamp: 'ANNULÉE', cancelledOn: (d, r) => `Annulée le ${d}${r ? ` : ${r}` : ''}. Cette facture n’est plus à payer.`,
    cancelNotice: (no, d) => `Avis d’annulation de la facture ${no} du ${d}`,
    exemption: {
      abroad: 'Prestation à l’étranger, non soumise à la TVA suisse (art. 8, al. 1 LTVA).',
      export: 'Exportation, exonérée de la TVA (art. 23, al. 2, ch. 1 LTVA).',
    },
    page: (k, n) => `Page ${k} sur ${n}`, cut: 'A détacher avant le versement', bank: 'Banque', vatNo: 'N° TVA', uidNo: 'IDE', payment: 'Paiement', iban: 'IBAN', reference: 'Référence',
    units: { h: 'h', day: 'jour', pcs: 'pce', flat: 'forfait', km: 'km' },
  },
  it: {
    invoice: 'Fattura', credit: 'Nota di credito', draft: 'Bozza', reminder: (n) => `${n}° sollecito`,
    date: 'Data', due: 'pagabile entro il', forInvoice: 'relativa alla fattura', yourVat: 'Vostro n. IVA', vatSuffix: 'IVA', supplied: 'Prestazione',
    desc: 'Descrizione', qty: 'Quantità', price: 'Prezzo', vat: 'IVA', amount: 'Importo', included: 'incl.',
    net: 'Totale netto', vatOn: (r, n) => `IVA ${r} % su ${n}`, total: 'Totale',
    intro: 'Vi ringraziamo per l’incarico e vi fatturiamo le seguenti prestazioni:',
    mailSubject: '{document} · {company}', mailBody: 'Buongiorno\n\nIn allegato trova {document}.\n\nCordiali saluti\n{company}',
    closing: (d) => `Pagabile entro ${d} giorni.\nCordiali saluti`, creditClosing: 'Cordiali saluti',
    reminderIntro: (lv, no, d, due, prev) => lv === 1
      ? `La nostra fattura ${no} del ${d} era pagabile il ${due}. Finora non abbiamo ricevuto alcun pagamento. Vi preghiamo di versare l’importo entro 10 giorni.`
      : `Nonostante il nostro sollecito${prev ? ` del ${prev}` : ''}, la fattura ${no} del ${d} è ancora aperta. Vi preghiamo di versare l’importo entro 10 giorni.`,
    reminderClosing: 'Se nel frattempo avete già pagato, vogliate considerare nulla la presente.\nCordiali saluti', fee: 'Spese di sollecito', paidSoFar: 'già pagato o accreditato', openNow: 'Importo aperto',
    ofInvoice: (no, d) => `Fattura ${no} del ${d}`, paidOn: (d) => `pagata il ${d}`, creditLine: 'Nota di credito',
    refund: (a) => `Vi rimborsiamo ${a} sul vostro conto.`, offset: (a) => `Dedurremo ${a} dalla vostra prossima fattura.`,
    stillOpen: (no, a) => `Della fattura ${no} restano da pagare ${a}.`,
    stamp: 'ANNULLATA', cancelledOn: (d, r) => `Annullata il ${d}${r ? `: ${r}` : ''}. Questa fattura non è più da pagare.`,
    cancelNotice: (no, d) => `Avviso di annullamento della fattura ${no} del ${d}`,
    exemption: {
      abroad: 'Prestazione all’estero, non soggetta all’IVA svizzera (art. 8 cpv. 1 LIVA).',
      export: 'Esportazione, esente dall’imposta (art. 23 cpv. 2 n. 1 LIVA).',
    },
    page: (k, n) => `Pagina ${k} di ${n}`, cut: 'Da staccare prima del versamento', bank: 'Banca', vatNo: 'N. IVA', uidNo: 'IDI', payment: 'Pagamento', iban: 'IBAN', reference: 'Riferimento',
    units: { h: 'h', day: 'giorno', pcs: 'pz.', flat: 'forfait', km: 'km' },
  },
  en: {
    invoice: 'Invoice', credit: 'Credit note', draft: 'Draft',
    reminder: (n) => (n === 1 ? 'Payment reminder' : n === 2 ? 'Second reminder' : 'Final reminder'),
    date: 'Date', due: 'payable by', forInvoice: 'for invoice', yourVat: 'Your VAT no.', vatSuffix: 'VAT', supplied: 'Supplied',
    desc: 'Description', qty: 'Qty', price: 'Price', vat: 'VAT', amount: 'Amount', included: 'incl.',
    net: 'Net total', vatOn: (r, n) => `VAT ${r} % on ${n}`, total: 'Total',
    intro: 'Thank you for your order. We invoice the following services:',
    mailSubject: '{document} · {company}', mailBody: 'Hello\n\nPlease find attached {document}.\n\nKind regards\n{company}',
    closing: (d) => `Payable within ${d} days.\nKind regards`, creditClosing: 'Kind regards',
    reminderIntro: (lv, no, d, due, prev) => lv === 1
      ? `Our invoice ${no} of ${d} was due on ${due}. We have not received payment yet. Please transfer the amount within 10 days.`
      : `Despite our reminder${prev ? ` of ${prev}` : ''}, invoice ${no} of ${d} is still unpaid. Please transfer the amount within 10 days.`,
    reminderClosing: 'If you have paid in the meantime, please disregard this letter.\nKind regards', fee: 'Reminder fee', paidSoFar: 'already paid or credited', openNow: 'Amount due',
    ofInvoice: (no, d) => `Invoice ${no} of ${d}`, paidOn: (d) => `paid on ${d}`, creditLine: 'Credit note',
    refund: (a) => `We will transfer ${a} to your account.`, offset: (a) => `We will deduct ${a} from your next invoice.`,
    stillOpen: (no, a) => `${a} of invoice ${no} remains open.`,
    stamp: 'CANCELLED', cancelledOn: (d, r) => `Cancelled on ${d}${r ? `: ${r}` : ''}. This invoice is no longer payable.`,
    cancelNotice: (no, d) => `Cancellation of invoice ${no} of ${d}`,
    exemption: {
      abroad: 'Service supplied abroad, not subject to Swiss VAT (Art. 8 para. 1 VAT Act).',
      export: 'Export of goods, exempt from Swiss VAT (Art. 23 para. 2 no. 1 VAT Act).',
    },
    page: (k, n) => `Page ${k} of ${n}`, cut: 'Separate before paying in', bank: 'Bank', vatNo: 'VAT no.', uidNo: 'UID', payment: 'Payment', iban: 'IBAN', reference: 'Reference',
    units: { h: 'h', day: 'day', pcs: 'pcs', flat: 'flat rate', km: 'km' },
  },
};

/** The app's own texts of Firma › Rechnungslayout in a language, the payment term left as {days}; no greeting line. */
export const builtInTexts = (lang: InvoiceLanguage): Record<(typeof OWN_TEXTS)[number], string> => ({
  salutation: '', intro: TEXTS[lang].intro, closing: TEXTS[lang].closing(9999).replace('9999', '{days}'), mailSubject: TEXTS[lang].mailSubject, mailBody: TEXTS[lang].mailBody,
});

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 11.10.2026, or 11 October 2026 in English. */
export function formatDate(iso: string, lang: InvoiceLanguage): string {
  const [y, m, d] = iso.split('-');
  return lang === 'en' ? `${Number(d)} ${MONTHS_EN[Number(m) - 1]} ${y}` : `${d}.${m}.${y}`;
}

/** 1’234.50 (de, it), 1 234.50 (fr), 1,234.50 (en); a minus sign, not a hyphen. */
export function formatAmount(n: number, lang: InvoiceLanguage): string {
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const sep = { fr: ' ', en: ',' }[lang as 'fr' | 'en'] ?? '’';
  return `${n < 0 ? '−' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, sep)}.${dec}`;
}

export const formatQuantity = (q: number): string => (Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000));
