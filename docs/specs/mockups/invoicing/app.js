// Clickable prototype of docs/specs/invoicing.md, phases 1 to 3 (docs/specs/mockups/invoicing).
// app.html is a capture of the real Rechnungen area (demo workspace, read-only server): its shell and CSS.
// This script plays the list, the detail and the dialogs with the app's own class names. Nothing here
// talks to the app; the data are the demos' (Muster Kaffee GmbH, Salon Beispiel), extended for the spec.
'use strict';

const TODAY = '2026-11-14';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const fmt = (x) => { const neg = r2(x) < 0; const [i, d] = Math.abs(r2(x)).toFixed(2).split('.'); return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}.${d}`; };
const dmy = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const days = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 864e5);
const clone = (x) => JSON.parse(JSON.stringify(x));
const qty = (q) => String(q).replace('.', '.');

const svg = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  chev: svg('<path d="m9 6 6 6-6 6"></path>', 'i chev'),
  gch: svg('<path d="m9 6 6 6-6 6"></path>', 'gch'),
  dl: svg('<path d="M12 15V3"></path><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m7 10 5 5 5-5"></path>'),
  plus: svg('<path d="M12 5v14M5 12h14"></path>'),
  check: svg('<path d="M5 12l5 5 9-10"></path>'),
  print: svg('<path d="M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z"></path>'),
  dot: '<span class="dot" aria-hidden="true"></span>',
};

// ---------------------------------------------------------------- texts on paper (src/invoices/texts.ts)
const UNITS = { h: 'h', day: 'Tag', pcs: 'Stk.', flat: 'pauschal', km: 'km', m2: 'm²', m: 'm', m3: 'm³', l: 'l', kg: 'kg', month: 'Monat' };
const NEW_UNITS = ['m2', 'm', 'm3', 'l', 'kg', 'month'];
const T = {
  de: {
    invoice: 'Rechnung', credit: 'Gutschrift', quote: 'Offerte', order: 'Auftragsbestätigung', delivery: 'Lieferschein', receipt: 'Quittung', draft: 'Entwurf', reminder: (n) => `${n}. Mahnung`,
    date: 'Datum', due: 'zahlbar bis', valid: 'gültig bis', forInvoice: 'zu Rechnung', yourVat: 'Ihre MWST-Nr.', supplied: 'Leistung',
    desc: 'Beschreibung', qty: 'Menge', price: 'Preis', vat: 'MWST', amount: 'Betrag', incl: 'inkl.',
    net: 'Total netto', vatOn: (r, n) => `MWST ${r} % auf ${n}`, total: 'Total', sub: 'Zwischentotal',
    intro: 'Vielen Dank für Ihren Auftrag. Wir stellen Ihnen folgende Leistungen in Rechnung:',
    quoteIntro: 'Gerne offerieren wir Ihnen folgende Leistungen:',
    orderIntro: 'Wir danken für Ihren Auftrag und bestätigen ihn wie folgt:', deliveryIntro: 'Wir liefern Ihnen:',
    deliveryClosing: 'Ware erhalten, Datum und Unterschrift:', option: 'Option', optNote: 'Optionen, nicht im Total', fromDoc: (k, no) => `zu ${k} ${no}`,
    receiptIntro: 'Vielen Dank für Ihren Besuch. Wir bestätigen den Erhalt von:',
    closing: (d, who, skonto) => `Zahlbar innert ${d} Tagen${skonto ? `, mit ${skonto.percent} % Skonto innert ${skonto.days} Tagen` : ''}.\nFreundliche Grüsse, ${who}`,
    quoteClosing: (who) => `Wir freuen uns auf Ihren Auftrag.\nFreundliche Grüsse, ${who}`,
    thanks: (who) => `Freundliche Grüsse, ${who}`,
    reminderIntro: (no, d, due) => `Unsere Rechnung ${no} vom ${d} war am ${due} fällig. Bis heute haben wir keine Zahlung erhalten. Bitte überweisen Sie den offenen Betrag innert 10 Tagen.`,
    reminderClosing: (who) => `Falls Sie inzwischen bezahlt haben, betrachten Sie dieses Schreiben als gegenstandslos.\nFreundliche Grüsse, ${who}`,
    fee: 'Mahngebühr', interest: (r, from, n) => `Verzugszins ${r} % ab ${from} (${n} Tage)`, openNow: 'Offener Betrag', paidSoFar: 'bereits bezahlt oder gutgeschrieben',
    offset: (a) => `Wir verrechnen ${a} mit Ihrer nächsten Rechnung.`, ofInvoice: (no, d) => `Rechnung ${no} vom ${d}`,
    paidNote: (d, m) => `Bezahlt am ${d} ${m}.`, means: { cash: 'in bar', twint: 'mit TWINT', card: 'mit Karte' },
    exemption: { abroad: 'Leistung im Ausland, nicht der Schweizer MWST unterstellt (Art. 8 Abs. 1 MWSTG).', export: 'Ausfuhr, von der Steuer befreit (Art. 23 Abs. 2 Ziff. 1 MWSTG).' },
    cut: 'Vor der Einzahlung abzutrennen', bank: 'Bank', vatNo: 'MWST-Nr.', uidNo: 'UID', payment: 'Zahlung', iban: 'IBAN', reference: 'Referenz', vatSuffix: 'MWST',
    qr: { receipt: 'Empfangsschein', part: 'Zahlteil', account: 'Konto / Zahlbar an', ref: 'Referenz', info: 'Zusätzliche Informationen', by: 'Zahlbar durch', cur: 'Währung', amt: 'Betrag', accept: 'Annahmestelle' },
    units: UNITS,
  },
  fr: {
    invoice: 'Facture', credit: 'Note de crédit', quote: 'Offre', order: 'Confirmation de commande', delivery: 'Bulletin de livraison', receipt: 'Quittance', draft: 'Projet', reminder: (n) => `${n}e rappel`,
    date: 'Date', due: 'payable jusqu’au', valid: 'valable jusqu’au', forInvoice: 'pour la facture', yourVat: 'Votre no TVA', supplied: 'Prestation',
    desc: 'Description', qty: 'Quantité', price: 'Prix', vat: 'TVA', amount: 'Montant', incl: 'incl.',
    net: 'Total net', vatOn: (r, n) => `TVA ${r} % sur ${n}`, total: 'Total', sub: 'Sous-total',
    intro: 'Nous vous remercions de votre mandat et vous facturons les prestations suivantes :',
    quoteIntro: 'Nous avons le plaisir de vous proposer :', orderIntro: 'Nous vous remercions de votre commande et la confirmons comme suit :', deliveryIntro: 'Nous vous livrons :',
    deliveryClosing: 'Marchandise reçue, date et signature :', option: 'Option', optNote: 'Options, non comprises dans le total', fromDoc: (k, no) => `selon ${k} ${no}`,
    receiptIntro: 'Merci de votre visite. Nous confirmons avoir reçu :',
    closing: (d, who, skonto) => `Payable dans les ${d} jours${skonto ? `, escompte de ${skonto.percent} % dans les ${skonto.days} jours` : ''}.\nMeilleures salutations, ${who}`,
    quoteClosing: (who) => `Dans l’attente de votre commande.\nMeilleures salutations, ${who}`, thanks: (who) => `Meilleures salutations, ${who}`,
    reminderIntro: (no, d, due) => `Notre facture ${no} du ${d} était payable le ${due}. À ce jour, nous n’avons reçu aucun paiement. Nous vous prions de verser le montant ouvert dans les 10 jours.`,
    reminderClosing: (who) => `Si vous avez payé entre-temps, veuillez considérer ce courrier comme sans objet.\nMeilleures salutations, ${who}`,
    fee: 'Frais de rappel', interest: (r, from, n) => `Intérêt moratoire ${r} % dès le ${from} (${n} jours)`, openNow: 'Montant ouvert', paidSoFar: 'déjà payé ou crédité',
    offset: (a) => `Nous compensons ${a} avec votre prochaine facture.`, ofInvoice: (no, d) => `Facture ${no} du ${d}`,
    paidNote: (d, m) => `Payé le ${d} ${m}.`, means: { cash: 'en espèces', twint: 'par TWINT', card: 'par carte' },
    exemption: { abroad: 'Prestation à l’étranger (art. 8 al. 1 LTVA).', export: 'Exportation exonérée (art. 23 al. 2 ch. 1 LTVA).' },
    cut: 'A détacher avant le versement', bank: 'Banque', vatNo: 'No TVA', uidNo: 'IDE', payment: 'Paiement', iban: 'IBAN', reference: 'Référence', vatSuffix: 'TVA',
    qr: { receipt: 'Récépissé', part: 'Section paiement', account: 'Compte / Payable à', ref: 'Référence', info: 'Informations supplémentaires', by: 'Payable par', cur: 'Monnaie', amt: 'Montant', accept: 'Point de dépôt' },
    units: { ...UNITS, pcs: 'pce', day: 'jour', flat: 'forfait', month: 'mois' },
  },
};

// ---------------------------------------------------------------- the demo data, extended for the spec
const FIRMS = {
  kaffee: {
    name: 'Muster Kaffee GmbH', owner: 'Anna Muster', street: 'Musterstrasse 1', town: '8000 Zürich', uid: 'CHE-123.456.789', vat: true,
    logo: true, accent: '#5a3a22', bankCHF: 'Raiffeisen', qrIban: 'CH44 3199 9123 0008 8901 2', ibanCHF: 'CH65 8080 8000 0000 0000 1', ibanEUR: 'BE29 9670 0000 0164', bankEUR: 'Wise',
    revenue: { 2.6: ['3300', 'Ertrag Grosshandel'], 8.1: ['3600', 'Ertrag Schulungen und Service'], 0: ['3300', 'Ertrag Grosshandel'] }, bankAcc: { CHF: ['1021', 'Bank Raiffeisen'], EUR: ['1023', 'Wise EUR'] },
  },
  salon: {
    name: 'Salon Beispiel', owner: 'Bella Beispiel', street: 'Marktgasse 5', town: '3011 Bern', uid: 'CHE-975.310.864', vat: false,
    logo: false, accent: '#9f1239', bankCHF: 'Raiffeisen', ibanCHF: 'CH65 8080 8000 0000 0000 1',
    revenue: { 0: ['3400', 'Ertrag Coiffure'] }, bankAcc: { CHF: ['1020', 'Bank Raiffeisen'] },
  },
};
const MEANS_ACC = { cash: ['1000', 'Kasse'], twint: ['1020', 'Bank Raiffeisen'], card: ['1020', 'Bank Raiffeisen'] };

const L = (t, q, unit, p, rate, more = {}) => ({ text: t, q, unit, p, rate, ...more });
function baseline() {
  const kaffee = {
    customers: [
      { id: 'c1', no: 'K-1001', name: 'Beispiel Bistro AG', street: 'Seeweg 12', town: '3000 Bern', country: 'CH', lang: 'de', vatId: 'CHE-987.654.320 MWST', email: 'buchhaltung@bistro.example', terms: 30 },
      { id: 'c2', no: 'K-1002', name: 'Muster Hotel GmbH', attn: 'Küche, z. H. Herr Beispiel', street: 'Pilatusstrasse 9', town: '6003 Luzern', country: 'CH', lang: 'de', email: 'kueche@musterhotel.example', terms: 20, contacts: ['Herr Beispiel (Küche)', 'buchhaltung@musterhotel.example (Rechnungen)'] },
      { id: 'c3', no: 'K-1003', name: 'Café Exemple Sàrl', street: 'Rue du Marché 12', town: '1204 Genève', country: 'CH', lang: 'fr', vatId: 'CHE-111.222.334 TVA', email: 'compta@cafe-exemple.example', terms: 30 },
      { id: 'c4', no: 'K-1004', name: 'Kaffeehaus Beispiel GmbH', street: 'Lindenstrasse 7', town: '80331 München', country: 'DE', countryName: 'DEUTSCHLAND', lang: 'de', vatId: 'DE999999999', email: 'einkauf@kaffeehaus-beispiel.example', terms: 30, currency: 'EUR' },
      { id: 'c5', no: 'K-1005', name: 'Gemeinde Beispielwil', attn: 'Finanzverwaltung', street: 'Dorfplatz 1', town: '3999 Beispielwil', country: 'CH', lang: 'de', email: 'finanzen@beispielwil.example', terms: 30, noReminders: true },
    ],
    docs: [
      { id: 'i1', kind: 'invoice', number: '2026-001', status: 'issued', cu: 'c1', subject: 'Hausmischung und Barista-Schulung', date: '2026-07-06', due: '2026-08-05', cur: 'CHF', lang: 'de', ref: '00 00000 00000 00000 00202 60013',
        lines: [L('Hausmischung Espresso, Bohnen 1 kg', 20, 'pcs', 28, 2.6), L('Barista-Schulung im Betrieb', 3, 'h', 120, 8.1)],
        payments: [{ date: '2026-08-04', amount: 963.72, by: 'QR-Referenz' }], sent: [{ date: '2026-07-06', time: '09:12', to: 'buchhaltung@bistro.example', title: 'Rechnung 2026-001' }], log: [['2026-07-06', 'ausgestellt, Nr. 2026-001'], ['2026-08-04', 'bezahlt, zugeordnet über die QR-Referenz']] },
      { id: 'i2', kind: 'invoice', number: '2026-002', status: 'issued', cu: 'c2', subject: 'Filterkaffee und Wartung', date: '2026-07-20', due: '2026-08-09', cur: 'CHF', lang: 'de', ref: '00 00000 00000 00000 00202 60024',
        lines: [L('Filterkaffee Guji, Bohnen 500 g', 24, 'pcs', 16.5, 2.6), L('Wartung Siebträgermaschine, inkl. Dichtungen', 1, 'flat', 180, 8.1)],
        payments: [{ date: '2026-08-17', amount: 600.88, by: 'QR-Referenz' }], sent: [{ date: '2026-07-20', time: '14:30', to: 'kueche@musterhotel.example', title: 'Rechnung 2026-002' }], log: [['2026-07-20', 'ausgestellt, Nr. 2026-002'], ['2026-08-17', 'bezahlt, zugeordnet über die QR-Referenz']] },
      { id: 'i3', kind: 'invoice', number: '2026-003', status: 'issued', cu: 'c1', subject: 'Hausmischung August', date: '2026-08-17', due: '2026-09-16', cur: 'CHF', lang: 'de', ref: '00 00000 00000 00000 00202 60035',
        lines: [L('Hausmischung Espresso, Bohnen 1 kg', 30, 'pcs', 28, 2.6)], sent: [{ date: '2026-08-17', time: '10:05', to: 'buchhaltung@bistro.example', title: 'Rechnung 2026-003' }], log: [['2026-08-17', 'ausgestellt, Nr. 2026-003'], ['2026-08-17', 'gesendet: Rechnung 2026-003']] },
      { id: 'i4', kind: 'credit-note', number: '2026-004', status: 'issued', cu: 'c2', subject: 'zu Rechnung 2026-002', creditFor: 'i2', settlement: 'offset', date: '2026-09-02', cur: 'CHF', lang: 'de',
        lines: [L('2 Pakete Filterkaffee beschädigt geliefert', 1, '', -33.86, 2.6, { incl: true })], sent: [{ date: '2026-09-02', time: '16:40', to: 'kueche@musterhotel.example', title: 'Gutschrift 2026-004' }], log: [['2026-09-02', 'ausgestellt, Nr. 2026-004'], ['2026-09-02', 'gesendet: Gutschrift 2026-004']] },
      { id: 'i5', kind: 'invoice', number: '2026-005', status: 'issued', cu: 'c4', subject: 'Espresso-Mischung, Export', date: '2026-09-21', due: '2026-10-21', cur: 'EUR', lang: 'de', ref: 'RF49 2026 005', exemption: 'export',
        lines: [L('Espresso-Mischung, Bohnen 1 kg', 40, 'pcs', 19.5, 0), L('Transport bis Grenze', 1, 'flat', 85, 0)], sent: [{ date: '2026-09-21', time: '15:00', to: 'einkauf@kaffeehaus-beispiel.example', title: 'Rechnung 2026-005' }], log: [['2026-09-21', 'ausgestellt, Nr. 2026-005'], ['2026-09-21', 'gesendet: Rechnung 2026-005']] },
      { id: 'i6', kind: 'invoice', number: '2026-006', status: 'issued', cu: 'c3', subject: 'Mélange maison et formation', date: '2026-09-29', due: '2026-10-29', cur: 'CHF', lang: 'fr', ref: '00 00000 00000 00000 00202 60068', from: { kind: 'order', id: 'o1' },
        lines: [L('Mélange espresso maison, grains 1 kg', 15, 'pcs', 29, 2.6), L('Formation barista sur place', 4, 'h', 120, 8.1)], sent: [{ date: '2026-09-29', time: '17:20', to: 'compta@cafe-exemple.example', title: 'Facture 2026-006' }], log: [['2026-09-29', 'Folgedokument von Auftragsbestätigung AB-2026-001'], ['2026-09-29', 'ausgestellt, Nr. 2026-006'], ['2026-09-29', 'gesendet: Facture 2026-006']] },
      { id: 'i7', kind: 'invoice', number: '2026-007', status: 'issued', cu: 'c2', subject: 'Filterkaffee Oktober', date: '2026-10-01', due: '2026-10-21', cur: 'CHF', lang: 'de', ref: '00 00000 00000 00000 00202 60079', cancelled: { date: '2026-10-02', reason: 'doppelt erfasst' },
        lines: [L('Filterkaffee Guji, Bohnen 500 g', 24, 'pcs', 16.5, 2.6)], log: [['2026-10-01', 'ausgestellt, Nr. 2026-007'], ['2026-10-02', 'storniert: doppelt erfasst']] },
      { id: 'i8', kind: 'invoice', number: '2026-008', status: 'issued', cu: 'c2', subject: 'Kaffee-Abo November', date: '2026-11-01', due: '2026-11-21', cur: 'CHF', lang: 'de', ref: '00 00000 00000 00000 00202 60082', recurring: 'r1', skonto: { percent: 2, days: 10 },
        lines: [L('Hausmischung Espresso, Bohnen 1 kg', 25, 'pcs', 27, 2.6), L('Filterkaffee Guji, Bohnen 500 g', 20, 'pcs', 16.5, 2.6)],
        sent: [{ date: '2026-11-01', time: '07:00', to: 'kueche@musterhotel.example', title: 'Rechnung 2026-008', by: 'Vorlage' }], log: [['2026-11-01', 'aus der Vorlage «Kaffee-Abo Hotelküche» erstellt und ausgestellt'], ['2026-11-01', 'gesendet: Rechnung 2026-008']] },
      { id: 'd1', kind: 'invoice', status: 'draft', cu: 'c3', subject: 'Mélange maison octobre', date: '2026-10-10', cur: 'CHF', lang: 'fr', lines: [L('Mélange espresso maison, grains 1 kg', 20, 'pcs', 29, 2.6)], log: [['2026-10-10', 'erstellt']] },
      { id: 'd2', kind: 'invoice', status: 'draft', cu: 'c2', subject: 'Barista-Schulung Oktober', date: '2026-10-09', cur: 'CHF', lang: 'de',
        lines: [L('Barista-Schulung Latte Art, Gruppe bis 6 Personen', 1, 'day', 680, 8.1), L('Kursmaterial und Milch', 1, 'flat', 45, 8.1), L('Gutschrift 2026-004 vom 02.09.2026, verrechnet', 1, '', -33.86, 2.6, { incl: true, kind: 'ded', deducts: 'i4' })],
        log: [['2026-10-09', 'erstellt'], ['2026-10-09', 'Gutschrift 2026-004 als Abzug übernommen (zu verrechnen)']] },
      { id: 'q1', kind: 'quote', number: 'OF-2026-001', status: 'issued', qstatus: 'accepted', cu: 'c2', subject: 'Kaffee-Abo 2026/27', date: '2026-08-03', validUntil: '2026-09-02', cur: 'CHF', lang: 'de',
        lines: [L('Hausmischung Espresso, Bohnen 1 kg, pro Monat', 25, 'pcs', 27, 2.6), L('Filterkaffee Guji, Bohnen 500 g, pro Monat', 20, 'pcs', 16.5, 2.6)], invoicedAs: ['r1'],
        sent: [{ date: '2026-08-03', time: '11:10', to: 'kueche@musterhotel.example', title: 'Offerte OF-2026-001' }], log: [['2026-08-03', 'gesendet'], ['2026-08-10', 'angenommen'], ['2026-10-28', 'als wiederkehrende Rechnung angelegt']] },
      { id: 'q2', kind: 'quote', number: 'OF-2026-002', status: 'issued', qstatus: 'accepted', cu: 'c3', subject: 'Mélange maison et formation', date: '2026-09-15', validUntil: '2026-10-15', cur: 'CHF', lang: 'fr',
        lines: [L('Mélange espresso maison, grains 1 kg', 15, 'pcs', 29, 2.6), L('Formation barista sur place', 4, 'h', 120, 8.1), L('Moulin manuel «Muster», inox', 1, 'pcs', 89, 8.1, { optional: true })],
        sent: [{ date: '2026-09-15', time: '08:45', to: 'compta@cafe-exemple.example', title: 'Offre OF-2026-002' }], log: [['2026-09-15', 'gesendet'], ['2026-09-22', 'Folgedokument: Auftragsbestätigung AB-2026-001, ohne die Option']] },
      { id: 'o1', kind: 'order', number: 'AB-2026-001', status: 'issued', cu: 'c3', subject: 'Mélange maison et formation', date: '2026-09-22', cur: 'CHF', lang: 'fr', from: { kind: 'quote', id: 'q2' },
        lines: [L('Mélange espresso maison, grains 1 kg', 15, 'pcs', 29, 2.6), L('Formation barista sur place', 4, 'h', 120, 8.1)],
        sent: [{ date: '2026-09-22', time: '10:02', to: 'compta@cafe-exemple.example', title: 'Confirmation de commande AB-2026-001' }], log: [['2026-09-22', 'Folgedokument von Offerte OF-2026-002'], ['2026-09-22', 'gesendet: Confirmation de commande AB-2026-001']] },
      { id: 'n1', kind: 'delivery-note', number: 'LS-2026-001', status: 'issued', cu: 'c3', subject: 'Mélange maison', date: '2026-09-26', cur: 'CHF', lang: 'fr', from: { kind: 'order', id: 'o1' },
        lines: [L('Mélange espresso maison, grains 1 kg', 15, 'pcs', 29, 2.6)],
        sent: [{ date: '2026-09-26', time: '07:30', to: 'heruntergeladen', title: 'Bulletin de livraison LS-2026-001' }], log: [['2026-09-26', 'Folgedokument von Auftragsbestätigung AB-2026-001, eine Position'], ['2026-09-26', 'heruntergeladen: mit der Ware geliefert']] },
      { id: 'q3', kind: 'quote', number: 'OF-2026-003', status: 'issued', qstatus: 'expired', cu: 'c4', subject: 'Espresso-Mischung 2027', date: '2026-09-15', validUntil: '2026-10-15', cur: 'EUR', lang: 'de', exemption: 'export',
        lines: [L('Espresso-Mischung, Bohnen 1 kg', 120, 'pcs', 18.9, 0)], sent: [{ date: '2026-09-15', time: '09:30', to: 'einkauf@kaffeehaus-beispiel.example', title: 'Offerte OF-2026-003' }], log: [['2026-09-15', 'gesendet'], ['2026-10-16', 'abgelaufen']] },
      { id: 'q4', kind: 'quote', number: 'OF-2026-004', status: 'issued', qstatus: 'sent', cu: 'c1', subject: 'Filiale Thun: Eröffnung', date: '2026-11-06', validUntil: '2026-12-06', cur: 'CHF', lang: 'de',
        lines: [L('Kaffee', 0, '', 0, 0, { kind: 'title' }), L('Hausmischung Espresso, Bohnen 1 kg', 40, 'pcs', 28, 2.6), L('Filterkaffee Guji, Bohnen 500 g', 20, 'pcs', 16.5, 2.6), L('Zwischentotal Kaffee', 0, '', 0, 0, { kind: 'sub' }),
          L('Schulung', 0, '', 0, 0, { kind: 'title' }), L('Barista-Schulung Eröffnungsteam', 1, 'day', 680, 8.1), L('Kursmaterial und Milch', 1, 'flat', 45, 8.1), L('Zwischentotal Schulung', 0, '', 0, 0, { kind: 'sub' }),
          L('Handmühle «Muster», Edelstahl, für die Bar', 2, 'pcs', 89, 8.1, { optional: true }), L('Wartung Siebträgermaschine, erstes Jahr', 1, 'flat', 180, 8.1, { optional: true })],
        sent: [{ date: '2026-11-06', time: '13:15', to: 'buchhaltung@bistro.example', title: 'Offerte OF-2026-004' }], log: [['2026-11-06', 'erstellt'], ['2026-11-06', 'gesendet: Offerte OF-2026-004']] },
    ],
    articles: [
      { id: 'a1', no: 'HM-1000', text: 'Hausmischung Espresso, Bohnen 1 kg', unit: 'pcs', price: 28, rate: 2.6,
        prices: [{ from: '2025-01-01', price: 26, src: 'Preisliste 2025' }, { from: '2026-07-01', price: 28, src: 'Preisliste Juli 2026' }] },
      { id: 'a2', no: 'EM-1000', text: 'Espresso-Mischung, Bohnen 1 kg', unit: 'pcs', price: 27, rate: 2.6 },
      { id: 'a3', no: 'FG-500', text: 'Filterkaffee Guji, Bohnen 500 g', unit: 'pcs', price: 16.5, rate: 2.6 },
      { id: 'a4', no: 'BS-TAG', text: 'Barista-Schulung, Gruppe bis 6 Personen', unit: 'day', price: 680, rate: 8.1 },
      { id: 'a5', no: 'BS-STD', text: 'Barista-Schulung im Betrieb', unit: 'h', price: 120, rate: 8.1 },
      { id: 'a6', no: 'SV-WART', text: 'Wartung Siebträgermaschine, inkl. Dichtungen', unit: 'flat', price: 180, rate: 8.1 },
      { id: 'a7', no: 'HW-MUE', text: 'Handmühle «Muster», Edelstahl', unit: 'pcs', price: 89, rate: 8.1 },
    ],
    recurring: [
      { id: 'r1', cu: 'c2', name: 'Kaffee-Abo Hotelküche', every: 'month', next: '2026-12-01', since: '2026-11-01', mode: 'send', from: 'q1', made: ['i8'], lines: [L('Hausmischung Espresso, Bohnen 1 kg', 25, 'pcs', 27, 2.6), L('Filterkaffee Guji, Bohnen 500 g', 20, 'pcs', 16.5, 2.6)], skonto: true },
      { id: 'r2', cu: 'c3', name: 'Wartung Siebträgermaschine', every: 'quarter', next: '2027-01-01', since: '2027-01-01', mode: 'draft', made: [], lines: [L('Entretien machine à porte-filtre, joints compris', 1, 'flat', 180, 8.1)] },
    ],
    receipts: [
      { id: 'b1', date: '2026-11-04', text: 'SBB Zürich–Thun retour, Besprechung Filiale Thun', net: 64.2, cu: 'c1' },
      { id: 'b2', date: '2026-11-05', text: 'Hotel Thun, 1 Nacht, Aufbau Espresso-Bar', net: 148.0, cu: 'c1' },
      { id: 'b3', date: '2026-10-22', text: 'Milch und Kursmaterial, Coop Luzern', net: 38.4, cu: 'c2' },
    ],
  };
  const salon = {
    customers: [
      { id: 's1', no: 'K-1', name: 'Hotel Beispielhof AG', street: 'Bahnhofstrasse 3', town: '3011 Bern', country: 'CH', lang: 'de', email: 'events@beispielhof.example', terms: 30 },
      { id: 's2', no: 'K-2', name: 'Laura Beispiel', street: 'Rosenweg 2', town: '3007 Bern', country: 'CH', lang: 'de', email: 'laura@beispiel.example', terms: 30 },
      { id: 's3', no: 'K-3', name: 'Nina Muster', street: 'Lindenweg 8', town: '3012 Bern', country: 'CH', lang: 'de', email: 'nina@muster.example', terms: 30 },
    ],
    docs: [
      { id: 'si1', kind: 'invoice', number: '2026-001', status: 'issued', cu: 's1', subject: 'Styling Firmenanlass', date: '2026-09-18', due: '2026-10-18', cur: 'CHF', lang: 'de', ref: 'RF71 2026 001',
        lines: [L('Styling Gäste Firmenanlass', 12, 'pcs', 45, 0), L('Anfahrt und Material', 1, 'flat', 40, 0)], payments: [{ date: '2026-10-10', amount: 580, by: 'SCOR-Referenz' }],
        sent: [{ date: '2026-09-18', time: '18:02', to: 'events@beispielhof.example', title: 'Rechnung 2026-001' }], log: [['2026-09-18', 'ausgestellt, Nr. 2026-001'], ['2026-10-10', 'bezahlt, zugeordnet über die Referenz']] },
      { id: 'si2', kind: 'invoice', number: '2026-002', status: 'issued', cu: 's2', subject: 'Brautfrisur', date: '2026-10-17', cur: 'CHF', lang: 'de', paidAtIssue: 'twint',
        lines: [L('Brautfrisur', 1, 'flat', 260, 0), L('Probefrisur', 1, 'flat', 80, 0)], payments: [{ date: '2026-10-17', amount: 340, by: 'bei Ausstellung, TWINT' }],
        sent: [{ date: '2026-10-17', time: '12:40', to: 'laura@beispiel.example', title: 'Quittung 2026-002' }], log: [['2026-10-17', 'als Quittung ausgestellt, Nr. 2026-002, bezahlt mit TWINT']] },
      { id: 'sd1', kind: 'invoice', status: 'draft', cu: 's3', subject: 'Hochzeit: Brautfrisur und Make-up', date: TODAY, cur: 'CHF', lang: 'de',
        lines: [L('Brautfrisur', 1, 'flat', 280, 0), L('Make-up Braut', 1, 'flat', 120, 0), L('Probefrisur', 1, 'flat', 80, 0)], log: [[TODAY, 'erstellt']] },
    ],
    articles: [
      { id: 'sa1', no: 'BF', text: 'Brautfrisur', unit: 'flat', price: 280, rate: 0 },
      { id: 'sa2', no: 'MU', text: 'Make-up Braut', unit: 'flat', price: 120, rate: 0 },
      { id: 'sa3', no: 'PF', text: 'Probefrisur', unit: 'flat', price: 80, rate: 0 },
      { id: 'sa4', no: 'GS', text: 'Styling Gäste', unit: 'pcs', price: 45, rate: 0 },
    ],
    recurring: [],
    receipts: [],
  };
  return { kaffee, salon };
}

const S = {
  firm: 'kaffee', basis: 'received', imported: false, mark: true,
  settings: { interest: false, rate: 5, skonto: true, skontoPct: 2, skontoDays: 10, limit: 5, fees: [0, 20, 30], afterDays: [10, 20, 30], eurQr: '' },
  data: baseline(),
  ui: { open: {}, preview: false, reminder: null, dialog: null, oiCu: null },
};
const D = () => S.data[S.firm];
const F = () => FIRMS[S.firm];
const cust = (id) => D().customers.find((c) => c.id === id);
const doc = (id) => D().docs.find((d) => d.id === id);
const byRoute = (rid) => D().docs.find((d) => (d.status === 'draft' ? `draft-${d.id}` : d.number) === rid);
const rid = (d) => (d.status === 'draft' ? `draft-${d.id}` : d.number);
const isItem = (l) => !l.kind || l.kind === 'ded';
// One editor for every kind (spec 4.4): the kinds before the invoice have their own series and live in «Offerten · Aufträge».
const PRE = new Set(['quote', 'order', 'delivery-note']);
const pre = (d) => PRE.has(d.kind);
const KIND = { quote: 'Offerte', order: 'Auftragsbestätigung', 'delivery-note': 'Lieferschein', invoice: 'Rechnung', 'credit-note': 'Gutschrift' };
const kindOf = (d) => (d.paidAtIssue ? 'Quittung' : KIND[d.kind]);
const docTitle = (d) => { const Lx = T[d.lang] ?? T.de; return `${d.paidAtIssue ? Lx.receipt : Lx[{ quote: 'quote', order: 'order', 'delivery-note': 'delivery', 'credit-note': 'credit' }[d.kind] ?? 'invoice']} ${d.number ?? ''}`.trim(); };
const hrefOf = (d) => `#/invoices/${pre(d) ? 'quotes/' : ''}${rid(d)}`;
const SERIES = { quote: 'OF-2026-', order: 'AB-2026-', 'delivery-note': 'LS-2026-', invoice: '2026-', 'credit-note': '2026-' };

// ---------------------------------------------------------------- figures (src/invoices/rules.ts totals)
const lineAmount = (l) => r2(l.q * l.p);
function totals(lines) {
  const by = {};
  for (const l of lines.filter((x) => isItem(x) && !x.optional)) {
    const a = lineAmount(l), k = String(l.rate);
    by[k] ??= { rate: l.rate, netEx: 0, grossIn: 0 };
    if (l.incl && l.rate > 0) by[k].grossIn += a; else by[k].netEx += a;
  }
  const byRate = Object.values(by).map((b) => {
    const netIn = r2(b.grossIn / (1 + b.rate / 100));
    const net = r2(b.netEx + netIn);
    const vat = r2(r2(b.netEx * b.rate / 100) + (b.grossIn - netIn));
    return { rate: b.rate, net, vat, gross: r2(net + vat) };
  }).sort((a, b) => b.rate - a.rate);
  const net = r2(byRate.reduce((s, b) => s + b.net, 0));
  const vat = r2(byRate.reduce((s, b) => s + b.vat, 0));
  return { byRate, net, vat, gross: r2(net + vat) };
}
const gross = (d) => totals(d.lines).gross;
const paid = (d) => r2((d.payments ?? []).reduce((s, p) => s + p.amount, 0));
const writtenOff = (d) => r2((d.writeOffs ?? []).reduce((s, w) => s + w.amount, 0));
const openOf = (d) => (d.kind === 'invoice' && d.status === 'issued' && !d.cancelled ? r2(gross(d) - paid(d) - writtenOff(d)) : 0);
function stateOf(d) {
  if (d.kind === 'quote') return d.status === 'draft' ? 'draft' : d.qstatus;
  if (d.status === 'draft') return 'draft';
  if (pre(d)) return 'done';
  if (d.cancelled) return 'cancelled';
  if (d.kind === 'credit-note') return 'credit';
  if (openOf(d) <= 0) return 'paid';
  return d.due && d.due < TODAY ? 'overdue' : 'open';
}
const nextNumber = (kind) => {
  const p = SERIES[kind];
  const n = D().docs.filter((d) => d.number && SERIES[d.kind] === p).map((d) => Number(d.number.slice(p.length)));
  return `${p}${String(Math.max(0, ...n) + 1).padStart(3, '0')}`;
};
// Four figures of an invoice (spec 4.8): what was asked, received (bank, by code), credited (credit notes and write-offs), open.
function figures(d) {
  const credits = D().docs.filter((x) => x.kind === 'credit-note' && x.status === 'issued' && x.creditFor === d.id);
  const credited = r2(-credits.reduce((s, x) => s + gross(x), 0) + writtenOff(d));
  const elsewhere = r2(-credits.filter((x) => x.offsetIn).reduce((s, x) => s + gross(x), 0));
  const amount = gross(d), got = paid(d);
  const open = d.cancelled ? 0 : r2(amount - got - credited + elsewhere);
  return { amount, got, credited, open, credits, elsewhere };
}
const rateCode = (rate, d) => (!F().vat ? '' : rate === 2.6 ? 'V26' : rate === 8.1 ? 'V81' : rate === 3.8 ? 'V38' : d.exemption === 'abroad' ? 'V0-E' : 'V0');
const EUR_RATE = { '2026-11-12': 0.9361, '2026-09-21': 0.9447 };

// ---------------------------------------------------------------- the A4 sheet (src/invoices/sheet.ts, by hand)
const editable = (key, html, ph = '', cls = '') => `<span class="ed${cls ? ` ${cls}` : ''}" contenteditable="plaintext-only" spellcheck="false" data-ed="${esc(key)}"${ph ? ` data-ph="${esc(ph)}"` : ''}>${html}</span>`;
const pick = (key, options, value, cls = '') => `<select class="ed edsel${cls}" data-ed="${esc(key)}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const COLS = '<colgroup><col class="cd"><col class="cq"><col class="cp"><col class="cv"><col class="ca"></colgroup>';
const COLS_NOVAT = '<colgroup><col class="cd"><col class="cq"><col class="cp"><col class="ca"></colgroup>';
const COLS_DN = '<colgroup><col class="cd"><col class="cq"></colgroup>';

function qrBill(Lx, o) {
  const q = Lx.qr;
  const t = (x, y, s, w, txt, extra = '') => `<tspan x="${x}" ${y}${extra} font-family="Liberation Sans" font-weight="${w}" font-size="${s}pt">${esc(txt)}</tspan>`;
  const block = (lines, size) => lines.map((l) => t(0, 'dy="9pt"', size, 'normal', l)).join('');
  const rcpt = `<svg x="5mm" y="5mm"><text>${t(0, 'y="0" dy="11pt"', 11, 'bold', q.receipt)}${t(0, 'y="7mm" dy="9pt"', 6, 'bold', q.account)}${block([o.iban, ...o.creditor], 8)}${o.ref ? t(0, 'dy="18pt"', 6, 'bold', q.ref) + block([o.ref], 8) : ''}${t(0, 'dy="18pt"', 6, 'bold', q.by)}${block(o.debtor, 8)}</text><text y="63mm">${t(0, 'dy="6pt"', 6, 'bold', q.cur)}${t('22mm', '', 6, 'bold', q.amt)}${t(0, 'dy="11pt"', 8, 'normal', o.currency)}${t('22mm', '', 8, 'normal', fmt(o.amount).replace(/'/g, ' '))}${t('52mm', 'y="82mm"', 6, 'bold', q.accept, ' text-anchor="end"')}</text></svg>`;
  const pay = `<svg x="67mm" y="5mm"><text x="0" y="0" dy="11pt" font-family="Liberation Sans" font-weight="bold" font-size="11pt">${esc(q.part)}</text><text y="63mm">${t(0, 'dy="8pt"', 8, 'bold', q.cur)}${t('22mm', '', 8, 'bold', q.amt)}${t(0, 'dy="13pt"', 10, 'normal', o.currency)}${t('22mm', '', 10, 'normal', fmt(o.amount).replace(/'/g, ' '))}</text></svg>`;
  const right = `<svg x="118mm" y="5mm"><text>${t(0, 'y="0" dy="9pt"', 8, 'bold', q.account)}${block([o.iban, ...o.creditor], 10)}${o.ref ? t(0, 'dy="20pt"', 8, 'bold', q.ref) + block([o.ref], 10) : ''}${t(0, 'dy="20pt"', 8, 'bold', q.info)}${block([o.info], 10)}${t(0, 'dy="20pt"', 8, 'bold', q.by)}${block(o.debtor, 10)}</text></svg>`;
  const code = `<svg x="67mm" y="17mm" width="46mm" height="46mm" viewBox="0 0 46 46"><path d="${window.QR_PATH}" fill="#000"></path><rect x="19.6" y="19.6" width="6.8" height="6.8" fill="#fff"></rect><rect x="20" y="20" width="6" height="6" fill="#000"></rect><path d="M22.4 20.9h1.2v1.5h1.5v1.2h-1.5v1.5h-1.2v-1.5h-1.5v-1.2h1.5z" fill="#fff"></path></svg>`;
  return `<div class="qrb"><div class="cut">${esc(Lx.cut)}</div><span class="hsc">✂</span><svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="105mm"><rect x="0" y="0" width="100%" height="100%" fill="#fff"></rect><line x1="62mm" y1="0mm" x2="62mm" y2="105mm" stroke-width="1" stroke="black" stroke-dasharray="3"></line>${rcpt}${pay}${right}${code}</svg></div>`;
}

/** The sheet of a document. mode: 'edit' (a draft on screen), 'view', 'preview'; opts.reminder: { level, fee, interest }. */
function sheet(d, mode = 'view', opts = {}) {
  const f = F(), c = cust(d.cu), Lx = T[d.lang] ?? T.de, edit = mode === 'edit';
  const withVat = f.vat;
  const t = totals(d.lines);
  const dn = d.kind === 'delivery-note';
  const vatCol = withVat && !dn;
  const receipt = !!d.paidAtIssue && d.kind === 'invoice';
  const base = d.kind === 'credit-note' ? Lx.credit : d.kind === 'quote' ? Lx.quote : d.kind === 'order' ? Lx.order : dn ? Lx.delivery : receipt ? Lx.receipt : Lx.invoice;
  const title = opts.reminder ? `${Lx.reminder(opts.reminder.level)} · ${Lx.invoice}` : base;
  const no = d.number ? esc(d.number) : `<span class="draftno">${Lx.draft}</span>`;
  const rdate = opts.reminder ? TODAY : d.date;
  const meta = [`<span>${Lx.date} ${edit ? editable('date', dmy(d.date)) : dmy(rdate)}</span>`];
  if (d.kind === 'quote') meta.push(`<span class="${d.status === 'draft' ? 'nw' : ''}">${Lx.valid} ${dmy(d.validUntil)}</span>`);
  else if (d.kind === 'credit-note') meta.push(`<span>${Lx.forInvoice} ${esc(doc(d.creditFor)?.number ?? '')}</span>`);
  else if (d.kind === 'order' || dn) { const src = d.from && doc(d.from.id); if (src?.number) meta.push(`<span class="nw">${esc(Lx.fromDoc((T[d.lang] ?? T.de)[{ quote: 'quote', order: 'order', invoice: 'invoice' }[src.kind] ?? 'invoice'], src.number))}</span>`); }
  else if (opts.reminder) meta.push(`<span>${Lx.due} ${dmy(addDays(TODAY, 10))}</span>`);
  else if (!receipt) meta.push(`<span>${Lx.due} ${dmy(d.due ?? addDays(d.date, c.terms))}</span>`);
  if (c.country !== 'CH' && c.vatId) meta.push(`<span>${Lx.yourVat} ${esc(c.vatId)}</span>`);
  const intro = opts.reminder ? Lx.reminderIntro(d.number, dmy(d.date), dmy(d.due)) : d.kind === 'quote' ? Lx.quoteIntro : d.kind === 'order' ? Lx.orderIntro : dn ? Lx.deliveryIntro : receipt ? Lx.receiptIntro : Lx.intro;
  const head = dn ? `<table class="tb">${COLS_DN}<thead><tr><th class="">${Lx.desc}</th><th class="r">${Lx.qty}</th></tr></thead></table>`
    : `<table class="tb">${vatCol ? COLS : COLS_NOVAT}<thead><tr><th class="">${Lx.desc}</th><th class="r">${Lx.qty}</th><th class="r">${Lx.price}</th>${vatCol ? `<th class="r">${Lx.vat}</th>` : ''}<th class="r">${Lx.amount} ${d.cur}</th></tr></thead></table>`;
  const rows = [];
  let run = 0, optSum = 0;
  const canOpt = edit && (d.kind === 'quote' || d.kind === 'order');
  d.lines.forEach((l, k) => {
    const cols = dn ? COLS_DN : vatCol ? COLS : COLS_NOVAT;
    if (dn) {
      if (l.kind === 'sub') return;
      const rmx = edit ? `<button type="button" class="edx scr" data-act="rmline" data-k="${k}" title="Zeile entfernen" aria-label="Zeile entfernen">×</button>` : '';
      if (l.kind === 'title') { rows.push(`<table class="tb">${cols}<tbody><tr class="ttl"><td colspan="2">${edit ? editable(`l:${k}:text`, esc(l.text), 'Titel', 'blocked') : esc(l.text)}${rmx}</td></tr></tbody></table>`); return; }
      const unit = l.unit ? ` ${Lx.units[l.unit] ?? l.unit}` : '';
      rows.push(`<table class="tb">${cols}<tbody><tr><td>${edit ? editable(`l:${k}:text`, esc(l.text), Lx.desc, 'blocked') : esc(l.text)}</td><td class="r">${edit ? editable(`l:${k}:q`, esc(qty(l.q))) : ''}${edit ? unit : esc(`${qty(l.q)}${unit}`)}${rmx}</td></tr></tbody></table>`);
      return;
    }
    if (l.kind === 'title') {
      rows.push(`<table class="tb nw">${cols}<tbody><tr class="ttl"><td colspan="${vatCol ? 5 : 4}">${edit ? editable(`l:${k}:text`, esc(l.text), 'Titel', 'blocked') : esc(l.text)}${edit ? `<button type="button" class="edx scr" data-act="rmline" data-k="${k}" title="Zeile entfernen" aria-label="Zeile entfernen">×</button>` : ''}</td></tr></tbody></table>`);
      run = 0; return;
    }
    if (l.kind === 'sub') {
      rows.push(`<table class="tb nw">${cols}<tbody><tr class="sub"><td colspan="${vatCol ? 4 : 3}">${edit ? editable(`l:${k}:text`, esc(l.text), Lx.sub, 'blocked') : esc(l.text)}</td><td class="r">${fmt(run)}${edit ? `<button type="button" class="edx scr" data-act="rmline" data-k="${k}" title="Zeile entfernen" aria-label="Zeile entfernen">×</button>` : ''}</td></tr></tbody></table>`);
      run = 0; return;
    }
    const a = lineAmount(l);
    if (l.optional) optSum = r2(optSum + a); else run = r2(run + a);
    const unit = l.unit ? ` ${Lx.units[l.unit] ?? l.unit}` : '';
    const rateTxt = `${l.rate} %${l.incl && l.rate > 0 ? ` ${Lx.incl}` : ''}`;
    const unitOpts = [['', '–'], ...Object.keys(UNITS).map((u) => [u, Lx.units[u]])];
    const rateOpts = withVat ? [['0', '0 %'], ['2.6', '2.6 %'], ['incl:2.6', '2.6 % inkl.'], ['3.8', '3.8 %'], ['8.1', '8.1 %'], ['incl:8.1', '8.1 % inkl.']] : [['0', '0 %']];
    const cells = edit && l.kind !== 'ded'
      ? { text: editable(`l:${k}:text`, esc(l.text), Lx.desc, 'blocked'), q: `${editable(`l:${k}:q`, esc(qty(l.q)))} ${pick(`l:${k}:unit`, unitOpts, l.unit ?? '')}`, p: editable(`l:${k}:p`, fmt(l.p)), v: pick(`l:${k}:rate`, rateOpts, `${l.incl && l.rate ? 'incl:' : ''}${l.rate}`) }
      : { text: esc(l.text), q: esc(`${qty(l.q)}${unit}`), p: fmt(l.p), v: rateTxt };
    const rm = edit ? `<button type="button" class="edx scr" data-act="rmline" data-k="${k}" title="Zeile entfernen" aria-label="Zeile entfernen">×</button>` : '';
    const opt = canOpt && l.kind !== 'ded' ? `<button type="button" class="edo scr nw" data-act="optline" data-k="${k}" aria-pressed="${!!l.optional}" title="${l.optional ? 'Wieder ins Total nehmen' : 'Als Option: gezeigt, nicht im Total'}">${l.optional ? 'Option' : 'opt.'}</button>` : '';
    const optTag = l.optional ? `<span class="optl">${esc(Lx.option)}</span> ` : '';
    const amt = l.optional ? `(${fmt(a)})` : fmt(a);
    rows.push(`<table class="tb${l.kind === 'ded' || l.source || l.optional ? ' nw' : ''}">${cols}<tbody><tr class="${[l.kind === 'ded' ? 'ded' : '', l.optional ? 'opt' : ''].filter(Boolean).join(' ')}"><td>${optTag}${cells.text}</td><td class="r">${cells.q}</td><td class="r">${cells.p}</td>${vatCol ? `<td class="r">${cells.v}</td>` : ''}<td class="r">${amt}${opt}${rm}</td></tr></tbody></table>`);
  });
  const add = edit ? `<div class="edadd scr"><button type="button" data-act="addline">＋ Neue Position</button><button type="button" class="nw" data-act="addtitle">＋ Titel</button><button type="button" class="nw" data-act="addsub">＋ Zwischentotal</button>${D().articles.length ? '<button type="button" class="nw" data-act="dlg-articles">＋ Aus Artikelliste</button>' : ''}${S.firm === 'kaffee' ? '<button type="button" class="nw" data-act="dlg-hours">＋ Stunden übernehmen</button><button type="button" class="nw" data-act="dlg-expenses">＋ Spesen weiterverrechnen</button>' : ''}</div>` : '';
  const rates = withVat ? t.byRate.filter((b) => b.rate > 0).map((b) => `<div><span>${esc(Lx.vatOn(String(b.rate), fmt(b.net)))}</span><span>${fmt(b.vat)}</span></div>`).join('') : '';
  let due = '';
  if (opts.reminder) {
    const open = openOf(d), fee = opts.reminder.fee || 0, int = opts.reminder.interest;
    due = `${paid(d) ? `<div><span>${Lx.paidSoFar}</span><span>${fmt(-paid(d))}</span></div>` : ''}${fee ? `<div><span>${Lx.fee}</span><span>${fmt(fee)}</span></div>` : ''}${int ? `<div class="nw interest"><span>${esc(Lx.interest(S.settings.rate, dmy(d.due), int.days))}</span><span>${fmt(int.amount)}</span></div>` : ''}<div class="tot"><span>${Lx.openNow} ${d.cur}</span><span>${fmt(open + fee + (int?.amount ?? 0))}</span></div>`;
  }
  const optLine = optSum ? `<div class="optsum nw"><span>${esc(Lx.optNote)}</span><span>(${fmt(optSum)})</span></div>` : '';
  const sum = dn ? '' : `<div class="sum">${withVat ? `<div><span>${Lx.net}</span><span>${fmt(t.net)}</span></div>` : ''}${rates}<div class="tot"><span>${Lx.total} ${d.cur}</span><span>${fmt(t.gross)}</span></div>${optLine}${due}</div>`;
  let settle = '';
  if (d.kind === 'credit-note' && d.settlement === 'offset') {
    const inv = doc(d.creditFor);
    settle = `<div class="settle"><div><span>${esc(Lx.ofInvoice(inv.number, dmy(inv.date)))}</span><span>${fmt(gross(inv))}</span></div><div><span>${Lx.credit}</span><span>${fmt(t.gross)}</span></div></div><p class="settled">${esc(Lx.offset(`${d.cur} ${fmt(-t.gross)}`))}</p>`;
  }
  const exempt = d.exemption ? (edit ? `<p class="abroad">${pick('exemption', [['abroad', Lx.exemption.abroad], ['export', Lx.exemption.export]], d.exemption)}</p>` : `<p class="abroad">${esc(Lx.exemption[d.exemption])}</p>`) : '';
  // A QR-IBAN kept for EUR after the warning (spec 4.11): v2.3 allows it until November 2027; issued documents keep what they printed.
  const eur = d.cur === 'EUR' && !(eurQrKept() && (!d.number || d.qrIbanEur));
  const iban = d.cur === 'EUR' && !eur ? f.qrIban : eur ? f.ibanEUR : (f.qrIban ?? f.ibanCHF);
  const showRef = d.ref ?? (mode === 'preview' ? previewRef(d) : '');
  const payinfo = eur && d.kind === 'invoice' && !receipt && (d.number || mode === 'preview') ? `<p class="payinfo${mode === 'preview' ? ' nw' : ''}">${Lx.payment}: ${Lx.iban} ${esc(f.ibanEUR)}${showRef ? `, ${Lx.reference} ${esc(showRef)}` : ''}</p>` : '';
  const paidNote = receipt ? `<p class="paidnote nw">${esc(Lx.paidNote(dmy(d.date), Lx.means[d.paidAtIssue]))}</p>` : '';
  const closingText = dn ? `${Lx.deliveryClosing}\n\n______________________________\n${Lx.thanks(f.owner)}` : d.kind === 'order' ? Lx.thanks(f.owner) : d.kind === 'quote' ? Lx.quoteClosing(f.owner) : d.kind === 'credit-note' || receipt ? Lx.thanks(f.owner) : opts.reminder ? Lx.reminderClosing(f.owner) : Lx.closing(c.terms, f.owner, d.skonto ?? (d.status === 'draft' && S.firm === 'kaffee' && S.settings.skonto && !eur ? { percent: S.settings.skontoPct, days: S.settings.skontoDays } : null));
  const closing = `<p class="closing${(d.skonto || (d.status === 'draft' && S.firm === 'kaffee' && S.settings.skonto && !eur)) && d.kind === 'invoice' && !receipt && !opts.reminder ? ' nw' : ''}">${esc(closingText)}</p>`;
  // QR-bill: CHF only on a Swiss IBAN; a draft keeps its place, the preview and an issued invoice print it.
  const qrPossible = d.kind === 'invoice' && !receipt && !d.cancelled && !eur;
  let qr = '';
  if (qrPossible && (d.number || mode === 'preview')) {
    const amount = opts.reminder ? openOf(d) + (opts.reminder.fee || 0) + (opts.reminder.interest?.amount ?? 0) : d.status === 'issued' ? Math.max(openOf(d), 0) || gross(d) : gross(d);
    qr = qrBill(Lx, { iban, creditor: [f.name, f.street, f.town], ref: showRef, info: `${Lx.invoice} ${d.number ?? nextNumber('invoice')}`, debtor: [c.name, c.street, c.town], currency: d.cur, amount });
  } else if (qrPossible && edit) qr = '<div class="qrb ph"><span>QR-Zahlteil: erscheint beim Ausstellen, die Referenz kommt aus der Nummer</span></div>';
  const footFull = `<div class="foot"><span>${esc(f.name)}<br>${esc(f.street)}, ${esc(f.town)}</span><span>${Lx.bank}: ${esc(eur ? f.bankEUR : f.bankCHF)}<br>${Lx.iban} ${esc(eur ? f.ibanEUR : f.ibanCHF)}</span><span>${withVat ? Lx.vatNo : Lx.uidNo}<br>${esc(f.uid)}${withVat ? ` ${Lx.vatSuffix}` : ''}</span></div>`;
  const foot = !qr ? footFull : '';
  const logo = f.logo ? `<div class="logo pos-left sz-m"><img src="${window.LOGO}" alt="${esc(f.name)}"></div>` : `<div class="logo pos-left sz-m"><span class="wordmark">${esc(f.name)}</span></div>`;
  const from = `<div class="from"><b>${esc(f.name)}</b><span>${esc(f.street)}, ${esc(f.town)}</span><span>${esc(f.uid)}${withVat ? ` ${Lx.vatSuffix}` : ''}</span></div>`;
  const custSel = edit ? pick('customer', [...D().customers.map((x) => [x.id, x.name])], d.cu) : esc(c.name);
  const to = `<div class="to"><span class="sl">${esc(f.name)} · ${esc(f.street)}, ${esc(f.town)}</span><span>${custSel}</span>${c.attn ? `<span>${esc(c.attn)}</span>` : ''}<span>${esc(c.street)}</span><span>${esc(c.town)}</span>${c.countryName ? `<span>${esc(c.countryName)}</span>` : ''}</div>`;
  const stamp = d.cancelled ? '<div class="cxstamp">STORNIERT</div>' : '';
  const titleCls = receipt && d.status === 'draft' ? ' class="nw"' : d.kind === 'quote' ? ' class="nw"' : '';
  const body = `<h3${titleCls}>${esc(title)} ${no}</h3><div class="meta">${meta.join('')}</div><p class="intro">${edit ? editable('intro', esc(intro), '', 'blocked') : esc(intro)}</p>${head}${rows.join('')}${add}${sum}${settle}${exempt}${payinfo}${paidNote}${closing}`;
  const style = `--ivf: 'Inter', 'Liberation Sans', Arial, sans-serif; --iva: ${f.accent}; --lh: 15mm;`;
  // Height in mm, roughly as src/invoices/sheet.ts paginate measures it: the QR-bill takes a sheet of its own when the text reaches it.
  const mm = 88 + 38 + d.lines.length * 7 + (edit ? 10 : 0) + (2 + t.byRate.filter((b) => b.rate > 0).length) * 5.5 + (opts.reminder ? 26 : 0) + (exempt ? 8 : 0) + (paidNote ? 8 : 0) + 16;
  const own = qr && mm > 297 - 105 - 5;
  const phead = `<div class="phead"><span>${esc(f.name)} · ${esc(title)} ${no}</span><span>Seite 2 von 2</span></div>`;
  const page1 = `<div class="a4 win-right logo-left${qr && !own ? ' has-qr' : ''}" style="${style}" lang="${d.lang}">${logo}${from}${to}${stamp}<div class="ivmain" style="top:88mm">${body}</div>${own ? footFull : foot}${own ? '' : qr}</div>`;
  const page2 = own ? `<div class="a4 has-qr" style="${style}" lang="${d.lang}">${phead}${qr}</div>` : '';
  return `<div class="ivsheet${edit ? ' editing' : ''}">${page1}${page2}</div>`;
}
const eurQrKept = () => S.firm === 'kaffee' && S.settings.eurQr === 'kept';
const previewRef = (d) => (d.cur === 'EUR' && !eurQrKept() ? `RF${String(10 + Number(nextNumber('invoice').slice(-3)) % 89)} 2026 ${nextNumber('invoice').slice(-3)}` : `00 00000 00000 00000 00202 6${nextNumber('invoice').slice(-3)}${(Number(nextNumber('invoice').slice(-3)) * 7) % 10}`);

// ---------------------------------------------------------------- bookings per basis (spec 4.5)
function bookings(d) {
  const f = F(), rows = [], agreed = S.basis === 'agreed' && f.vat;
  const t = totals(d.lines), g = t.gross;
  const split = (amount) => t.byRate.filter((b) => b.gross !== 0).map((b) => ({ rate: b.rate, amount: r2(amount * b.gross / g) }));
  const rev = (rate) => f.revenue[rate] ?? f.revenue[0];
  const chf = (amount, date) => (d.cur === 'EUR' ? r2(amount * (EUR_RATE[date] ?? 0.94)) : amount);
  const cur = d.cur === 'EUR' ? 'CHF ' : '';
  if (pre(d)) return [{ none: `Keine Buchung: ${d.kind === 'quote' ? 'eine Offerte' : d.kind === 'order' ? 'eine Auftragsbestätigung' : 'ein Lieferschein'} bucht nichts.` }];
  if (d.status === 'draft') return [{ none: agreed ? 'Beim Ausstellen: Debitoren / Ertrag mit den Verkaufscodes, am Rechnungsdatum.' : d.paidAtIssue ? `Beim Ausstellen: ${MEANS_ACC[d.paidAtIssue].join(' ')} / ${rev(0).join(' ')}, am selben Tag.` : 'Noch keine Buchung: vereinnahmt bucht erst die Zahlung.' }];
  if (d.kind === 'credit-note') {
    const inv = d.offsetIn ? doc(d.offsetIn) : null;
    return agreed
      ? [{ date: d.date, ref: `GS-${d.number}`, acc: `${rev(2.6)[0]} / 1100 Debitoren`, amount: `${fmt(-g)}`, code: '−V26' }]
      : [{ none: inv ? `Keine Buchung der Gutschrift selbst: als Abzugszeile auf ${inv.number} verrechnet; deren Zahlung ist um ${fmt(-g)} kleiner.` : 'Keine Buchung: sie wird mit der nächsten Rechnung verrechnet, deren Zahlung um diesen Betrag kleiner ist.' }];
  }
  if (d.cancelled && d.unlinked) return [{ none: `Storniert am ${dmy(d.cancelled.date)}. Die Zahlung vom ${dmy(d.unlinked.at(-1).date)} ist gelöst und wartet ohne Rechnung bei den Zahlungen; ihre Buchung wird im offenen Quartal zurückgenommen.` }];
  if (d.cancelled) return [{ none: agreed ? `RE-${d.number} und RE-${d.number}-storno heben sich auf.` : 'Keine Buchung: storniert, bevor etwas bezahlt war.' }];
  if (agreed) for (const s of split(g)) rows.push({ date: d.date, ref: `RE-${d.number}`, acc: `1100 Debitoren / ${rev(s.rate).join(' ')}`, amount: `${cur}${fmt(chf(s.amount, d.date))}`, code: rateCode(s.rate, d) });
  for (const p of d.payments ?? []) {
    const bank = d.paidAtIssue ? MEANS_ACC[d.paidAtIssue] : f.bankAcc[d.cur];
    if (agreed) {
      rows.push({ date: p.date, ref: '', acc: `${bank.join(' ')} / 1100 Debitoren`, amount: `${cur}${fmt(chf(p.amount, p.date))}`, code: '' });
      if (d.cur === 'EUR') rows.push({ date: p.date, ref: '', acc: '6960 Kursdifferenzen / 1100', amount: `CHF ${fmt(r2(chf(p.amount, d.date) - chf(p.amount, p.date)))}`, code: '', note: 'Kurs Rechnungstag gegen Zahltag' });
    } else for (const s of split(p.amount)) rows.push({ date: p.date, ref: '', acc: `${bank.join(' ')} / ${rev(s.rate).join(' ')}`, amount: `${cur}${fmt(chf(s.amount, p.date))}`, code: rateCode(s.rate, d), note: d.cur === 'EUR' ? `EUR ${fmt(s.amount)} zum ESTV-Kurs ${EUR_RATE[p.date] ?? 0.94}` : '' });
  }
  (d.writeOffs ?? []).forEach((w, k) => {
    if (!agreed) { rows.push({ none: `${dmy(w.date)} · ${WO[w.reason]} ${d.cur} ${fmt(w.amount)}: keine Buchung. Vereinnahmt war der Rest nie versteuert; die Ausbuchung steht auf der Rechnung und in den Offenen Posten.` }); return; }
    const acc = w.reason === 'loss' ? '3805 Verluste aus Forderungen' : '3800 Erlösminderungen';
    for (const s of split(w.amount)) rows.push({ date: w.date, ref: `RE-${d.number}-wo-${k + 1}`, acc: `${acc} / 1100 Debitoren`, amount: `${cur}${fmt(chf(s.amount, w.date))}`, code: rateCode(s.rate, d) ? `−${rateCode(s.rate, d)}` : '', note: rateCode(s.rate, d) ? `MWST ${fmt(-r2(s.amount - s.amount / (1 + s.rate / 100)))} · MWST-Abrechnung Q4 2026, Ziffer 235` : '' });
  });
  if (!rows.length) rows.push({ none: agreed ? '' : 'Noch keine Buchung: vereinnahmt bucht erst die Zahlung.' });
  return rows;
}
function bookingsHtml(d) {
  const reg = F().vat;
  const label = !reg ? 'nicht MWST-pflichtig' : S.basis === 'agreed' ? 'vereinbart (Rechnungsdatum)' : 'vereinnahmt (Zahlungseingang)';
  return `<span class="basis">${esc(label)}</span><div class="bk">${bookings(d).map((b) => (b.none !== undefined ? `<div><span class="none">${esc(b.none)}</span></div>` : `<div><span class="mono">${dmy(b.date)}</span><span class="acc">${esc(b.acc)}${b.ref || b.code || b.note ? `<small>${[b.ref, b.code, b.note].filter(Boolean).map(esc).join(' · ')}</small>` : ''}</span><span class="amt">${esc(b.amount)}</span></div>`)).join('')}</div>`;
}

const WO = { skonto: 'Skonto', discount: 'Rabatt', loss: 'Verlust', fee: 'Gebühr', rounding: 'Rundung' };

// ---------------------------------------------------------------- routes
const VIEWS = [['list', 'Rechnungen'], ['quotes', 'Offerten · Aufträge'], ['open-items', 'Offene Posten'], ['recurring', 'Wiederkehrend'], ['customers', 'Kunden'], ['articles', 'Artikel'], ['sent', 'Versand']];
const NEW_VIEWS = new Set(['quotes', 'open-items', 'recurring', 'articles']);
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#/, '')) || '/invoices';
  const [p, qs] = h.split('?');
  const parts = p.split('/').filter(Boolean);
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  if (parts[0] === 'company') return { area: 'company', section: parts[1] ?? 'invoice-layout', q };
  const v = VIEWS.some(([k]) => k === parts[1]) && parts[1] !== 'list' ? parts[1] : 'list';
  const id = v === 'list' ? parts.slice(1).join('/') : parts.slice(2).join('/');
  return { area: 'invoices', view: v, id: id || undefined, q };
}
const go = (h) => { if (location.hash === h) render(); else location.hash = h; };

// ---------------------------------------------------------------- list column
const listHead = (title, addLabel, addAct, extra = '') => `<header class="lhead"><h1>${title}${title === 'Rechnungen' ? '<button type="button" class="period" data-act="noop" data-tip="Periode wählen">Q4 2026 <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></button>' : ''}${addLabel ? `<button type="button" class="addbtn${addAct !== 'dlg-new' ? ' nw' : ''}" data-act="${addAct}">${I.plus}<span>${addLabel}</span><span class="kb">N</span></button>` : ''}</h1>${extra}</header>`;
const views = (on) => `<span class="seg gb" role="tablist" aria-label="Ansicht">${VIEWS.filter(([k]) => S.firm === 'kaffee' || !['recurring'].includes(k)).map(([k, l]) => `<button type="button" role="tab" aria-selected="${on === k}" class="${on === k ? 'on' : ''}${NEW_VIEWS.has(k) ? ' nw' : ''}" data-href="#/invoices${k === 'list' ? '' : `/${k}`}">${l}</button>`).join('')}</span>`;
const row = (cls, href, sel, d, t, a) => `<div class="row ${cls}${sel ? ' sel' : ''}" role="option" aria-selected="${sel}" tabindex="${sel ? 0 : -1}" data-href="${href}"><span class="d mono">${d}</span><span class="t">${t}</span><span class="a mono">${a}</span></div>`;
const group = (label, n) => `<button type="button" class="group" aria-expanded="true"><span>${I.gch}${esc(label)}</span><span class="mono">${n}</span></button>`;

function inPeriod(d) {
  if (d.status === 'draft') return true;
  if (d.date >= '2026-10-01') return true;
  if (openOf(d) > 0) return true;
  if ((d.payments ?? []).some((p) => p.date >= '2026-10-01')) return true;
  if (d.kind === 'credit-note' && d.settlement === 'offset' && !d.offsetIn) return true;
  return false;
}
const STATE_LABEL = { overdue: 'Überfällig', open: 'Offen', draft: 'Entwürfe', paid: 'Bezahlt', credit: 'Gutschriften', cancelled: 'Storniert' };
function invoiceList(r) {
  const docs = D().docs.filter((d) => !pre(d) && inPeriod(d));
  const st = r.q.status;
  const n = { all: docs.length, open: docs.filter((d) => ['open', 'overdue'].includes(stateOf(d))).length, overdue: docs.filter((d) => stateOf(d) === 'overdue').length, draft: docs.filter((d) => stateOf(d) === 'draft').length, paid: docs.filter((d) => stateOf(d) === 'paid').length };
  const shown = docs.filter((d) => !st || (st === 'open' ? ['open', 'overdue'].includes(stateOf(d)) : stateOf(d) === st));
  const sums = { CHF: 0, EUR: 0, oCHF: 0, oEUR: 0 };
  for (const d of docs) { const o = openOf(d); if (o > 0) { sums[d.cur] += o; if (stateOf(d) === 'overdue') sums[`o${d.cur}`] += o; } }
  const tab = (k, label, cnt) => (cnt > 0 || st === k || !k ? `<button type="button" role="tab" aria-selected="${(st ?? '') === (k ?? '')}" class="${(st ?? '') === (k ?? '') ? 'on' : ''}" data-href="#/invoices${k ? `?status=${k}` : ''}"><span class="n">${cnt}</span>${label}</button>` : '');
  let rowsHtml = '';
  for (const g of ['overdue', 'open', 'draft', 'paid', 'credit', 'cancelled']) {
    const gs = shown.filter((d) => stateOf(d) === g);
    if (!gs.length) continue;
    rowsHtml += group(STATE_LABEL[g], gs.length);
    for (const d of gs) {
      const o = openOf(d), gr = gross(d), c = cust(d.cu);
      const amount = `${d.cur !== 'CHF' ? `<span class="c">${d.cur}</span>` : ''}${(g === 'open' || g === 'overdue') && o !== gr ? `${fmt(o)}<small class="m"> von ${fmt(gr)}</small>` : fmt(gr)}`;
      const tag = d.paidAtIssue ? '<small class="nw"> · Quittung</small>' : d.recurring ? '<small class="nw"> · Vorlage</small>' : d.from?.kind === 'quote' ? '' : '';
      const dno = d.status === 'draft' ? '<span class="draftno">Entwurf</span>' : d.number;
      rowsHtml += row(`inv st-${g}`, `#/invoices/${rid(d)}${st ? `?status=${st}` : ''}`, rid(d) === r.id, dno, `${g === 'overdue' ? I.dot : ''}${esc(c.name)} <small>${esc(d.subject ?? '')}</small>${tag}`, amount);
    }
  }
  const proposals = D().docs.filter((d) => d.proposal || d.feeProposal).length;
  return `<div class="page">${listHead('Rechnungen', 'Neue Rechnung', 'dlg-new', `<div class="counts" role="tablist" aria-label="Rechnungen filtern">${tab(undefined, 'alle', n.all)}${tab('open', 'offen', n.open)}${tab('overdue', 'überfällig', n.overdue)}${tab('draft', 'Entwürfe', n.draft)}${tab('paid', 'bezahlt', n.paid)}${views('list')}</div>`)}
    <div class="vresult static"><span>Offen</span><b class="mono"><small>CHF</small>${fmt(sums.CHF)}${sums.EUR ? `<span class="also"> + <small>EUR</small>${fmt(sums.EUR)}</span>` : ''}</b></div>
    ${sums.oCHF || sums.oEUR ? `<div class="notice warn rgap">${I.dot}<span>davon überfällig ${[sums.oCHF ? `CHF ${fmt(sums.oCHF)}` : '', sums.oEUR ? `EUR ${fmt(sums.oEUR)}` : ''].filter(Boolean).join(' + ')}</span></div>` : ''}
    ${proposals ? `<div class="notice rgap nw">${I.dot}<span>${proposals === 1 ? '1 Zahlung wartet' : `${proposals} Zahlungen warten`} auf dich: Vorschlag prüfen</span></div>` : ''}
    <div class="rows" role="listbox" aria-label="Rechnungen">${rowsHtml || '<div class="empty"><p>Keine Rechnungen in diesem Filter.</p></div>'}</div></div>`;
}

const Q_LABEL = { sent: 'Gesendet', draft: 'Entwürfe', accepted: 'Angenommen', declined: 'Abgelehnt', expired: 'Abgelaufen', done: 'Ausgestellt' };
function quoteList(r) {
  const qs = D().docs.filter(pre);
  const groups = [
    ['Entwürfe', (d) => d.status === 'draft'],
    ['Offerten gesendet', (d) => d.kind === 'quote' && stateOf(d) === 'sent'],
    ['Auftragsbestätigungen', (d) => d.kind === 'order' && d.status !== 'draft'],
    ['Lieferscheine', (d) => d.kind === 'delivery-note' && d.status !== 'draft'],
    ['Offerten angenommen', (d) => d.kind === 'quote' && stateOf(d) === 'accepted'],
    ['Offerten abgelehnt oder abgelaufen', (d) => d.kind === 'quote' && ['declined', 'expired'].includes(stateOf(d))],
  ];
  let rowsHtml = '';
  for (const [label, test] of groups) {
    const gs = qs.filter(test);
    if (!gs.length) continue;
    rowsHtml += group(label, gs.length);
    for (const d of gs) {
      const st = stateOf(d);
      const cls = st === 'draft' ? 'draft' : st === 'sent' ? 'open' : st === 'accepted' || st === 'done' ? 'paid' : 'cancelled';
      const kindTag = d.kind === 'quote' ? '' : ` <small class="nw">· ${KIND[d.kind]}</small>`;
      rowsHtml += row(`inv st-${cls}`, hrefOf(d), rid(d) === r.id, d.status === 'draft' ? '<span class="draftno">Entwurf</span>' : d.number, `${esc(cust(d.cu).name)} <small>${esc(d.subject)}</small>${d.status === 'draft' ? ` <small class="nw">· ${KIND[d.kind]}</small>` : kindTag}`, d.kind === 'delivery-note' ? '<small class="m">ohne Preise</small>' : `${d.cur !== 'CHF' ? `<span class="c">${d.cur}</span>` : ''}${fmt(gross(d))}`);
    }
  }
  const open = qs.filter((d) => d.kind === 'quote' && d.qstatus === 'sent');
  return `<div class="page">${listHead('Rechnungen', 'Neue Offerte', 'dlg-newquote', `<div class="counts"><span class="n">${qs.length}</span>&nbsp;Dokumente · eigene Nummern OF-, AB-, LS-${views('quotes')}</div>`)}
    <div class="vresult static"><span>Offen offeriert</span><b class="mono"><small>CHF</small>${fmt(open.reduce((s, d) => s + gross(d), 0))}</b></div>
    <div class="rows" role="listbox" aria-label="Offerten und Aufträge">${rowsHtml}</div></div>`;
}

function customerList(r) {
  const cs = [...D().customers].sort((a, b) => a.name.localeCompare(b.name));
  const rowsHtml = cs.map((c) => {
    const o = D().docs.filter((d) => d.cu === c.id).reduce((s, d) => s + (d.cur === 'CHF' ? openOf(d) : 0), 0);
    return `<div class="row cust${r.id === c.id ? ' sel' : ''}" role="option" aria-selected="${r.id === c.id}" data-href="#/invoices/customers/${c.id}"><span class="t">${esc(c.name)} <small>${esc(c.town.replace(/^\d+ /, ''))}${c.country !== 'CH' ? `, ${c.country}` : ''}</small>${c.noReminders ? ' <small class="nw">· nie mahnen</small>' : ''}</span><span class="a mono">${o ? fmt(o) : ''}</span></div>`;
  }).join('');
  return `<div class="page">${listHead('Rechnungen', 'Neuer Kunde', 'noop-new-customer', `<div class="counts"><span class="n">${cs.length}</span>&nbsp;Kunden${views('customers')}</div>`)}<div class="rows" role="listbox" aria-label="Kunden">${rowsHtml}</div></div>`;
}

function articleList(r) {
  const rowsHtml = D().articles.map((a) => `<div class="row cust${r.id === a.id ? ' sel' : ''}" role="option" aria-selected="${r.id === a.id}" data-href="#/invoices/articles/${a.id}"><span class="t">${esc(a.text)} <small>${esc(a.no)} · ${UNITS[a.unit]}${F().vat ? ` · ${a.rate} %` : ''}</small></span><span class="a mono">${fmt(a.price)}</span></div>`).join('');
  return `<div class="page">${listHead('Rechnungen', 'Neuer Artikel', 'noop-new-article', `<div class="counts"><span class="n">${D().articles.length}</span>&nbsp;Artikel · Preis und Satz, kein Lager${views('articles')}</div>`)}<div class="rows" role="listbox" aria-label="Artikel">${rowsHtml}</div></div>`;
}

const EVERY = { month: 'monatlich', quarter: 'vierteljährlich', year: 'jährlich' };
const MODE = { draft: 'Entwurf anlegen', issue: 'ausstellen', send: 'ausstellen und senden' };
function recurringList(r) {
  const rowsHtml = D().recurring.map((t) => row('inv st-open', `#/invoices/recurring/${t.id}`, r.id === t.id, dmy(t.next).slice(0, 6), `${esc(cust(t.cu).name)} <small>${esc(t.name)} · ${EVERY[t.every]}</small>`, fmt(totals(t.lines).gross))).join('');
  return `<div class="page">${listHead('Rechnungen', 'Neue Vorlage', 'noop-new-template', `<div class="counts"><span class="n">${D().recurring.length}</span>&nbsp;Vorlagen · der Code legt sie an ihrem Tag an${views('recurring')}</div>`)}
    ${group('Nächste', D().recurring.length)}<div class="rows" role="listbox" aria-label="Wiederkehrend">${rowsHtml || '<div class="empty"><p>Keine Vorlagen.</p></div>'}</div></div>`;
}

const BANDS = [['notdue', 'nicht fällig'], ['b30', '0–30 Tage'], ['b60', '31–60'], ['b90', '61–90'], ['b90p', '> 90']];
function band(d) { const over = days(d.due ?? d.date, TODAY); return over <= 0 ? 'notdue' : over <= 30 ? 'b30' : over <= 60 ? 'b60' : over <= 90 ? 'b90' : 'b90p'; }
function openItems() { return D().docs.filter((d) => openOf(d) > 0); }
function openItemsList(r) {
  const items = openItems();
  const sum = (arr, cur = 'CHF') => r2(arr.filter((d) => d.cur === cur).reduce((s, d) => s + openOf(d), 0));
  const cards = BANDS.map(([k, l]) => { const a = sum(items.filter((d) => band(d) === k)); return `<div class="${k !== 'notdue' && a ? 'warn' : ''}"><span>${l}</span><b>${fmt(a)}</b></div>`; }).join('');
  const cs = D().customers.filter((c) => items.some((d) => d.cu === c.id));
  const crow = (href, sel, t, a) => `<div class="row cust${sel ? ' sel' : ''}" role="option" aria-selected="${sel}" data-href="${href}"><span class="t">${t}</span><span class="a mono">${a}</span></div>`;
  const rowsHtml = crow('#/invoices/open-items', !r.id, 'Alle Kunden <small>Debitorenliste per 14.11.2026</small>', `${fmt(sum(items))}${sum(items, 'EUR') ? ` <small class="m">+ EUR ${fmt(sum(items, 'EUR'))}</small>` : ''}`)
    + cs.map((c) => { const its = items.filter((d) => d.cu === c.id); const cur = its[0].cur; const over = days(its.map((d) => d.due).sort()[0], TODAY); return crow(`#/invoices/open-items/${c.id}`, r.id === c.id, `${esc(c.name)} <small>${its.length} ${its.length === 1 ? 'Rechnung' : 'Rechnungen'} · ${over > 0 ? `älteste ${over} Tage über fällig` : 'nicht fällig'}</small>`, `${cur !== 'CHF' ? `<span class="c">${cur}</span>` : ''}${fmt(sum(its, cur))}`); }).join('');
  return `<div class="page">${listHead('Rechnungen', '', '', `<div class="counts"><span class="n">${items.length}</span>&nbsp;offene Posten · Stichtag 14.11.2026${views('open-items')}</div>`)}
    <div class="aging nw">${cards}</div><div class="rows" role="listbox" aria-label="Offene Posten">${rowsHtml}</div></div>`;
}

function sentList(r) {
  const all = D().docs.flatMap((d) => (d.sent ?? []).map((s, k) => ({ ...s, d, id: `${d.id}-${k}` }))).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  let html = '', month = '';
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  for (const s of all) {
    const m = s.date.slice(0, 7);
    if (m !== month) { html += `<div class="group"><span>${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}</span></div>`; month = m; }
    html += `<div class="row sentrow${r.id === s.id ? ' sel' : ''}" role="option" aria-selected="${r.id === s.id}" data-href="#/invoices/sent/${s.id}"><span class="d mono">${dmy(s.date).slice(0, 6)}</span><span class="t">${esc(s.title)} <small>${esc(cust(s.d.cu).name)} · ${s.reminder ? 'Mahnung' : kindOf(s.d)}${s.by ? ' · von der Vorlage' : ''}</small></span><span class="a mono">${s.time}</span></div>`;
  }
  return { html: `<div class="page">${listHead('Rechnungen', '', '', `<div class="counts"><span class="n">${all.length}</span>&nbsp;gesendet${views('sent')}</div>`)}<div class="rows" role="listbox" aria-label="Versand">${html}</div></div>`, all };
}

// ---------------------------------------------------------------- detail column
const sec = (k, label, val, body, open = true, nw = false) => {
  const on = S.ui.open[k] ?? open;
  return `<div class="sec${on ? ' open' : ''}${nw ? ' nw' : ''}" data-sec="${k}"><button type="button" class="sum" aria-expanded="${on}" data-act="sec" data-k="${k}">${I.chev}<span class="lbl">${esc(label)}</span><span class="val">${esc(val)}</span></button><div class="in"><div><div class="pad">${body}</div></div></div></div>`;
};
const kv = (pairs) => `<dl class="kv">${pairs.filter(Boolean).map(([k, v, nw]) => `<dt${nw ? ' class="nw"' : ''}>${esc(k)}</dt><dd${nw ? ' class="nw"' : ''}>${v}</dd>`).join('')}</dl>`;
const logHtml = (d) => `<div class="ivlog">${(d.log ?? []).map(([dt, t]) => `<div><span class="mono">${dmy(dt)}</span><span>${esc(t)}</span></div>`).join('')}</div>`;
const sentHtml = (d) => `<div class="ivsent">${(d.sent ?? []).map((s, k) => `<button type="button" class="sdoc" data-href="#/invoices/sent/${d.id}-${k}"><span class="mono">${dmy(s.date)}</span><span>${esc(s.title)}<small>${esc(s.to)} · ${s.time}${s.by ? ' · von der Vorlage' : ''}</small></span><span class="m">ansehen</span></button>`).join('') || '<p class="m">Noch nicht gesendet.</p>'}</div>`;
const custKv = (c) => kv([['Name', esc(c.name)], ['Adresse', esc(`${c.street}, ${c.town}${c.country !== 'CH' ? `, ${c.countryName ?? c.country}` : ''}`)], ['E-Mail', esc(c.email)], ['MWST-Nr.', esc(c.vatId ?? '–')], ['Zahlungsfrist', `${c.terms} Tage`]]);
const empty = (txt) => `<div class="detail-empty"><div>${esc(txt)}</div></div>`;
const seg2 = (label, opts, value, act, nwSet = new Set()) => `<span class="seg2" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === value}" class="${v === value ? 'on' : ''}${nwSet.has(v) ? ' nw' : ''}" data-act="${act}" data-v="${v}">${esc(l)}</button>`).join('')}</span>`;

function head(d) {
  const c = cust(d.cu), t = totals(d.lines);
  const facts = [];
  if (d.number) facts.push(`<span>Nr. ${d.number}</span>`); else facts.push('<span>Entwurf, noch ohne Nummer</span>');
  facts.push(`<span data-tip="Datum">${dmy(d.date)}</span>`);
  if (d.kind === 'quote') facts.push(`<span class="nw">gültig bis ${dmy(d.validUntil)}</span>`);
  else if (d.due && !d.paidAtIssue) facts.push(`<span data-tip="Zahlbar bis">fällig ${dmy(d.due)}</span>`);
  if (d.ref) facts.push(`<span data-tip="Zahlungsreferenz">${esc(d.ref)}</span>`);
  if (d.kind === 'delivery-note') facts.push('<span class="nw">ohne Preise</span>');
  else if (F().vat) facts.push(`<span>MWST ${t.vat ? fmt(t.vat) : '0 %'}</span>`); else facts.push('<span>ohne MWST</span>');
  const sub = d.kind === 'invoice' && !d.paidAtIssue ? d.subject ?? '' : `${kindOf(d)} ${d.number ?? ''} ${d.subject ?? ''}`;
  const amount = d.kind === 'delivery-note' ? '' : `<div class="amount"><small>${d.cur}</small>${fmt(t.gross)}</div>`;
  return `<div class="head"><h2 class="who">${esc(c.name)}<small>${esc(sub)}</small></h2>${amount}</div><div class="facts">${facts.join('')}</div>`;
}

// The chain of documents a document belongs to (spec 4.4 «Folgedokument»), from the first to the last, each a link.
function chainOf(d) {
  let root = d;
  const seen = new Set();
  while (root.from && doc(root.from.id) && !seen.has(root.id)) { seen.add(root.id); root = doc(root.from.id); }
  const out = [];
  const walk = (x) => { out.push(x); D().docs.filter((y) => y.id !== x.id && (y.from?.id === x.id || (y.kind === 'credit-note' && y.creditFor === x.id))).sort((a, b) => a.date.localeCompare(b.date)).forEach(walk); };
  walk(root);
  return out;
}
function chainHtml(d) {
  const c = chainOf(d);
  if (c.length < 2) return '';
  const label = (x) => `${kindOf(x)} ${x.number ?? 'Entwurf'}`;
  return `<nav class="ivchain nw" aria-label="Dokumentkette"><span class="lbl">Kette</span>${c.map((x) => (x.id === d.id ? `<b aria-current="page">${esc(label(x))}</b>` : `<a class="golink" href="${hrefOf(x)}">${esc(label(x))}</a>`)).join('<span class="ar" aria-hidden="true">→</span>')}</nav>`;
}

// Betrag · erhalten · gutgeschrieben · offen: every figure from the books' facts, none set by a click.
function figuresHtml(d) {
  if (d.kind !== 'invoice' || d.status !== 'issued') return '';
  const f = figures(d), last = d.payments?.at(-1);
  const got = d.paidAtIssue ? 'bei Ausstellung' : last ? `aus dem Kontoauszug, ${dmy(last.date)}` : 'noch nichts eingegangen';
  const cr = [...f.credits.map((x) => `Gutschrift ${x.number}`), ...(d.writeOffs ?? []).map((w) => `${WO[w.reason]} ausgebucht`)].join(' · ') || 'keine Gutschrift';
  const openNote = d.cancelled ? 'storniert' : f.open < 0 ? 'Guthaben des Kunden, zu verrechnen' : f.open === 0 ? (f.elsewhere ? `Guthaben verrechnet mit ${doc(f.credits.find((x) => x.offsetIn).offsetIn).number}` : 'nichts offen') : stateOf(d) === 'overdue' ? `fällig seit ${days(d.due, TODAY)} Tagen` : `fällig ${dmy(d.due)}`;
  const cell = (label, v, note, cls = '') => `<div class="${cls}"><span>${label}</span><b class="mono">${fmt(v)}</b><small>${esc(note)}</small></div>`;
  return `<div class="ivfig nw" role="group" aria-label="Betrag, erhalten, gutgeschrieben, offen">${cell(`Betrag ${d.cur}`, f.amount, `ausgestellt ${dmy(d.date)}`)}${cell('erhalten', f.got, got)}${cell('gutgeschrieben', f.credited, cr)}${cell('offen', f.open, openNote, f.open > 0 && stateOf(d) === 'overdue' ? 'warn' : f.open > 0 ? 'open' : '')}</div>`;
}

function statusHtml(d) {
  const st = stateOf(d), parts = [];
  if (d.kind === 'quote') {
    const label = { draft: 'Offerte als Entwurf · erhält die Nummer OF-… beim Senden', sent: `Offerte · gesendet ${dmy(d.sent?.[0]?.date)} · gültig bis ${dmy(d.validUntil)}, noch ${days(TODAY, d.validUntil)} Tage`, accepted: 'Angenommen', declined: 'Abgelehnt', expired: `Abgelaufen am ${dmy(d.validUntil)}` }[st];
    const inv = (d.invoicedAs ?? []).map((id) => `<a class="golink" href="#/invoices/recurring/${id}">Vorlage «${esc(D().recurring.find((x) => x.id === id).name)}»</a>`).join(', ');
    return `<div class="status"><span class="notice nw">${esc(label)}${inv ? ` · in ${inv}` : ''}</span></div>`;
  }
  if (pre(d) && st === 'done') {
    const s0 = d.sent?.at(-1);
    return `<div class="status"><span class="notice nw">${KIND[d.kind]} · ${s0 ? `${s0.to === 'heruntergeladen' ? 'heruntergeladen' : 'gesendet'} ${dmy(s0.date)} (aus dem Versandprotokoll)` : 'ausgestellt, noch nicht gesendet'} · bucht nichts</span></div>`;
  }
  if (st === 'draft') {
    parts.push(`<span class="notice">${d.kind === 'invoice' ? 'Entwurf' : `${KIND[d.kind]} als Entwurf`} · erhält die Nummer${d.kind === 'order' ? ' AB-…' : d.kind === 'delivery-note' ? ' LS-…' : ''} beim Ausstellen</span>`);
    if (d.paidAtIssue) parts.push(`<div class="notice nw" role="note">${I.dot}<span>Wird als Quittung ausgestellt: bezahlt ${T.de.means[d.paidAtIssue]} am Ausstellungstag, kein QR-Zahlteil.</span></div>`);
    const ded = d.lines.find((l) => l.kind === 'ded');
    if (ded) parts.push(`<div class="notice nw" role="note">${I.dot}<span>Gutschrift <a class="golink" href="#/invoices/${doc(ded.deducts).number}">${doc(ded.deducts).number}</a> abgezogen: ${d.cur} ${fmt(-lineAmount(ded))} waren mit der nächsten Rechnung zu verrechnen. «×» auf der Zeile nimmt sie heraus.</span></div>`);
    if (d.from) { const src = doc(d.from.id); parts.push(`<div class="notice nw">${I.dot}<span>Folgedokument von <a class="golink" href="${hrefOf(src)}">${KIND[src.kind]} ${src.number}</a>: alle Positionen übernommen${src.lines.some((l) => l.optional) ? ', die Optionen nach deiner Wahl' : ''}</span></div>`); }
    return `<div class="status">${parts.join('')}</div>`;
  }
  if (S.ui.reminder === d.id) return `<div class="status"><span class="notice">${(d.reminders?.length ?? 0) + 1}. Mahnung · Entwurf · neu fällig ${dmy(addDays(TODAY, 10))}</span></div>`;
  const sentAt = d.sent?.length ? ` · gesendet ${dmy(d.sent[d.sent.length - 1].date)}` : '';
  const rem = d.reminders?.length ? ` · ${d.reminders.length}. Mahnung gesendet ${dmy(d.reminders.at(-1).date)}` : '';
  if (st === 'cancelled') parts.push(`<span class="notice">Storniert am ${dmy(d.cancelled.date)} · ${esc(d.cancelled.reason)}</span>`);
  else if (st === 'credit') {
    const into = d.offsetIn ? doc(d.offsetIn) : D().docs.find((x) => x.status === 'draft' && x.lines.some((l) => l.deducts === d.id));
    parts.push(`<span class="notice nw">Gutschrift zu <a class="golink" href="#/invoices/${doc(d.creditFor).number}">Rechnung ${doc(d.creditFor).number}</a> · ${d.offsetIn ? `verrechnet mit <a class="golink" href="#/invoices/${into.number}">Rechnung ${into.number}</a>` : d.settlement === 'refund' ? 'zurückzuzahlen an den Kunden' : into ? `zu verrechnen: Abzugszeile im <a class="golink" href="#/invoices/${rid(into)}">Entwurf ${esc(into.subject)}</a>` : 'zu verrechnen mit der nächsten Rechnung'}</span>`);
  } else if (st === 'paid') {
    const last = d.payments?.at(-1);
    const wo = (d.writeOffs ?? []).map((w) => ` · ${WO[w.reason]} ${d.cur} ${fmt(w.amount)} ausgebucht${w.by === 'Code' ? ' (von Code, wie in den Bedingungen)' : ''}`).join('');
    parts.push(`<span class="linked">${I.check}${d.paidAtIssue ? `Quittung · bezahlt ${T.de.means[d.paidAtIssue]} am ${dmy(d.date)}` : last ? `bezahlt am ${dmy(last.date)}, ${d.cur} ${fmt(paid(d))}` : `ausgebucht`}<span class="${wo ? 'nw' : ''}">${esc(wo)}</span></span>`);
  } else {
    const o = openOf(d), part = paid(d) ? `${d.cur} ${fmt(o)} offen von ${fmt(gross(d))} · ` : '';
    const txt = st === 'overdue' ? `${part}Überfällig seit ${days(d.due, TODAY)} Tagen${sentAt}${rem}` : `${part}Offen · fällig in ${days(TODAY, d.due)} Tagen${sentAt}${rem}`;
    parts.push(`<span class="notice${st === 'overdue' ? ' warn' : ''}">${st === 'overdue' ? I.dot : ''}${esc(txt)}</span>`);
    if (cust(d.cu).noReminders) parts.push('<div class="notice nw">Kunde: nie mahnen</div>');
  }
  for (const p of d.payments ?? []) if (p.date >= '2026-11-01' && !d.paidAtIssue) parts.push(`<div class="notice ivpay"><span>${I.check} Zahlung vom ${dmy(p.date)} · ${d.cur} ${fmt(p.amount)} · zugeordnet über ${esc(p.by)}</span><button type="button" class="btn ghost" data-act="noop" data-tip="Die Zuordnung lösen">Lösen</button></div>`);
  if (d.proposal) parts.push(`<div class="notice ivpay nw" data-testid="proposal"><span>Zahlung vom ${dmy(d.proposal.date)} · ${d.cur} ${fmt(d.proposal.amount)} · «${esc(d.proposal.text)}»: die Nummer steht im Text, der Betrag ist kleiner als offen</span><button type="button" class="btn ghost" data-act="confirm-pay">Zuordnen</button></div>`);
  if (d.feeProposal) parts.push(`<div class="notice ivpay nw"><span>Rest ${d.cur} ${fmt(d.feeProposal.amount)}: unter der Grenze von CHF ${fmt(S.settings.limit)}, vermutlich Spesen der Bank des Kunden. Vorschlag: als Gebühr ausbuchen.</span><button type="button" class="btn ghost" data-act="fee-wo">Ausbuchen</button></div>`);
  if (openOf(d) > 0 && paid(d) > 0 && !d.feeProposal) parts.push(`<div class="notice warn ivpay nw"><span>${I.dot} Rest ${d.cur} ${fmt(openOf(d))} offen: über der Grenze von CHF ${fmt(S.settings.limit)}, darum fragt die App dich.</span><button type="button" class="btn ghost" data-act="dlg-writeoff">Rest ausbuchen</button></div>`);
  return `<div class="status">${parts.join('')}</div>`;
}

function actions(d) {
  const st = stateOf(d), b = [];
  const pdf = d.status === 'issued' ? '<button type="button" class="dl inline" data-act="pdf" data-tip="Das PDF, genau so, wie es ausgestellt wurde (D)">' + I.dl + '<span>PDF herunterladen</span></button>' : '';
  const preview = `<button type="button" class="btn ghost" data-act="preview" aria-pressed="${S.ui.preview}">${S.ui.preview ? 'Bearbeiten' : 'Vorschau'}</button>`;
  const followBtn = (primary = false) => `<button type="button" class="btn ${primary ? 'primary' : 'ghost'} nw" data-act="dlg-follow">Folgedokument erstellen</button>`;
  if (d.kind === 'quote') {
    if (st === 'draft') b.push(preview, '<button type="button" class="btn primary nw" data-act="q-send">Senden</button>', '<button type="button" class="btn ghost danger" data-act="delete">Löschen</button>');
    if (st === 'sent') b.push('<button type="button" class="btn primary nw" data-act="convert">In Rechnung umwandeln</button>', followBtn(), '<button type="button" class="btn ghost nw" data-act="q-accept">Angenommen</button>', '<button type="button" class="btn ghost nw" data-act="q-decline">Abgelehnt</button>', '<button type="button" class="btn ghost" data-act="q-resend">Nochmals senden</button>');
    if (st === 'accepted') b.push(followBtn(true));
    if (st === 'expired' || st === 'declined') b.push(followBtn(), '<button type="button" class="btn ghost" data-act="copy">Als Entwurf kopieren</button>');
    return `<div class="ivacts">${b.join('')}${pdf}</div>`;
  }
  if (st === 'draft') {
    return `<div class="ivacts">${preview}<button type="button" class="btn primary" data-act="issue">${d.paidAtIssue ? 'Quittung ausstellen' : d.kind === 'invoice' ? 'Ausstellen' : `${KIND[d.kind]} ausstellen`}</button><button type="button" class="btn ghost danger" data-act="delete">Löschen</button></div>`;
  }
  if (pre(d)) return `<div class="ivacts">${followBtn(true)}<button type="button" class="btn ghost" data-act="send">Nochmals senden</button><button type="button" class="btn ghost" data-act="copy">Als Entwurf kopieren</button>${pdf}</div>`;
  if (S.ui.reminder === d.id) {
    const lv = (d.reminders?.length ?? 0) + 1;
    return `<div class="ivacts">${preview}<button type="button" class="btn primary" data-act="remind-send">${lv}. Mahnung senden</button><button type="button" class="btn ghost" data-act="remind-cancel">Abbrechen</button></div>`;
  }
  const lv = (d.reminders?.length ?? 0) + 1;
  if (st === 'overdue' && !cust(d.cu).noReminders) b.push(`<button type="button" class="btn primary" data-act="remind">${lv}. Mahnung</button>`);
  if (st === 'open' || st === 'overdue') b.push(`<button type="button" class="btn ${st === 'overdue' || d.sent?.length ? 'ghost' : 'primary'}" data-act="send">${d.sent?.length ? 'Nochmals senden' : 'Senden'}</button>`, '<button type="button" class="btn ghost nw" data-act="dlg-writeoff">Rest ausbuchen</button>');
  if (st === 'credit') b.push('<button type="button" class="btn ghost" data-act="send">Nochmals senden</button>');
  if (st !== 'credit' && st !== 'cancelled') b.push(followBtn(st === 'paid'), '<button type="button" class="btn ghost" data-act="copy">Als Entwurf kopieren</button>');
  if (['open', 'overdue', 'paid'].includes(st)) b.push('<button type="button" class="btn ghost danger" data-act="cancel">Stornieren</button>');
  return `<div class="ivacts">${b.join('')}${pdf}</div>`;
}

function interestFor(d) {
  if (!S.settings.interest) return null;
  const n = days(d.due, TODAY);
  return { days: n, amount: r2(openOf(d) * S.settings.rate / 100 * n / 365) };
}

function margin(d) {
  const c = cust(d.cu), out = [];
  if (d.status === 'draft' && !pre(d) && d.kind !== 'credit-note') {
    const curOpts = [['CHF', 'CHF'], ...(F().ibanEUR ? [['EUR', 'EUR']] : [])];
    const means = [['', 'Nein'], ['cash', 'Bar'], ['twint', 'TWINT'], ['card', 'Karte']];
    const eurNote = d.cur === 'EUR' && eurQrKept() ? '<p class="m ivhint nw">EUR mit QR-IBAN und QR-Referenz, wie in Firma › Rechnungslayout gespeichert (QR-Rechnung v2.3, von Banken bis November 2027 angenommen).</p>' : d.cur === 'EUR' ? `<p class="m ivhint nw">EUR: kein QR-Zahlteil. Die QR-IBAN gilt seit der QR-Rechnung v2.4 nur für CHF; die Rechnung nennt die IBAN ${esc(F().ibanEUR)} mit einer SCOR-Referenz (RF…), keine QR-Referenz.</p>` : '';
    const mean = d.paidAtIssue ? `<p class="m ivhint nw">Gebucht am Ausstellungstag: ${MEANS_ACC[d.paidAtIssue].join(' ')}${d.paidAtIssue === 'cash' && S.firm === 'salon' ? ' (neu im Kontenplan, beim ersten Mal angelegt)' : ''} / ${F().revenue[0].join(' ')}${F().vat ? ', mit den Verkaufscodes' : ', ohne MWST-Code (nicht registriert)'}. Nichts bleibt offen.</p>` : '';
    out.push(sec('draft', 'Rechnung', `Deutsch · ${d.cur}`, `<div class="lkf"><div class="lkr"><span>Sprache</span>${seg2('Sprache', [['de', 'DE'], ['fr', 'FR'], ['it', 'IT'], ['en', 'EN']], d.lang, 'lang')}</div><div class="lkr"><span>Währung</span>${seg2('Währung', curOpts, d.cur, 'cur')}</div><div class="lkr nw"><span>Bezahlt bei Ausstellung</span>${seg2('Bezahlt bei Ausstellung', means, d.paidAtIssue ?? '', 'means')}</div></div>${eurNote}${mean}<p class="lkfoot"><a class="quiet2" href="#/company/invoice-layout">Schrift, Logo, Skonto und Mahnwesen: Firma › Rechnungslayout →</a></p>`));
  } else if (d.kind === 'quote') {
    const nOpt = d.lines.filter((l) => l.optional).length;
    out.push(sec('quote', 'Offerte', `gültig bis ${dmy(d.validUntil)}`, kv([['Nummer', esc(d.number ?? 'beim Senden'), true], ['Gültig', `${dmy(d.date)} – ${dmy(d.validUntil)} (Firma › Rechnungslayout: 30 Tage)`, true], ['Stand', esc(Q_LABEL[stateOf(d)] ?? ''), true], ['Optionen', nOpt ? `${nOpt}, gezeigt, nicht im Total` : 'keine', true], ['Bucht', 'nichts', true]]) + '<p class="m ivhint nw">Eigene Nummernreihe: abgelehnte Offerten lassen in der Rechnungsnummer keine Lücke.</p><p class="m ivhint nw">«Gesendet» schreibt der Versand selbst, mit Zeit und Empfänger. «Angenommen» oder «abgelehnt» weiss nur der Kunde: das sagst du mit einem Klick, oder ein Folgedokument sagt es.</p>', true, true));
  } else if (pre(d)) {
    out.push(sec('pre', KIND[d.kind], d.number ?? 'Entwurf', kv([['Nummer', esc(d.number ?? `beim Ausstellen, ${SERIES[d.kind]}…`), true], ['Auf Papier', d.kind === 'delivery-note' ? 'Positionen und Mengen, keine Preise' : 'wie die Offerte, mit Preisen', true], ['Bucht', 'nichts', true]]) + '<p class="m ivhint nw">Derselbe Editor wie für Rechnungen: das Blatt bearbeiten, «Vorschau», ausstellen, senden.</p>', true, true));
  } else if (d.kind === 'credit-note' && d.status === 'draft') {
    out.push(sec('cn', 'Gutschrift', `zu ${doc(d.creditFor).number}`, kv([['Zu Rechnung', `<a class="golink" href="${hrefOf(doc(d.creditFor))}">${doc(d.creditFor).number}</a>`], ['Höchstens', `${d.cur} ${fmt(gross(doc(d.creditFor)))}`]]) + '<p class="m ivhint">Alle Positionen der Rechnung mit Minus übernommen; streiche, was nicht gutgeschrieben wird.</p>', true));
  } else if (S.ui.reminder === d.id) {
    const lv = (d.reminders?.length ?? 0) + 1, fee = S.settings.fees[lv - 1], int = interestFor(d);
    out.push(sec('rem', `${lv}. Mahnung`, `neu fällig ${dmy(addDays(TODAY, 10))}`, kv([['Gebühr', fee ? `CHF ${fmt(fee)} (ohne MWST)` : 'keine'], ['Verzugszins', int ? `${S.settings.rate} % ab ${dmy(d.due)}: CHF ${fmt(int.amount)}, ohne MWST` : 'aus', true]]) + `<p class="m ivhint nw">${int ? 'Eingeschaltet in Firma › Rechnungslayout.' : 'Für neue Firmen aus. Wer ihn verrechnet, schaltet ihn in Firma › Rechnungslayout ein (OR Art. 104: 5 % ab Fälligkeit).'} <a class="quiet2" href="#/company/invoice-layout">Mahnwesen →</a></p>`));
  } else {
    out.push(sec('look', 'Gestaltung', `${d.lang === 'fr' ? 'Französisch' : 'Deutsch'} · Inter`, '<p class="m">Beim Ausstellen festgehalten. Eine ausgestellte Rechnung ändert sich nicht mehr; «Als Entwurf kopieren» macht eine neue.</p>', false));
  }
  if (d.from || d.recurring) {
    const src = d.from && doc(d.from.id);
    const from = d.recurring ? `<a class="golink" href="#/invoices/recurring/${d.recurring}">Vorlage «${esc(D().recurring.find((x) => x.id === d.recurring).name)}»</a>, am ${dmy(d.date)} vom Code ausgestellt und gesendet` : `<a class="golink" href="${hrefOf(src)}">${KIND[src.kind]} ${src.number}</a>`;
    out.push(sec('from', 'Herkunft', d.recurring ? 'Vorlage' : KIND[src.kind], `<p class="m">${from}</p>`, true, true));
  }
  out.push(sec('customer', 'Kunde', c.town.replace(/^\d+ /, ''), custKv(c) + (d.status === 'issued' ? '<p class="m ivhint">So beim Ausstellen festgehalten; eine spätere Änderung am Kunden gilt für neue Rechnungen.</p>' : ''), false));
  if (d.status === 'issued' || d.status === 'draft') out.push(sec('book', 'Buchungen', S.basis === 'agreed' && F().vat ? 'vereinbart' : F().vat ? 'vereinnahmt' : 'ohne MWST', bookingsHtml(d), d.status === 'issued' && !pre(d), true));
  if (d.status === 'issued') out.push(sec('sent', 'Gesendet', String(d.sent?.length ?? 0), sentHtml(d), true));
  out.push(sec('comments', 'Kommentare', '', '<div class="ivnotes"></div>', false));
  out.push(sec('log', 'Verlauf', String(d.log?.length ?? 0), logHtml(d), false));
  return `<aside class="margin" aria-label="Angaben">${out.join('')}</aside>`;
}

function docDetail(d) {
  const mode = d.status === 'draft' ? (S.ui.preview ? 'preview' : 'edit') : 'view';
  const reminder = S.ui.reminder === d.id ? { level: (d.reminders?.length ?? 0) + 1, fee: S.settings.fees[d.reminders?.length ?? 0], interest: interestFor(d) } : null;
  return `<div class="detail-in" data-for="${d.id}">${head(d)}${chainHtml(d)}${figuresHtml(d)}${statusHtml(d)}${actions(d)}<div class="body"><div class="desk">${sheet(d, mode, { reminder })}</div>${margin(d)}</div></div>`;
}

function customerDetail(c) {
  const docs = D().docs.filter((d) => d.cu === c.id && d.status === 'issued');
  const lbl = (d) => (pre(d) || d.kind === 'credit-note' ? kindOf(d) : STATE_LABEL[stateOf(d)] ?? '');
  const o = docs.reduce((s, d) => s + openOf(d), 0);
  const rows = docs.map((d) => `<div class="row inv st-${stateOf(d)}" data-href="${hrefOf(d)}"><span class="d mono">${d.number}</span><span class="t">${esc(d.subject ?? '')} <small>${lbl(d)}</small></span><span class="a mono">${d.kind === 'delivery-note' ? '' : fmt(gross(d))}</span></div>`).join('');
  return `<div class="detail-in"><div class="head"><h2 class="who">${esc(c.name)}<small>${esc(c.town)}</small></h2><div class="amount"><small>${c.currency ?? 'CHF'}</small>${fmt(o)}</div></div>
    <div class="facts"><span class="nw">Nr. ${c.no}</span><span>${c.lang.toUpperCase()}</span><span>${c.terms} Tage</span></div>
    <div class="ivacts"><button type="button" class="btn primary" data-act="new-for" data-id="${c.id}">Neue Rechnung</button><button type="button" class="btn ghost nw" data-act="newquote-for" data-id="${c.id}">Neue Offerte</button><button type="button" class="btn ghost" data-act="noop">Bearbeiten</button></div>
    <div class="body"><div class="desk"><div class="rows">${rows || '<p class="m">Noch keine Dokumente.</p>'}</div></div><aside class="margin">${sec('cust', 'Kunde', '', custKv(c))}${sec('defaults', 'Vorgaben', '', kv([['Kundennummer', c.no, true], ['Währung', c.currency ?? 'CHF', true], ['Ertragskonto', c.id === 'c2' ? '3300 Ertrag Grosshandel' : 'wie Firma', true], ['Rabatt', c.discount ? `${c.discount} %` : 'keiner', true], ['Kontakte', esc((c.contacts ?? [c.email]).join(' · ')), true]]) + `<label class="nw" style="display:flex;gap:8px;align-items:center;margin-top:8px;font-size:12.5px"><input type="checkbox" data-act="no-remind" data-id="${c.id}"${c.noReminders ? ' checked' : ''}> nie mahnen (Mahnlauf lässt den Kunden aus)</label>`, true, true)}</aside></div></div>`;
}

// An article's price is a dated history: «ab», a planned entry, «Verlauf»; «Ändern» asks «gilt ab» (docs/specs/invoicing.md 4.12).
const priceHist = (a) => a.prices ?? [{ from: '2026-01-01', price: a.price, src: 'Artikelliste' }];
const priceOn = (a, day) => priceHist(a).filter((e) => e.from <= day).at(-1)?.price;
const dayBefore = (iso) => { const t = new Date(`${iso}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
const artPrefix = (a) => a.text.split(',')[0];
// Only lines that took the article's price then; a customer's own price (from a quote) is not the article's.
const issuedWith = (a, from, price) => D().docs.filter((d) => d.kind === 'invoice' && d.status === 'issued' && d.date >= from).flatMap((d) => d.lines.filter((l) => l.text.startsWith(artPrefix(a)) && l.p !== price && l.p === priceOn(a, d.date)).map((l) => ({ d, l })));
function priceSec(a) {
  const h = priceHist(a), now = h.filter((e) => e.from <= TODAY).at(-1), planned = h.filter((e) => e.from > TODAY), earlier = h.filter((e) => e.from <= TODAY && e !== now).reverse();
  const until = (e) => { const n = h[h.indexOf(e) + 1]; return n ? ` bis ${dmy(dayBefore(n.from))}` : ''; };
  const ui = S.ui.ap?.id === a.id ? S.ui.ap : null;
  const form = ui ? `<div class="lkf nw" style="margin-top:10px"><div class="lkr"><span>Neuer Preis</span><span class="inl"><input class="mono" style="width:110px" id="ap-price" value="${ui.price ?? fmt(now.price + 1)}"></span></div><div class="lkr"><span>gilt ab</span><span class="inl"><input class="mono" style="width:110px" id="ap-from" value="${ui.from ?? dmy(TODAY)}"></span></div>${ui.warn ? `<div class="lkr"><span></span><div class="warnbox" role="alert"><b>${ui.warn.hits.length} ${ui.warn.hits.length === 1 ? 'Rechnung' : 'Rechnungen'} seit ${dmy(ui.warn.from)} mit dem alten Preis ausgestellt; ab ${dmy(ui.warn.from)} gilt jetzt ${fmt(ui.warn.price)}.</b><span>${ui.warn.hits.map(({ d, l }) => `${d.number} vom ${dmy(d.date)}: ${l.q} × ${fmt(l.p)}`).join(' · ')}</span><span>Regel: eine ausgestellte Rechnung bleibt, wie sie ausgestellt ist (OR Art. 958f); neue Zeilen nehmen den neuen Preis.</span><span>Was folgt: die Rechnungen bleiben; die Differenz von CHF ${fmt(ui.warn.diff)} verrechnest du nur, wenn du willst.</span><span class="acts"><button type="button" class="btn ghost" data-act="ap-back">Zurück</button><button type="button" class="btn ghost" data-act="ap-leave">So lassen</button><button type="button" class="btn primary" data-act="ap-draft">${ui.warn.diff > 0 ? 'Nachbelastung' : 'Gutschrift'} als Entwurf</button></span></div></div>` : `<div class="lkr"><span></span><span class="acts"><button type="button" class="btn ghost" data-act="ap-cancel">Abbrechen</button><button type="button" class="btn primary" data-act="ap-save">Behalten</button></span></div>`}</div>` : '';
  return `<p><span class="mono">CHF ${fmt(now.price)}</span> <span class="m">ab ${dmy(now.from)}</span>${ui ? '' : ' <button type="button" class="btn ghost" data-act="ap-change" data-id="' + a.id + '">Ändern</button>'}</p>`
    + planned.map((e) => `<p class="m">ab ${dmy(e.from)}: CHF ${fmt(e.price)}, geplant</p>`).join('')
    + (earlier.length ? `<p class="m">Verlauf: ${earlier.map((e) => `${fmt(e.price)} vom ${dmy(e.from)}${until(e)} · ${esc(e.src)}`).join('; ')}</p>` : '')
    + (S.ui.apNote?.id === a.id ? `<p class="m">${esc(S.ui.apNote.text)}</p>` : '') + form;
}

function articleDetail(a) {
  const used = D().docs.filter((d) => d.lines.some((l) => l.text.startsWith(a.text.split(',')[0])));
  const now = priceHist(a).filter((e) => e.from <= TODAY).at(-1);
  return `<div class="detail-in"><div class="head"><h2 class="who">${esc(a.text)}<small>${esc(a.no)}</small></h2><div class="amount"><small>CHF</small>${fmt(now.price)}</div></div>
    <div class="facts"><span>pro ${UNITS[a.unit]}</span><span class="nw">ab ${dmy(now.from)}</span>${F().vat ? `<span>MWST ${a.rate} %</span>` : ''}<span>Konto ${a.rate === 8.1 ? '3600' : F().revenue[0][0]}</span></div>
    <div class="ivacts"><button type="button" class="btn ghost" data-act="noop">Bearbeiten</button></div>
    <div class="body"><div class="desk"><div class="rows">${used.map((d) => `<div class="row inv st-${stateOf(d)}" data-href="${hrefOf(d)}"><span class="d mono">${d.number ?? 'Entwurf'}</span><span class="t">${esc(cust(d.cu).name)} <small>${esc(d.subject ?? '')}</small></span><span class="a mono">${fmt(gross(d))}</span></div>`).join('') || '<p class="m">Noch auf keiner Rechnung.</p>'}</div></div>
    <aside class="margin">${sec('price', 'Preis', `ab ${dmy(now.from)}`, priceSec(a), true, true)}${sec('art', 'Artikel', '', kv([['Nummer', a.no, true], ['Text', esc(a.text), true], ['Einheit', UNITS[a.unit], true], ['Preis', `CHF ${fmt(now.price)}${F().vat ? ' exkl. MWST' : ''}`, true], ...(F().vat ? [['MWST-Satz', `${a.rate} %`, true]] : [])]) + '<p class="m ivhint nw">Preis und Satz, kein Lagerbestand. Eine Rechnung nimmt den Preis, der an ihrem Datum gilt, und behält ihn; eine spätere Preisänderung gilt für neue Zeilen.</p>', true, true)}</aside></div></div>`;
}

function recurringDetail(t) {
  const c = cust(t.cu);
  const nextDoc = { id: 'tpl', kind: 'invoice', status: 'issued', cu: t.cu, subject: t.name, date: t.next, due: addDays(t.next, c.terms), cur: 'CHF', lang: c.lang, lines: t.lines, skonto: t.skonto ? { percent: 2, days: 10 } : null };
  const made = t.made.map((id) => doc(id)).filter(Boolean);
  const sheetHtml = sheet({ ...nextDoc, number: 'Vorlage' }, 'view').replace('<div class="qrb">', '<div class="qrb">');
  return `<div class="detail-in"><div class="head"><h2 class="who">${esc(c.name)}<small>${esc(t.name)}</small></h2><div class="amount"><small>CHF</small>${fmt(totals(t.lines).gross)}</div></div>
    <div class="facts"><span class="nw">${EVERY[t.every]}</span><span class="nw">nächste am ${dmy(t.next)}</span><span class="nw">am Stichtag: ${MODE[t.mode]}</span></div>
    <div class="status"><span class="notice nw">Der Code legt sie am ${dmy(t.next)} an, beim nächsten Start der App oder nächsten Lauf danach. Nur das Gerät, das die Bücher hält, stellt aus; ein anderes legt nur den Entwurf an.</span></div>
    <div class="ivacts"><button type="button" class="btn primary nw" data-act="rec-now" data-id="${t.id}">Nächste jetzt als Entwurf anlegen</button><button type="button" class="btn ghost nw" data-act="noop">Pausieren</button><button type="button" class="btn ghost" data-act="noop">Bearbeiten</button></div>
    <div class="body"><div class="desk">${sheetHtml}</div><aside class="margin">${sec('rec', 'Vorlage', EVERY[t.every], `<div class="lkf"><div class="lkr"><span>Rhythmus</span>${seg2('Rhythmus', [['month', 'Monat'], ['quarter', 'Quartal'], ['year', 'Jahr']], t.every, 'rec-every')}</div><div class="lkr"><span>Am Stichtag</span>${seg2('Am Stichtag', [['draft', 'Entwurf'], ['issue', 'Ausstellen'], ['send', 'Ausstellen + senden']], t.mode, 'rec-mode')}</div></div><p class="m ivhint">Ein Fehler (E-Mail abgelehnt, eine Angabe fehlt) wird eine Aufgabe mit Worten; nichts geht still verloren.</p>`, true, true)}
      ${sec('made', 'Erstellt', String(made.length), made.map((d) => `<button type="button" class="sdoc" data-href="#/invoices/${rid(d)}"><span class="mono">${dmy(d.date)}</span><span>${d.number ? `Rechnung ${d.number}` : 'Entwurf'}<small>${esc(STATE_LABEL[stateOf(d)] ?? '')}</small></span><span class="m">öffnen</span></button>`).join('') || '<p class="m">Noch keine.</p>', true, true)}
      ${t.from ? sec('from', 'Herkunft', 'Offerte', `<p class="m"><a class="golink" href="#/invoices/quotes/${doc(t.from).number}">Offerte ${doc(t.from).number}</a>, angenommen</p>`, true, true) : ''}${sec('customer', 'Kunde', c.town.replace(/^\d+ /, ''), custKv(c), false)}</aside></div></div>`;
}

function openItemsDetail(r) {
  const items = openItems().filter((d) => !r.id || d.cu === r.id).sort((a, b) => cust(a.cu).name.localeCompare(cust(b.cu).name) || a.due.localeCompare(b.due));
  const byCu = {};
  for (const d of items) (byCu[d.cu] ??= []).push(d);
  let rows = '';
  const BL = Object.fromEntries(BANDS);
  for (const [cu, ds] of Object.entries(byCu)) {
    rows += `<tr class="cu"><td colspan="5">${esc(cust(cu).name)}${cust(cu).noReminders ? ' · nie mahnen' : ''}</td><td class="r">${ds[0].cur} ${fmt(ds.reduce((s, d) => s + openOf(d), 0))}</td></tr>`;
    for (const d of ds) { const over = days(d.due, TODAY); rows += `<tr><td><a href="#/invoices/${d.number}">${d.number}</a></td><td>${dmy(d.date)}</td><td>${dmy(d.due)}</td><td class="${over > 0 ? 'warn' : ''}">${over > 0 ? `${over} Tage` : 'nicht fällig'}</td><td>${BL[band(d)]}${d.reminders?.length ? ` · ${d.reminders.length}. Mahnung` : ''}</td><td class="r">${d.cur} ${fmt(openOf(d))}${paid(d) ? ` <small>von ${fmt(gross(d))}</small>` : ''}</td></tr>`; }
  }
  const chf = items.filter((d) => d.cur === 'CHF').reduce((s, d) => s + openOf(d), 0), eur = items.filter((d) => d.cur === 'EUR').reduce((s, d) => s + openOf(d), 0);
  rows += `<tr class="tot"><td colspan="5">Total</td><td class="r">CHF ${fmt(chf)}${eur ? `<br>EUR ${fmt(eur)}` : ''}</td></tr>`;
  const who = r.id ? cust(r.id).name : 'Debitorenliste';
  return `<div class="detail-in"><div class="head"><h2 class="who">${esc(who)}<small>Offene Posten per 14.11.2026, nach Alter ab Fälligkeit</small></h2><div class="amount"><small>CHF</small>${fmt(chf)}</div></div>
    <div class="facts"><span>${items.length} Rechnungen</span><span>Stichtag 14.11.2026</span><span>am 31.12. gleich dem Vorschlag Debitoren des Jahresabschlusses</span></div>
    <div class="ivacts"><button type="button" class="btn ghost nw" data-act="oi-print">${I.print} Drucken</button><button type="button" class="btn ghost nw" data-act="oi-csv">${I.dl} CSV</button></div>
    <div class="body nw" style="display:block"><table class="oitable"><thead><tr><th>Nr.</th><th>Datum</th><th>Fällig</th><th>Über fällig</th><th>Alter</th><th class="r">Offen</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function sentDetail(s) {
  if (!s) return empty('Kein Dokument gewählt.');
  const d = s.d;
  return `<div class="detail-in"><div class="head"><h2 class="who">${esc(s.title)}<small>${esc(cust(d.cu).name)}</small></h2><div class="amount"><small>${d.cur}</small>${fmt(gross(d))}</div></div>
    <div class="facts"><span>${dmy(s.date)} ${s.time}</span><span>an ${esc(s.to)}</span><span>${s.by ? 'von der Vorlage gesendet' : 'per E-Mail'}</span></div>
    <div class="ivacts"><a class="btn ghost" href="${hrefOf(d)}">Zum Dokument</a><button type="button" class="dl inline" data-act="pdf">${I.dl}<span>PDF, wie gesendet</span></button></div>
    <div class="body"><div class="desk">${sheet(d, 'view', s.reminder ? { reminder: s.reminder } : {})}</div><aside class="margin">${sec('sentm', 'Gesendet', '', kv([['An', esc(s.to)], ['Zeit', `${dmy(s.date)} ${s.time}`], ['Prüfsumme', `SHA-256 ${(d.id + s.date).split('').map((ch) => ch.charCodeAt(0).toString(16)).join('').slice(0, 16)}…`]]))}</aside></div></div>`;
}

// ---------------------------------------------------------------- Firma › Rechnungslayout (new rows)
function companyPage() {
  const s = S.settings;
  const list = (window.COMPANY_LIST || '').replace('Muster Kaffee GmbH</h1>', `${esc(F().name)}</h1>`).replace('<span>Anna Muster</span>', `<span>${esc(F().owner)}</span>`);
  const form = (window.LAYOUT_FORM || '').replace(/src="" data-logo="1"/g, `src="${window.LOGO}"`);
  const lv = [1, 2, 3].map((k) => `<span>${k}. Mahnung</span><span class="inl">nach <input class="mono" value="${s.afterDays[k - 1]}"> Tagen</span><span class="inl">Gebühr CHF <input class="mono" value="${fmt(s.fees[k - 1])}"></span>`).join('');
  const added = `
    <div class="lkhead nw">Neu (Spec Rechnungen)</div>
    <div class="lkf nw"><div class="lkr"><span>Nummern</span><span class="inl">Rechnungen <input class="mono wide" value="YYYY-NNN"> Offerten <input class="mono wide" value="OF-YYYY-NNN"></span></div><div class="lkr"><span>Offerten gültig</span><span class="inl"><input class="mono" value="30"> Tage</span></div></div>
    <div class="lkf nw"><div class="lkr"><span>Skonto</span><span class="inl"><input type="checkbox" data-act="set-skonto"${s.skonto ? ' checked' : ''}> <input class="mono" value="${s.skontoPct}"${s.skonto ? '' : ' disabled'}> % innert <input class="mono" value="${s.skontoDays}"${s.skonto ? '' : ' disabled'}> Tagen · steht in den Bedingungen, der Code bucht ihn bei der Zahlung aus</span></div>
      <div class="lkr"><span>Kleine Differenzen</span><span class="inl">bis CHF <input class="mono" value="${fmt(s.limit)}"> als Gebühr zum Ausbuchen vorschlagen; mehr fragt dich</span></div>
      <div class="lkr"><span>Ausbuchen auf</span><span class="inl">Skonto, Rabatt <input class="mono" value="3800"> Verlust <input class="mono" value="3805"> (nur vereinbart; vereinnahmt bucht nichts)</span></div></div>
    <div class="lkf nw"><div class="lkr top"><span>Mahnwesen</span><span class="lvls">${lv}</span></div>
      <div class="lkr"><span>Verzugszins</span><span class="inl"><input type="checkbox" data-act="set-interest"${s.interest ? ' checked' : ''}> auf Mahnungen verrechnen, <input class="mono" value="${s.rate}"${s.interest ? '' : ' disabled'}> % im Jahr ab Fälligkeit (OR Art. 104) · ${s.interest ? 'an' : 'aus, wie für jede neue Firma'}</span></div></div>
    <div class="lkf nw"><div class="lkr"><span>Quittung</span><span class="inl">Bar → <input class="mono" value="1000"> TWINT → <input class="mono" value="${F().bankAcc.CHF[0]}"> Karte → <input class="mono" value="${F().bankAcc.CHF[0]}"></span></div></div>
    ${S.firm === 'kaffee' ? `<div class="lkf nw"><div class="lkr"><span>QR-IBAN in EUR</span><span class="inl"><input class="mono wide" style="width:220px" value="${s.eurQr ? 'CH44 3199 9123 0008 8901 2' : ''}" placeholder="QR-IBAN für EUR" data-act="eur-qr"${s.eurQr === 'kept' ? ' readonly' : ''}></span></div>${s.eurQr === 'warned' ? `<div class="lkr"><span></span><div class="warnbox" role="alert"><b>Seit der QR-Rechnung v2.4 gilt die QR-IBAN nur für CHF.</b><span>Regel: SIX Implementation Guidelines QR-Rechnung v2.4 (24.02.2026), Kap. 2.8 und 4.3.2: in EUR nur IBAN mit SCOR-Referenz oder Mitteilung. Version 2.3 gilt noch bis November 2027.</span><span>Was folgt: neue EUR-Rechnungen tragen die QR-IBAN und eine QR-Referenz. Bis November 2027 nehmen Banken sie an, danach weisen sie sie zurück. Ausgestellte Rechnungen bleiben, wie sie sind.</span><span class="acts"><button type="button" class="btn ghost" data-act="eur-qr-drop">Nicht speichern</button><button type="button" class="btn primary" data-act="eur-qr-keep">Trotzdem speichern</button></span></div></div>` : s.eurQr === 'kept' ? '<div class="lkr"><span></span><span class="m">Gespeichert. Neue EUR-Rechnungen tragen die QR-IBAN mit QR-Referenz (v2.3, bis November 2027). <button type="button" class="quiet2" data-act="eur-qr-drop">Entfernen</button></span></div>' : '<div class="lkr"><span></span><span class="m">Gib eine QR-IBAN ein, um zu sehen, was die App antwortet.</span></div>'}</div>` : ''}`;
  const preview = S.firm === 'kaffee' ? sheet(doc('d2'), 'preview') : sheet(doc('sd1') ?? D().docs[0], 'preview');
  return `<section class="list" id="list" aria-label="Firma">${list.replace(/^<section[^>]*>/, '').replace(/<\/section>$/, '')}</section>
    <section class="detail" aria-live="polite"><div class="detail-in"><div class="head"><h2 class="who">Rechnungslayout<small>${esc(F().name)}</small></h2></div><div class="docbody"><div class="lkpage"><div>${form}${added}<p class="m src-note">Gilt für alle Entwürfe. Ausgestellte Rechnungen behalten die Gestaltung, mit der sie ausgestellt wurden.</p></div><div class="lkprevw">${preview.replace('class="ivsheet', 'class="ivsheet lkprev')}</div></div></div></div></section>`;
}

// ---------------------------------------------------------------- dialogs
const FOLLOW = { quote: ['order', 'delivery-note', 'invoice'], order: ['delivery-note', 'invoice'], 'delivery-note': ['invoice'], invoice: ['delivery-note', 'credit-note'] };
function frame(label, title, body, foot, cls = '') {
  return `<div class="scrim" style="background: color-mix(in srgb, var(--bg) 45%, transparent)" data-act="close"></div><div class="palette idlg ${cls}" role="dialog" aria-label="${esc(label)}"><div class="ihd"><span class="lbl">${esc(label)}</span><b>${title}</b></div>${body}${foot ? `<div class="ift">${foot}</div>` : ''}</div>`;
}
function dialogHtml() {
  const g = S.ui.dialog;
  if (!g) return '';
  const close = '<button type="button" class="btn ghost" data-act="close">Abbrechen</button>';
  if (g.kind === 'new' || g.kind === 'newquote') {
    const cs = [...D().customers].sort((a, b) => a.name.localeCompare(b.name));
    return frame(g.kind === 'new' ? 'Neue Rechnung' : 'Neue Offerte', 'Für wen?', `<input class="isearch" placeholder="Kunde suchen" aria-label="Kunde suchen"><div class="iopts" role="listbox">${cs.map((c, k) => `<button type="button" role="option" class="opt${k === 0 ? ' on' : ''}" data-act="${g.kind === 'new' ? 'new-for' : 'newquote-for'}" data-id="${c.id}"><span>${esc(c.name)}</span><span class="d">${esc(c.town.replace(/^\d+ /, ''))}${c.country !== 'CH' ? `, ${c.country}` : ''} · ${c.lang === 'fr' ? 'Französisch' : 'Deutsch'}${c.currency ? ` · ${c.currency}` : ''}</span></button>`).join('')}<button type="button" role="option" class="opt alt" data-act="noop"><span>＋ Neuer Kunde</span><span class="d">Name, Adresse, Sprache, MWST-Nr.</span></button></div>`, '');
  }
  if (g.kind === 'articles') {
    return frame('Aus Artikelliste', 'Positionen hinzufügen', `<div class="ibody"><div class="picks">${D().articles.map((a) => `<label><input type="checkbox" data-art="${a.id}"><span>${esc(a.text)} <span class="d">${a.no} · ${UNITS[a.unit]}${F().vat ? ` · ${a.rate} %` : ''}</span></span><span class="mono">${fmt(a.price)}</span><input class="q" value="1" data-qty="${a.id}" aria-label="Menge"></label>`).join('')}</div><p class="m ivhint">Satz und Preis kommen aus dem Artikel; auf der Rechnung lassen sie sich ändern.</p></div>`, `${close}<button type="button" class="btn primary" data-act="art-add">Hinzufügen</button>`);
  }
  if (g.kind === 'hours') {
    const sample = 'Datum\tText\tStunden\tAnsatz\n03.11.2026\tBarista-Schulung Team Thun\t3.5\t120\n05.11.2026\tEinstellung Mühlen\t2\t120\n10.11.2026\tBarista-Schulung Team Thun\t4\t120';
    return frame('Stunden übernehmen', 'Tabelle einfügen oder CSV wählen', `<div class="ibody"><label class="lkr top"><span>Tabelle</span><textarea rows="6" data-hours>${esc(sample)}</textarea></label><div class="lkr"><span>Zeilen</span>${seg2('Gruppieren', [['text', 'nach Text gruppiert'], ['row', 'eine pro Zeile']], g.group ?? 'text', 'hours-group')}</div><p class="m ivhint">Spalten: Datum, Text, Stunden, Ansatz (wie der Export eines Trackers, den eine Quelle im Workspace liest). 8.1 % MWST, ändern auf der Rechnung.</p></div>`, `${close}<button type="button" class="btn primary" data-act="hours-add">Übernehmen</button>`);
  }
  if (g.kind === 'expenses') {
    const d = doc(g.docId);
    const rs = D().receipts.filter((b) => !b.billed);
    return frame('Spesen weiterverrechnen', `für ${esc(cust(d.cu).name)}`, `<div class="ibody"><div class="picks">${rs.map((b) => `<label><input type="checkbox" data-rcpt="${b.id}"${b.cu === d.cu ? ' checked' : ''}><span>${esc(b.text)} <span class="d">${dmy(b.date)} · Beleg${b.cu === d.cu ? ' · mit dem Kunden markiert' : ''}</span></span><span class="mono">${fmt(b.net)}</span><span class="d">netto</span></label>`).join('') || '<p class="m">Keine Belege mehr offen.</p>'}</div><p class="m ivhint">Jeder Beleg wird eine Zeile zum Nettobetrag, zum Satz der Leistung (MWSTG Art. 24 Abs. 1), und wird nie zweimal angeboten.</p></div>`, `${close}<button type="button" class="btn primary" data-act="exp-add">Übernehmen</button>`);
  }
  if (g.kind === 'writeoff') {
    const d = doc(g.docId), o = openOf(d), reason = g.reason ?? (paid(d) ? 'discount' : 'loss');
    const agreed = S.basis === 'agreed' && F().vat;
    const t = totals(d.lines), split = t.byRate.map((b) => ({ rate: b.rate, amount: r2(o * b.gross / t.gross) }));
    const acc = reason === 'loss' ? '3805 Verluste aus Forderungen' : '3800 Erlösminderungen';
    const how = !F().vat ? 'Nicht MWST-pflichtig: keine Buchung; die Ausbuchung steht auf der Rechnung.' : agreed
      ? `<b>Vereinbart:</b> der Ertrag ist seit ${dmy(d.date)} gebucht und versteuert. Darum bucht die App am ${dmy(TODAY)}:${split.map((s) => `<span class="mono">RE-${d.number}-wo-${(d.writeOffs?.length ?? 0) + 1} · ${acc} / 1100 Debitoren · ${d.cur} ${fmt(s.amount)} · −${rateCode(s.rate, d)}</span>`).join('')}Die Steuer sinkt um ${d.cur} ${fmt(split.reduce((x, s) => x + r2(s.amount - s.amount / (1 + s.rate / 100)), 0))} in der offenen Abrechnung Q4 2026, Ziffer 235 (MWSTG Art. 41).${reason === 'loss' ? ' Zahlt der Kunde später doch, bucht die Zahlung den Ertrag wieder mit Steuer.' : ''}`
      : `<b>Vereinnahmt:</b> keine Buchung. Was nie einging, war nie versteuert. Die Ausbuchung steht mit Datum, Grund und dir auf der Rechnung und in den Offenen Posten.`;
    return frame('Rest ausbuchen', `${d.number} · ${esc(cust(d.cu).name)}`, `<div class="ibody wob"><div class="lkr"><span>Betrag</span><span class="iin"><input class="mono" value="${fmt(o)}" style="width:96px"> ${d.cur} von ${fmt(o)} offen</span></div><div class="lkr"><span>Datum</span><input type="text" class="mono" value="${dmy(TODAY)}" style="width:110px"></div><div class="lkr"><span>Grund</span>${seg2('Grund', Object.entries(WO), reason, 'wo-reason')}</div><div class="lkr"><span>Notiz</span><input placeholder="${reason === 'loss' ? 'z.B. Konkurs eröffnet am …' : 'z.B. Kunde zog ab, telefonisch vereinbart'}"></div><div class="howbook">${how}</div></div>`, `${close}<button type="button" class="btn primary" data-act="wo-do" data-v="${reason}">Ausbuchen</button>`);
  }
  if (g.kind === 'follow') {
    const src = doc(g.docId), targets = FOLLOW[src.kind], target = g.target ?? targets[0];
    const opts = src.lines.map((l, k) => [l, k]).filter(([l]) => l.optional);
    const n = src.lines.filter((l) => isItem(l) && !l.optional).length;
    const st = stateOf(src), late = src.kind === 'quote' && (st === 'expired' || st === 'declined');
    const picks = opts.length && target !== 'credit-note' ? `<div class="lkhead">Welche Optionen kommen mit?</div><div class="picks">${opts.map(([l, k]) => `<label><input type="checkbox" data-optk="${k}"${(g.picks ?? []).includes(k) ? ' checked' : ''}><span>${esc(l.text)} <span class="d">${qty(l.q)} ${UNITS[l.unit] ?? ''}${F().vat ? ` · ${l.rate} %` : ''}</span></span><span class="mono">${fmt(lineAmount(l))}</span><span></span></label>`).join('')}</div><p class="m ivhint">Gewählte Optionen werden gewöhnliche Positionen und zählen ins Total; die anderen bleiben auf der Offerte und kommen nicht mit.</p>` : '';
    const warn = late ? `<div class="warnbox" role="alert"><b>${st === 'expired' ? `Die Offerte ist am ${dmy(src.validUntil)} abgelaufen.` : 'Der Kunde hat die Offerte abgelehnt.'}</b><span>Regel: ${st === 'expired' ? `sie galt bis ${dmy(src.validUntil)} (Firma › Rechnungslayout: Offerten gültig 30 Tage); danach bindet sie dich nicht mehr` : `abgelehnt am ${dmy(src.log.find((x) => /abgelehnt/.test(x[1]))?.[0] ?? TODAY)}, im Verlauf festgehalten`}.</span><span>Was folgt: die Preise und Sätze von damals gehen ins Folgedokument, die Offerte gilt danach als angenommen. Prüfe die Preise im Entwurf.</span></div>` : '';
    const what = { order: 'Bestätigt den Auftrag, mit Preisen; bucht nichts.', 'delivery-note': 'Positionen und Mengen ohne Preise, für die Ware; bucht nichts.', invoice: 'Die Rechnung, in der Rechnungsreihe nummeriert; bucht wie jede Rechnung.', 'credit-note': 'Alle Positionen mit Minus; streiche, was nicht gutgeschrieben wird.' }[target];
    return frame('Folgedokument erstellen', `aus ${esc(KIND[src.kind])} ${esc(src.number)}`, `<div class="ibody wob"><div class="lkr"><span>Folgt als</span>${seg2('Folgedokument', targets.map((k) => [k, KIND[k]]), target, 'follow-target')}</div><p class="m ivhint">${esc(what)} Alle ${n} Positionen werden mit Text, Menge, Einheit, Preis und Satz übernommen, als Entwurf im selben Editor.</p>${picks}${warn}</div>`, `${close}<button type="button" class="btn primary" data-act="follow-do">${late ? 'Trotzdem erstellen' : `${KIND[target]} erstellen`}</button>`);
  }
  if (g.kind === 'warn') {
    return frame(g.label, esc(g.title), `<div class="ibody"><div class="warnbox" role="alert"><b>${esc(g.what)}</b><span>Regel: ${esc(g.rule)}</span><span>Was folgt: ${esc(g.follows)}</span></div><p class="m ivhint">Du entscheidest. Was du tust, steht im Verlauf wie jede andere Handlung.</p></div>`, `${close}${g.alt ? `<button type="button" class="btn ghost" data-act="${g.alt.act}">${esc(g.alt.label)}</button>` : ''}<button type="button" class="btn primary" data-act="${g.go}">${esc(g.goLabel)}</button>`);
  }
  if (g.kind === 'send') {
    const d = doc(g.docId), c = cust(d.cu), Lx = T[d.lang] ?? T.de;
    const what = g.reminder ? `${g.reminder.level}. Mahnung zu ${d.number}` : docTitle(d);
    const issuedNote = g.issued ? '<p class="m ivhint">Das PDF ist fertig und abgelegt. Speichern und selbst verschicken, oder per E-Mail senden.</p>' : '';
    const pdf = `<div class="isendpdf paper real" style="max-height:340px;overflow:auto">${sheet(d, 'view', g.reminder ? { reminder: g.reminder } : {})}</div>`;
    return frame(g.reminder ? 'Mahnung senden' : g.issued ? (d.kind === 'quote' ? 'Offerte gesendet?' : pre(d) ? `${KIND[d.kind]} ausgestellt` : 'Ausgestellt') : 'Senden', `${esc(c.name)} · ${d.cur} ${fmt(gross(d))}`,
      `<div class="ibody lkf">${pdf}${issuedNote}<label class="lkr"><span>An</span><input name="to" type="email" value="${esc(c.email)}"></label><label class="lkr"><span>Betreff</span><input name="subject" value="${esc(what)} · ${esc(F().name)}"></label><label class="lkr top"><span>Text</span><textarea rows="5">Guten Tag\n\nIm Anhang finden Sie ${esc(what)}.\n\nFreundliche Grüsse\n${esc(F().name)}</textarea></label><p class="m ivhint">Angehängt: ${esc(what.replace(/ /g, '-'))}.pdf, Byte für Byte so abgelegt.</p></div>`,
      `<button type="button" class="btn ghost" data-act="close">${g.issued ? 'Später' : 'Abbrechen'}</button><button type="button" class="btn ghost" data-act="send-do" data-v="download">Herunterladen</button><button type="button" class="btn primary" data-act="send-do" data-v="mail">Per E-Mail senden</button>`, 'isend withpdf');
  }
  return '';
}

// ---------------------------------------------------------------- render
let lastKey = '';
function render() {
  const r = route();
  const main = $('#main');
  document.documentElement.classList.toggle('mark-new', S.mark);
  $$('.activity .it').forEach((a) => a.classList.toggle('on', a.dataset.nav === (r.area === 'company' ? 'company' : 'invoices')));
  $('.topbar .chip b').textContent = F().name;
  $('.demobar span').textContent = `Demo: ${F().name} ist eine erfundene Firma. Nichts hier ist echt. Prototyp der Spec «Rechnungen», ${S.basis === 'agreed' && F().vat ? 'vereinbartes Entgelt' : F().vat ? 'vereinnahmtes Entgelt' : 'nicht MWST-pflichtig'}.`;
  let list = '', detail = '';
  if (r.area === 'company') {
    main.dataset.area = 'company';
    main.innerHTML = companyPage() + '<div class="split" role="separator" style="left: 579px;"></div>';
  } else {
    main.dataset.area = 'invoices';
    if (r.view === 'list') {
      if (r.id === 'new') { S.ui.dialog = { kind: 'new' }; history.replaceState(null, '', '#/invoices'); return render(); }
      const d = r.id ? byRoute(r.id) : null;
      if (!r.id) { const first = $$('.row', document.createRange().createContextualFragment(invoiceList(r)))[0]; if (first) { history.replaceState(null, '', first.dataset.href); return render(); } }
      list = invoiceList(r);
      detail = d && !pre(d) ? docDetail(d) : empty(r.id ? `Kein Dokument ${r.id}.` : 'Keine Rechnung gewählt.');
    } else if (r.view === 'quotes') {
      const d = r.id ? byRoute(r.id) : D().docs.find((x) => x.kind === 'quote' && x.qstatus === 'sent') ?? D().docs.find((x) => x.kind === 'quote');
      if (!r.id && d) { history.replaceState(null, '', `#/invoices/quotes/${rid(d)}`); return render(); }
      list = quoteList(r); detail = d ? docDetail(d) : empty('Noch keine Offerten. «Neue Offerte» schreibt die erste, mit eigener Nummer OF-2026-001.');
    } else if (r.view === 'customers') {
      const c = r.id ? cust(r.id) : null;
      if (!r.id) { history.replaceState(null, '', `#/invoices/customers/${[...D().customers].sort((a, b) => a.name.localeCompare(b.name))[0].id}`); return render(); }
      list = customerList(r); detail = c ? customerDetail(c) : empty('Kein Kunde gewählt.');
    } else if (r.view === 'articles') {
      if (!r.id && D().articles.length) { history.replaceState(null, '', `#/invoices/articles/${D().articles[0].id}`); return render(); }
      const a = D().articles.find((x) => x.id === r.id);
      list = articleList(r); detail = a ? articleDetail(a) : empty('Kein Artikel gewählt.');
    } else if (r.view === 'recurring') {
      if (!r.id && D().recurring.length) { history.replaceState(null, '', `#/invoices/recurring/${D().recurring[0].id}`); return render(); }
      const t = D().recurring.find((x) => x.id === r.id);
      list = recurringList(r); detail = t ? recurringDetail(t) : empty('Keine Vorlage gewählt.');
    } else if (r.view === 'open-items') {
      list = openItemsList(r); detail = openItemsDetail(r);
    } else if (r.view === 'sent') {
      const s = sentList(r);
      if (!r.id && s.all.length) { history.replaceState(null, '', `#/invoices/sent/${s.all[0].id}`); return render(); }
      list = s.html; detail = sentDetail(s.all.find((x) => x.id === r.id));
    }
    main.innerHTML = `<section class="list" id="list" aria-label="Rechnungen">${list}</section><section class="detail" aria-live="polite">${detail}</section><div class="split" role="separator" aria-orientation="vertical" style="left: 579px;"></div>`;
  }
  $('#dlg').innerHTML = dialogHtml();
  fit();
  const key = location.hash;
  if (key !== lastKey) { lastKey = key; parent.postMessage({ route: location.hash, firm: S.firm, basis: S.basis }, '*'); }
}
function fit() {
  for (const a of $$('.ivsheet > .a4')) {
    const box = a.parentElement.getBoundingClientRect().width;
    if (box) a.style.zoom = String(Math.min(1, box / 794));
  }
}

// ---------------------------------------------------------------- actions
const toastEl = () => $('.toast');
let toastTimer;
function keepPrice(a, from, price, note) {
  a.prices = [...priceHist(a), { from, price, src: `eingegeben am ${dmy(TODAY)}` }].sort((x, y) => x.from.localeCompare(y.from));
  a.price = priceOn(a, TODAY);
  S.ui.ap = null; S.ui.apNote = { id: a.id, text: note };
  render();
}
function toast(msg) { const t = toastEl(); t.innerHTML = `<span>${esc(msg)}</span>`; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200); }
const current = () => { const r = route(); return r.view === 'list' || r.view === 'quotes' ? byRoute(r.id) : null; };

function newDraft(cid, kind = 'invoice') {
  const c = cust(cid), id = `n${Date.now().toString(36)}`;
  const d = { id, kind, status: 'draft', cu: cid, subject: kind === 'quote' ? 'Offerte' : 'Neue Rechnung', date: TODAY, cur: c.currency ?? 'CHF', lang: c.lang, lines: [L('', 1, 'pcs', 0, F().vat ? (c.country === 'CH' ? 8.1 : 0) : 0)], log: [[TODAY, 'erstellt']] };
  if (kind === 'quote') d.validUntil = addDays(TODAY, 30);
  if (c.country !== 'CH') d.exemption = 'export';
  const credit = D().docs.find((x) => x.kind === 'credit-note' && x.cu === cid && x.settlement === 'offset' && !x.offsetIn && !D().docs.some((y) => y.status === 'draft' && y.lines.some((l) => l.deducts === x.id)));
  if (credit && kind === 'invoice') { d.lines.push(L(`Gutschrift ${credit.number} vom ${dmy(credit.date)}, verrechnet`, 1, '', gross(credit), 2.6, { incl: true, kind: 'ded', deducts: credit.id })); d.log.push([TODAY, `Gutschrift ${credit.number} als Abzug übernommen`]); }
  D().docs.push(d);
  S.ui.dialog = null; S.ui.preview = false;
  go(hrefOf(d));
}

function issue(d, force = false) {
  const dn = d.kind === 'delivery-note';
  const bad = d.lines.filter(isItem).filter((l) => !l.text.trim() || (!dn && !(l.p || l.kind === 'ded')));
  if (bad.length && !force) {
    const tax = d.kind === 'invoice' || d.kind === 'credit-note';
    S.ui.dialog = { kind: 'warn', docId: d.id, label: `${kindOf(d)} ausstellen`, title: `${bad.length === 1 ? 'Eine Position' : `${bad.length} Positionen`} ohne Text oder Preis`,
      what: `${bad.length === 1 ? 'Eine Position hat' : `${bad.length} Positionen haben`} keinen Text${dn ? '' : ' oder keinen Preis'}.`,
      rule: tax ? 'MWSTG Art. 26 Abs. 2 lit. d und e: Art, Gegenstand und Umfang der Leistung und das Entgelt stehen auf der Rechnung.' : `für ${KIND[d.kind] === 'Lieferschein' ? 'einen Lieferschein' : 'eine Auftragsbestätigung'} keine Vorschrift; der Kunde liest die Zeile so.`,
      follows: `die Zeile steht so auf dem PDF${dn ? '' : ', mit 0.00'}. Ausgestellt ist ausgestellt: ändern geht danach nur mit ${tax ? 'einer Gutschrift oder einem Storno' : 'einem neuen Dokument'}.`, go: 'issue-force', goLabel: 'Trotzdem ausstellen' };
    render(); return;
  }
  const c = cust(d.cu);
  d.number = nextNumber(d.kind); d.status = 'issued';
  if (d.cur === 'EUR' && eurQrKept()) d.qrIbanEur = true;
  if (d.kind === 'invoice' && !d.paidAtIssue) { d.due = addDays(d.date, c.terms); d.ref = d.cur === 'EUR' && !d.qrIbanEur ? `RF${String(10 + Number(d.number.slice(-3)) % 89)} 2026 ${d.number.slice(-3)}` : `00 00000 00000 00000 00202 6${d.number.slice(-3)}${(Number(d.number.slice(-3)) * 7) % 10}`; }
  if (d.kind === 'invoice' && S.firm === 'kaffee' && S.settings.skonto && d.cur === 'CHF' && !d.paidAtIssue) d.skonto = { percent: S.settings.skontoPct, days: S.settings.skontoDays };
  d.log.push([TODAY, `${d.paidAtIssue ? 'als Quittung ' : ''}ausgestellt, Nr. ${d.number}`]);
  if (d.paidAtIssue) { d.payments = [{ date: d.date, amount: gross(d), by: `bei Ausstellung, ${T.de.means[d.paidAtIssue]}` }]; d.log.push([TODAY, `bezahlt ${T.de.means[d.paidAtIssue]}`]); }
  for (const l of d.lines.filter((x) => x.deducts)) { const cn = doc(l.deducts); cn.offsetIn = d.id; cn.log.push([TODAY, `verrechnet mit Rechnung ${d.number}`]); }
  if (d.from) { const q = doc(d.from.id); q.log.push([TODAY, `Folgedokument ausgestellt: ${KIND[d.kind]} ${d.number}`]); }
  S.ui.preview = false;
  S.ui.dialog = { kind: 'send', docId: d.id, issued: true };
  toast(`${kindOf(d)} ${d.number} ausgestellt`);
  go(hrefOf(d));
}

// «Folgedokument erstellen»: the next document of the chain, every line copied; picked options become ordinary lines.
function follow(src, kind, picks = []) {
  const lines = src.lines.filter((l, k) => (!l.optional || picks.includes(k)) && !(kind === 'delivery-note' && l.kind === 'ded')).map((l) => { const x = clone(l); delete x.optional; if (kind === 'credit-note' && isItem(x)) x.p = -x.p; return x; });
  const nd = { id: `n${Date.now().toString(36)}`, kind, status: 'draft', cu: src.cu, subject: src.subject, date: TODAY, cur: src.cur, lang: src.lang, exemption: src.exemption, lines, from: { kind: src.kind, id: src.id }, log: [[TODAY, `Folgedokument von ${KIND[src.kind]} ${src.number}${picks.length ? `, mit ${picks.length === 1 ? 'einer Option' : `${picks.length} Optionen`}` : ''}`]] };
  if (kind === 'credit-note') { nd.creditFor = src.id; nd.subject = `zu Rechnung ${src.number}`; nd.settlement = 'refund'; }
  src.log.push([TODAY, `Folgedokument: ${KIND[kind]} als Entwurf`]);
  if (src.kind === 'quote' && kind !== 'delivery-note' && src.qstatus !== 'accepted') { src.qstatus = 'accepted'; src.log.push([TODAY, `angenommen (${KIND[kind]} daraus erstellt)`]); }
  D().docs.push(nd);
  S.ui.dialog = null; S.ui.preview = false;
  toast(`${KIND[kind]} aus ${src.number}: ${lines.filter(isItem).length} Positionen übernommen`);
  go(hrefOf(nd));
}

function importPayments() {
  if (S.firm !== 'kaffee') { toast('Im Prototyp hat nur Muster Kaffee GmbH einen Kontoauszug vom 14.11.'); return; }
  if (S.imported) { toast('Der Kontoauszug vom 14.11. ist schon gelesen.'); return; }
  S.imported = true;
  importNow();
  toast('camt.053 vom 14.11.: 4 Zahlungen · 3 zugeordnet, 1 Vorschlag für dich');
  render();
}
function importNow() {
  const k = S.data.kaffee, doc = (id) => k.docs.find((d) => d.id === id);
  const i6 = doc('i6'), i8 = doc('i8'), i3 = doc('i3'), i5 = doc('i5');
  (i6.payments ??= []).push({ date: '2026-11-12', amount: 965.19, by: 'die QR-Referenz' }); i6.log.push(['2026-11-12', 'bezahlt, zugeordnet über die QR-Referenz']);
  (i8.payments ??= []).push({ date: '2026-11-09', amount: 1010.51, by: 'die QR-Referenz' });
  (i8.writeOffs ??= []).push({ date: '2026-11-09', amount: 20.62, reason: 'skonto', by: 'Code' }); i8.log.push(['2026-11-09', 'bezahlt innert 10 Tagen mit 2 % Skonto; Skonto CHF 20.62 vom Code ausgebucht']);
  i3.proposal = { date: '2026-11-13', amount: 840, text: 'Beispiel Bistro AG, Rg 2026-003' };
  (i5.payments ??= []).push({ date: '2026-11-12', amount: 862.5, by: 'die SCOR-Referenz' }); i5.feeProposal = { amount: 2.5 }; i5.log.push(['2026-11-12', 'Zahlung EUR 862.50 zugeordnet über die SCOR-Referenz']);
}

document.addEventListener('click', (e) => {
  const off = e.target.closest('[data-off]');
  if (off) { e.preventDefault(); toast('Im Prototyp ist nur der Bereich Rechnungen (und Firma › Rechnungslayout) nachgebaut.'); return; }
  const h = e.target.closest('[data-href]');
  if (h && !e.target.closest('[data-act]')) { go(h.dataset.href); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act, v = b.dataset.v, d = current();
  const r = route();
  switch (act) {
    case 'close': S.ui.dialog = null; render(); break;
    case 'sec': { const k = b.dataset.k; const el = b.closest('.sec'); S.ui.open[k] = !el.classList.contains('open'); el.classList.toggle('open'); b.setAttribute('aria-expanded', String(S.ui.open[k])); break; }
    case 'dlg-new': S.ui.dialog = { kind: 'new' }; render(); break;
    case 'dlg-newquote': S.ui.dialog = { kind: 'newquote' }; render(); break;
    case 'new-for': newDraft(b.dataset.id, 'invoice'); break;
    case 'newquote-for': newDraft(b.dataset.id, 'quote'); break;
    case 'preview': S.ui.preview = !S.ui.preview; render(); break;
    case 'issue': issue(d); break;
    case 'delete': { D().docs.splice(D().docs.indexOf(d), 1); toast('Entwurf gelöscht'); go(pre(d) ? '#/invoices/quotes' : '#/invoices'); break; }
    case 'send': S.ui.dialog = { kind: 'send', docId: d.id }; render(); break;
    case 'send-do': {
      const g = S.ui.dialog, x = doc(g.docId), c = cust(x.cu), now = new Date().toTimeString().slice(0, 5);
      const title = g.reminder ? `${g.reminder.level}. Mahnung ${x.number}` : docTitle(x);
      (x.sent ??= []).push({ date: TODAY, time: now, to: v === 'mail' ? c.email : 'heruntergeladen', title, reminder: g.reminder });
      if (g.reminder) { (x.reminders ??= []).push({ level: g.reminder.level, date: TODAY }); x.log.push([TODAY, `${g.reminder.level}. Mahnung gesendet${g.reminder.interest ? `, mit Verzugszins CHF ${fmt(g.reminder.interest.amount)}` : ''}`]); S.ui.reminder = null; }
      else x.log.push([TODAY, `${v === 'mail' ? 'gesendet' : 'heruntergeladen'}: ${title}`]);
      S.ui.dialog = null;
      toast(v === 'mail' ? `${title} an ${c.email} gesendet` : `${title} heruntergeladen und als gesendet erfasst`);
      render(); break;
    }
    case 'remind': S.ui.reminder = d.id; S.ui.preview = false; render(); break;
    case 'remind-cancel': S.ui.reminder = null; render(); break;
    case 'remind-send': S.ui.dialog = { kind: 'send', docId: d.id, reminder: { level: (d.reminders?.length ?? 0) + 1, fee: S.settings.fees[d.reminders?.length ?? 0], interest: interestFor(d) } }; render(); break;
    case 'dlg-writeoff': S.ui.dialog = { kind: 'writeoff', docId: d.id }; render(); break;
    case 'wo-reason': S.ui.dialog.reason = v; render(); break;
    case 'wo-do': {
      const x = doc(S.ui.dialog.docId), amt = openOf(x);
      (x.writeOffs ??= []).push({ date: TODAY, amount: amt, reason: v, by: 'Anna Muster' });
      x.log.push([TODAY, `Rest ${x.cur} ${fmt(amt)} ausgebucht: ${WO[v]}${S.basis === 'agreed' && F().vat ? ` (RE-${x.number}-wo-${x.writeOffs.length})` : ' (vereinnahmt: keine Buchung)'}`]);
      S.ui.dialog = null; S.ui.open.book = true;
      toast(`${x.number}: ${x.cur} ${fmt(amt)} als ${WO[v]} ausgebucht`); render(); break;
    }
    case 'confirm-pay': { (d.payments ??= []).push({ date: d.proposal.date, amount: d.proposal.amount, by: 'deine Zuordnung' }); d.log.push([TODAY, `Zahlung vom ${dmy(d.proposal.date)} (CHF ${fmt(d.proposal.amount)}) zugeordnet; Rest CHF ${fmt(openOf(d))} offen`]); delete d.proposal; toast(`Zugeordnet. Rest CHF ${fmt(openOf(d))} bleibt offen.`); render(); break; }
    case 'fee-wo': { (d.writeOffs ??= []).push({ date: TODAY, amount: d.feeProposal.amount, reason: 'fee', by: 'Anna Muster' }); d.log.push([TODAY, `Rest EUR ${fmt(d.feeProposal.amount)} als Gebühr ausgebucht`]); delete d.feeProposal; S.ui.open.book = true; toast('Ausgebucht. Die Rechnung ist bezahlt.'); render(); break; }
    case 'convert': if (d.lines.some((l) => l.optional)) { S.ui.dialog = { kind: 'follow', docId: d.id, target: 'invoice' }; render(); } else follow(d, 'invoice'); break;
    case 'dlg-follow': S.ui.dialog = { kind: 'follow', docId: d.id }; render(); break;
    case 'follow-target': S.ui.dialog.picks = $$('[data-optk]:checked').map((x) => Number(x.dataset.optk)); S.ui.dialog.target = v; render(); break;
    case 'follow-do': { const g = S.ui.dialog, src = doc(g.docId); follow(src, g.target ?? FOLLOW[src.kind][0], $$('[data-optk]:checked').map((x) => Number(x.dataset.optk))); break; }
    case 'follow-credit': S.ui.dialog = { kind: 'follow', docId: S.ui.dialog.docId, target: 'credit-note' }; render(); break;
    case 'issue-force': { const x = doc(S.ui.dialog.docId); S.ui.dialog = null; issue(x, true); break; }
    case 'optline': { const l = d.lines[Number(b.dataset.k)]; l.optional = !l.optional; if (!l.optional) delete l.optional; render(); break; }
    case 'cancel': {
      if (stateOf(d) !== 'paid') { toast('Wie heute in der App: Datum, Grund, auf Wunsch eine Mitteilung an den Kunden.'); break; }
      const last = d.payments.at(-1);
      S.ui.dialog = { kind: 'warn', docId: d.id, label: 'Stornieren', title: `${d.number} ist bezahlt`, what: `Bezahlt am ${dmy(last.date)}, ${d.cur} ${fmt(paid(d))}, zugeordnet über ${last.by}.`,
        rule: 'ein Storno hebt die Rechnung auf, als wäre sie nie gestellt; das Geld ist aber eingegangen. Für bezahlte Leistungen ist die Gutschrift der übliche Weg (sie zeigt, was zurückgeht).',
        follows: `die Zahlung wird von der Rechnung gelöst und steht ohne Rechnung bei den Zahlungen, bis du sie zuordnest oder zurückzahlst; ihre Buchung wird zurückgenommen. Liegt die Zahlung in einem eingereichten Quartal, bleibt es unverändert: die Rücknahme wird im offenen Quartal gebucht.`,
        alt: { act: 'follow-credit', label: 'Gutschrift statt Storno' }, go: 'cancel-force', goLabel: 'Trotzdem stornieren' };
      render(); break;
    }
    case 'cancel-force': {
      const x = doc(S.ui.dialog.docId);
      x.unlinked = x.payments; x.payments = []; x.cancelled = { date: TODAY, reason: 'storniert nach der Zahlung' };
      x.log.push([TODAY, `storniert; Zahlung vom ${dmy(x.unlinked.at(-1).date)} gelöst, sie wartet bei den Zahlungen`]);
      S.ui.dialog = null; toast(`${x.number} storniert; die Zahlung wartet bei den Zahlungen`); render(); break;
    }
    case 'q-accept': d.qstatus = 'accepted'; d.log.push([TODAY, 'angenommen']); render(); break;
    case 'q-decline': d.qstatus = 'declined'; d.log.push([TODAY, 'abgelehnt']); render(); break;
    case 'q-send': d.number = nextNumber('quote'); d.status = 'issued'; d.qstatus = 'sent'; d.log.push([TODAY, `Nummer ${d.number}`]); S.ui.dialog = { kind: 'send', docId: d.id, issued: true }; go(`#/invoices/quotes/${d.number}`); break;
    case 'q-resend': S.ui.dialog = { kind: 'send', docId: d.id }; render(); break;
    case 'copy': { const nd = { ...clone(d), id: `n${Date.now().toString(36)}`, kind: pre(d) ? d.kind : 'invoice', status: 'draft', number: undefined, date: TODAY, payments: [], writeOffs: [], sent: [], reminders: [], cancelled: undefined, qstatus: undefined, log: [[TODAY, `kopiert aus ${d.number}`]] }; if (nd.kind === 'quote') nd.validUntil = addDays(TODAY, 30); delete nd.ref; delete nd.due; delete nd.recurring; delete nd.from; delete nd.invoicedAs; delete nd.unlinked; delete nd.qrIbanEur; D().docs.push(nd); go(hrefOf(nd)); break; }
    case 'addline': d.lines.splice(firstDedIndex(d), 0, L('', 1, 'pcs', 0, F().vat ? 8.1 : 0)); render(); break;
    case 'addtitle': d.lines.splice(firstDedIndex(d), 0, L('Titel', 0, '', 0, 0, { kind: 'title' })); render(); break;
    case 'addsub': d.lines.splice(firstDedIndex(d), 0, L('Zwischentotal', 0, '', 0, 0, { kind: 'sub' })); render(); break;
    case 'rmline': { const l = d.lines[Number(b.dataset.k)]; d.lines.splice(Number(b.dataset.k), 1); if (l.deducts) d.log.push([TODAY, `Abzug der Gutschrift ${doc(l.deducts).number} entfernt; sie bleibt zu verrechnen`]); render(); break; }
    case 'dlg-articles': S.ui.dialog = { kind: 'articles', docId: d.id }; render(); break;
    case 'art-add': {
      const x = doc(S.ui.dialog.docId), picked = $$('[data-art]:checked');
      if (!picked.length) { toast('Kein Artikel gewählt.'); break; }
      x.lines = x.lines.filter((l) => l.kind || l.text.trim() || l.p);
      for (const cb of picked) { const a = D().articles.find((y) => y.id === cb.dataset.art); const q = Number($(`[data-qty="${a.id}"]`).value) || 1; x.lines.splice(firstDedIndex(x), 0, L(a.text, q, a.unit, a.price, x.cur === 'EUR' ? 0 : a.rate, { articleId: a.id })); }
      if (x.subject === 'Neue Rechnung' || x.subject === 'Offerte') x.subject = x.lines.find(isItem)?.text || x.subject;
      S.ui.dialog = null; toast(`${picked.length} ${picked.length === 1 ? 'Position' : 'Positionen'} aus der Artikelliste`); render(); break;
    }
    case 'dlg-hours': S.ui.dialog = { kind: 'hours', docId: d.id, group: 'text' }; render(); break;
    case 'hours-group': S.ui.dialog.group = v; S.ui.dialog.text = $('[data-hours]').value; render(); if (S.ui.dialog.text) $('[data-hours]').value = S.ui.dialog.text; break;
    case 'hours-add': {
      const x = doc(S.ui.dialog.docId), rows = $('[data-hours]').value.trim().split('\n').slice(1).map((l) => l.split(/\t|;/)).filter((c) => c.length >= 4);
      x.lines = x.lines.filter((l) => l.kind || l.text.trim() || l.p);
      if (S.ui.dialog.group === 'row') for (const [dt, t, h, p] of rows) x.lines.splice(firstDedIndex(x), 0, L(`${dt} ${t}`, Number(h), 'h', Number(p), 8.1, { source: 'hours' }));
      else { const g = {}; for (const [, t, h, p] of rows) { g[t] ??= { h: 0, p: Number(p) }; g[t].h += Number(h); } for (const [t, o] of Object.entries(g)) x.lines.splice(firstDedIndex(x), 0, L(t, o.h, 'h', o.p, 8.1, { source: 'hours' })); }
      S.ui.dialog = null; toast(`${rows.length} Zeilen der Tabelle übernommen`); render(); break;
    }
    case 'dlg-expenses': S.ui.dialog = { kind: 'expenses', docId: d.id }; render(); break;
    case 'exp-add': {
      const x = doc(S.ui.dialog.docId), picked = $$('[data-rcpt]:checked');
      x.lines = x.lines.filter((l) => l.kind || l.text.trim() || l.p);
      for (const cb of picked) { const rc = D().receipts.find((y) => y.id === cb.dataset.rcpt); rc.billed = x.id; x.lines.splice(firstDedIndex(x), 0, L(`Spesen: ${rc.text} (${dmy(rc.date)})`, 1, 'flat', rc.net, 8.1, { source: { receiptId: rc.id } })); }
      S.ui.dialog = null; toast(`${picked.length} Belege als Spesen übernommen`); render(); break;
    }
    case 'means': d.paidAtIssue = v || undefined; if (!v) delete d.paidAtIssue; render(); break;
    case 'cur': if (v === 'EUR') { d.cur = 'EUR'; d.lines.forEach((l) => { if (cust(d.cu).country !== 'CH') l.rate = 0; }); } else d.cur = v; render(); break;
    case 'lang': d.lang = v === 'fr' ? 'fr' : 'de'; if (!['de', 'fr'].includes(v)) toast('Im Prototyp nur Deutsch und Französisch.'); render(); break;
    case 'rec-every': D().recurring.find((x) => x.id === r.id).every = v; render(); break;
    case 'rec-mode': D().recurring.find((x) => x.id === r.id).mode = v; render(); break;
    case 'rec-now': {
      const t = D().recurring.find((x) => x.id === b.dataset.id), nd = { id: `n${Date.now().toString(36)}`, kind: 'invoice', status: 'draft', cu: t.cu, subject: `${t.name} Dezember`, date: t.next, cur: 'CHF', lang: cust(t.cu).lang, lines: clone(t.lines), recurring: t.id, log: [[TODAY, `aus der Vorlage «${t.name}» angelegt`]] };
      D().docs.push(nd); t.made.push(nd.id); toast('Entwurf aus der Vorlage angelegt'); go(`#/invoices/draft-${nd.id}`); break;
    }
    case 'no-remind': break;
    case 'oi-print': toast('Drucken: die Debitorenliste als A4, wie sie hier steht'); break;
    case 'oi-csv': toast('CSV: Kunde; Nr.; Datum; Fällig; Tage; Offen; Währung'); break;
    case 'pdf': toast('Im Prototyp gibt es kein PDF; die App lädt das abgelegte PDF.'); break;
    case 'set-interest': case 'set-skonto': case 'eur-qr': break;
    case 'ap-change': S.ui.ap = { id: b.dataset.id }; S.ui.apNote = null; render(); break;
    case 'ap-cancel': case 'ap-back': S.ui.ap = act === 'ap-back' ? { ...S.ui.ap, warn: null } : null; render(); break;
    case 'ap-save': {
      const a = D().articles.find((x) => x.id === S.ui.ap.id), pv = $('#ap-price').value.trim(), fv = $('#ap-from').value.trim();
      const m = /^(\d\d)\.(\d\d)\.(\d{4})$/.exec(fv), price = Number(pv.replace(/'/g, ''));
      if (!m || !(price > 0)) { toast('«gilt ab» als TT.MM.JJJJ und ein Preis'); break; }
      const from = `${m[3]}-${m[2]}-${m[1]}`, hits = issuedWith(a, from, price);
      S.ui.ap = { ...S.ui.ap, price: pv, from: fv };
      if (hits.length) { S.ui.ap.warn = { from, price, hits, diff: hits.reduce((t, { l }) => t + (price - l.p) * l.q, 0) }; render(); break; }
      keepPrice(a, from, price, from > TODAY ? `Gilt ab ${dmy(from)}; bis dann bleibt der alte Preis.` : `Gilt ab ${dmy(from)}; neue Zeilen nehmen ihn.`); break;
    }
    case 'ap-leave': case 'ap-draft': {
      const a = D().articles.find((x) => x.id === S.ui.ap.id), w = S.ui.ap.warn;
      keepPrice(a, w.from, w.price, act === 'ap-leave' ? `Gilt ab ${dmy(w.from)}. ${w.hits.map((x) => x.d.number).join(', ')} bleiben wie ausgestellt.` : `Gilt ab ${dmy(w.from)}. ${w.diff > 0 ? 'Nachbelastung' : 'Gutschrift'} über CHF ${fmt(Math.abs(w.diff))} als Entwurf angelegt; ${w.hits.map((x) => x.d.number).join(', ')} bleiben wie ausgestellt.`);
      if (act === 'ap-draft') toast(`Entwurf: ${w.diff > 0 ? 'Nachbelastung' : 'Gutschrift'} CHF ${fmt(Math.abs(w.diff))}`);
      break;
    }
    case 'eur-qr-keep': S.settings.eurQr = 'kept'; toast('QR-IBAN für EUR gespeichert'); render(); break;
    case 'eur-qr-drop': S.settings.eurQr = ''; render(); break;
    default: if (act.startsWith('noop')) toast('Wie heute in der App; im Prototyp nicht nachgebaut.');
  }
});
const firstDedIndex = (d) => { const i = d.lines.findIndex((l) => l.kind === 'ded'); return i < 0 ? d.lines.length : i; };

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act === 'set-interest') { S.settings.interest = el.checked; toast(el.checked ? 'Verzugszins an: 5 % ab Fälligkeit, auf jeder neuen Mahnung' : 'Verzugszins aus'); render(); return; }
  if (el.dataset.act === 'set-skonto') { S.settings.skonto = el.checked; render(); return; }
  if (el.dataset.act === 'no-remind') { cust(el.dataset.id).noReminders = el.checked; toast(el.checked ? 'Wird nie gemahnt' : 'Wird wieder gemahnt'); render(); return; }
  if (el.dataset.act === 'eur-qr') { if (S.settings.eurQr !== 'kept') S.settings.eurQr = el.value.trim() ? 'warned' : ''; render(); return; }
  if (el.tagName === 'SELECT' && el.dataset.ed) edit(el.dataset.ed, el.value);
});
document.addEventListener('focusout', (e) => { const el = e.target; if (el.isContentEditable && el.dataset.ed) edit(el.dataset.ed, el.innerText.trim()); });
document.addEventListener('keydown', (e) => {
  const el = e.target;
  if (el.isContentEditable && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
  if (e.key === 'Escape' && S.ui.dialog) { S.ui.dialog = null; render(); }
  if (e.key.toLowerCase() === 'n' && !el.closest?.('input, textarea, [contenteditable]') && !S.ui.dialog && route().area === 'invoices') { S.ui.dialog = { kind: route().view === 'quotes' ? 'newquote' : 'new' }; render(); }
});
document.addEventListener('input', (e) => { if (e.target.classList.contains('isearch')) { const q = e.target.value.toLowerCase(); $$('.iopts .opt:not(.alt)').forEach((o) => { o.style.display = o.textContent.toLowerCase().includes(q) ? '' : 'none'; }); } });
function edit(key, value) {
  const d = current();
  if (!d || d.status !== 'draft') return;
  const num = (s) => Number(String(s).replace(/['’\s]/g, '').replace(',', '.')) || 0;
  if (key === 'customer') { d.cu = value; d.lang = cust(value).lang; d.cur = cust(value).currency ?? d.cur; }
  else if (key === 'date') { const m = value.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/); if (m) d.date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  else if (key === 'exemption') d.exemption = value;
  else if (key === 'intro') return;
  else {
    const [, k, f] = key.split(':'), l = d.lines[Number(k)];
    if (!l) return;
    if (f === 'text') { l.text = value; if (Number(k) === 0 && (d.subject === 'Neue Rechnung' || d.subject === 'Offerte')) d.subject = value; }
    if (f === 'q') l.q = num(value);
    if (f === 'p') l.p = num(value);
    if (f === 'unit') l.unit = value;
    if (f === 'rate') { l.incl = value.startsWith('incl:'); l.rate = Number(value.replace('incl:', '')); }
  }
  render();
}

window.addEventListener('hashchange', () => { S.ui.reminder = null; S.ui.preview = false; render(); });
window.addEventListener('resize', fit);
window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.firm && m.firm !== S.firm) { S.firm = m.firm; S.ui = { open: {}, preview: false, reminder: null, dialog: null }; location.hash = m.firm === 'salon' ? '#/invoices/draft-sd1' : '#/invoices'; }
  if (m.basis) S.basis = m.basis;
  if (m.mark !== undefined) S.mark = m.mark;
  if (m.import) { importPayments(); return; }
  if (m.reset) { S.data = baseline(); S.imported = false; S.settings.interest = false; S.ui = { open: {}, preview: false, reminder: null, dialog: null }; toast('Von vorn: die Daten des Demos'); }
  render();
});

// Start: ?firm=salon&basis=agreed in the hash set the scenario (links from index.html).
(() => {
  const dlg = document.createElement('div'); dlg.id = 'dlg'; document.body.appendChild(dlg);
  const q = route().q;
  if (q.firm === 'salon' || q.firm === 'kaffee') S.firm = q.firm;
  if (q.basis === 'agreed' || q.basis === 'received') S.basis = q.basis;
  if (q.interest === '1') S.settings.interest = true;
  if (q.import === '1' && S.firm === 'kaffee') { S.imported = true; importNow(); }
  if (q.firm || q.basis || q.import || q.interest) history.replaceState(null, '', location.hash.replace(/[?&](firm|basis|import|interest)=[^&]*/g, '').replace(/\?$/, '').replace(/\?&/, '?'));
  render();
})();
