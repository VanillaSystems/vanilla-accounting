/**
 * An invented bank statement as a PDF (#217): a made-up bank, owner and movements laid out the way
 * statements print them, several pages with the balance carried over at each foot and brought in at
 * the next top. Returns the PDF and the statement it shows (pages and carry-overs included), which
 * is what a correct read gives. Never a real statement.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { ReadStatement } from '../../src/types/statement-read.js';

export interface Invented {
  bank: string;
  owner: string;
  iban: string;
  currency: string;
  from: string;
  to: string;
  opening: number;
  movements: { date: string; amount: number; counterparty?: string; text: string; reference?: string }[];
  /** Movements per page; the last page takes the rest. */
  perPage?: number;
  /** A scan whose text gives no IBAN (the account number only on a logo, say): only the read gives it. */
  noIban?: boolean;
}

const swiss = (n: number) => {
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}.${dec}`;
};
const dmy = (iso: string) => iso.split('-').reverse().join('.');
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function inventedStatement(s: Invented): Promise<{ pdf: Buffer; truth: ReadStatement }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const per = s.perPage ?? s.movements.length;
  const chunks: Invented['movements'][] = [];
  for (let i = 0; i < Math.max(1, s.movements.length); i += per) chunks.push(s.movements.slice(i, i + per));
  let balance = s.opening;
  const pages: NonNullable<ReadStatement['pages']> = [];
  const moves: ReadStatement['movements'] = [];
  chunks.forEach((chunk, p) => {
    const page = doc.addPage([595, 842]);
    let y = 790;
    const line = (text: string, x = 50, f = font, size = 10) => page.drawText(text, { x, y, size, font: f });
    const row = (cells: [string, number][], f = font) => { for (const [text, x] of cells) line(text, x, f); y -= 16; };
    line(s.bank, 50, bold, 13); y -= 20;
    line(`Kontoauszug ${dmy(s.from)} - ${dmy(s.to)}`, 50, bold, 12); y -= 18;
    line(s.noIban ? `Konto in ${s.currency}` : `IBAN ${s.iban.replace(/(.{4})/g, '$1 ').trim()}   Konto in ${s.currency}`); y -= 14;
    line(`Kontoinhaber: ${s.owner}`); y -= 14;
    line(`Seite ${p + 1} von ${chunks.length}`, 470); y -= 24;
    row([['Datum', 50], ['Text', 120], ['Belastung', 390], ['Gutschrift', 470]], bold);
    const carriedIn = r2(balance);
    row([[p === 0 ? 'Saldovortrag' : 'Übertrag', 120], [swiss(carriedIn), 470]]);
    for (const m of chunk) {
      row([[dmy(m.date), 50], [[m.counterparty, m.text].filter(Boolean).join(', ').slice(0, 52), 120], [m.amount < 0 ? swiss(-m.amount) : '', 390], [m.amount >= 0 ? swiss(m.amount) : '', 470]]);
      if (m.reference) row([[`Referenz ${m.reference}`, 120]]);
      balance = r2(balance + m.amount);
      moves.push({ date: m.date, amount: m.amount, ...(m.counterparty ? { counterparty: m.counterparty } : {}), text: m.text, ...(m.reference ? { reference: m.reference } : {}), page: p + 1 });
    }
    const last = p === chunks.length - 1;
    row([[last ? `Schlusssaldo per ${dmy(s.to)}` : 'Übertrag auf nächste Seite', 120], [swiss(balance), 470]], bold);
    if (chunks.length > 1) pages.push({ page: p + 1, carriedIn, carriedOut: r2(balance) });
  });
  const truth: ReadStatement = {
    iban: s.iban, currency: s.currency, bankName: s.bank, owner: s.owner, period: { from: s.from, to: s.to },
    opening: { date: s.from, amount: r2(s.opening) }, closing: { date: s.to, amount: r2(balance) },
    ...(pages.length ? { pages } : {}), movements: moves,
  };
  return { pdf: Buffer.from(await doc.save({ useObjectStreams: false })), truth };
}

/** An October statement of an invented bank for the demo's Raiffeisen account (its IBAN), opening where September closed. */
export const DEMO_OCTOBER: Invented = {
  bank: 'Musterbank Beispiel AG', owner: 'Muster Rösterei GmbH', iban: 'CH6580808000000000001', currency: 'CHF',
  from: '2026-10-01', to: '2026-10-31', opening: 88252.44, perPage: 4,
  movements: [
    { date: '2026-10-02', amount: -1204, counterparty: 'Gruenkaffee Muster AG', text: 'Zahlung Rechnung 2026-1187', reference: '210000000003139471430009017' },
    { date: '2026-10-05', amount: 2380.5, counterparty: 'Café Beispiel Zürich', text: 'Gutschrift Rechnung RE-2026-041' },
    { date: '2026-10-09', amount: -86.4, counterparty: 'Coop Pronto Musterdorf', text: 'Karte 1234 Einkauf' },
    { date: '2026-10-14', amount: -450, counterparty: 'Muster Immobilien AG', text: 'Miete Lager Oktober' },
    { date: '2026-10-20', amount: 1950, counterparty: 'Bistro Exempel GmbH', text: 'Gutschrift Rechnung RE-2026-044' },
    { date: '2026-10-27', amount: -39.9, counterparty: 'Telefon Beispiel AG', text: 'Abo Oktober' },
    { date: '2026-10-31', amount: -12.5, text: 'Kontoführungsgebühr' },
  ],
};
