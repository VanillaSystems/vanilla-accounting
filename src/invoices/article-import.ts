/**
 * Artikel from a table (spec 4.3, 5 «Phase 2»: «Artikel … and their CSV import»), read the way
 * contacts are (table-import.ts): any CSV, code proposes the column mapping from the header words
 * in four languages and as other tools name them, the person changes any column. A row without a
 * name or with a price that cannot be read is not imported; the others come in with what is wrong
 * named (a unit or VAT kind not recognised, an account not of four digits). A row whose code an
 * Artikel already has, or an earlier row, is proposed as the same Artikel and not imported again
 * unless the person says `new` (and gives it another code: a code names one Artikel). Pure;
 * src/invoices/service.ts addArticles saves what it returns.
 */
import { kindOfRate } from '../engines/index.js';
import { DEFAULT_UNITS, type Article, type ArticleFields, type UnitDef, type VatKind } from './model.js';
import { ambiguousNumber, normWord, proposeColumns, readTable, tableNumber, type ImportChoice, type Mapping } from './table-import.js';

export const ARTICLE_FIELDS = ['code', 'name', 'type', 'text', 'unit', 'price', 'vat', 'account', 'group'] as const;
export type ArticleField = (typeof ARTICLE_FIELDS)[number];
export type ArticleMapping = Mapping<ArticleField>;

/**
 * What is wrong with a row. `name`, `price` (not read), `priceUnclear` (it reads two ways, «1,200»): not imported. The others are imported all the same:
 * `unit` left out, `vat` read as the normal rate, `account` left out, `code` over 30 characters
 * left out, `type` read as a service.
 */
export const ARTICLE_PROBLEMS = ['name', 'price', 'priceUnclear', 'unit', 'vat', 'account', 'code', 'type'] as const;
export type ArticleProblem = (typeof ARTICLE_PROBLEMS)[number];
const BLOCKING: readonly ArticleProblem[] = ['name', 'price', 'priceUnclear'];

export interface ArticleImportRow {
  line: number;
  article?: ArticleFields;
  problems: ArticleProblem[];
  /** The Artikel already there, or the earlier row, with the same code. */
  same?: { articleId: string; name: string } | { line: number; name: string };
  choice: ImportChoice;
}

export interface ArticleImportPreview { header: string[]; mapping: ArticleMapping; rows: ArticleImportRow[]; leftOut: number }

const HEADERS: Record<ArticleField, string[]> = {
  code: ['code', 'artikelcode', 'artikelnummer', 'artikelnr', 'produktcode', 'produktnummer', 'artnr', 'sku', 'itemcode', 'itemnumber', 'productcode', 'nr', 'nummer', 'référence', 'reference', 'codice', 'codicearticolo'],
  name: ['name', 'artikel', 'artikelname', 'bezeichnung', 'produkt', 'produktname', 'article', 'product', 'productname', 'item', 'nom', 'désignation', 'designation', 'articolo', 'nome', 'descrizione'],
  type: ['typ', 'art', 'produktart', 'artikelart', 'type', 'kind', 'tipo'],
  text: ['text', 'beschreibung', 'produktbeschreibung', 'langtext', 'description', 'texte', 'testo'],
  unit: ['einheit', 'unit', 'unité', 'unite', 'unità', 'unita', 'me', 'mengeneinheit'],
  price: ['preis', 'verkaufspreis', 'vk', 'vkpreis', 'einzelpreis', 'price', 'saleprice', 'salesprice', 'unitprice', 'prix', 'prixdevente', 'prezzo', 'prezzodivendita'],
  vat: ['mwst', 'mwstsatz', 'mwstumsatzsteuer', 'steuersatz', 'mwstcode', 'vat', 'vatrate', 'tax', 'taxrate', 'tva', 'iva', 'ust', 'umsatzsteuer'],
  account: ['konto', 'ertragskonto', 'erlöskonto', 'erloeskonto', 'account', 'revenueaccount', 'compte', 'comptedeproduits', 'conto', 'contoricavi'],
  group: ['gruppe', 'produktgruppe', 'artikelgruppe', 'kategorie', 'group', 'category', 'groupe', 'catégorie', 'categorie', 'gruppo', 'categoria'],
};

export const proposeArticleMapping = (header: readonly string[]): ArticleMapping => proposeColumns(header, ARTICLE_FIELDS, HEADERS);

const GOODS = ['ware', 'waren', 'goods', 'produkt', 'product', 'marchandise', 'merce', 'g', 'w'];
const SERVICE = ['dienstleistung', 'service', 'leistung', 'prestation', 'servizio', 'prestazione', 'dl', 's'];
const KIND_WORDS: Record<string, VatKind> = {
  normal: 'normal', normalsatz: 'normal', standard: 'normal', normale: 'normal',
  reduziert: 'reduced', reduzierter: 'reduced', reduziertersatz: 'reduced', reduced: 'reduced', réduit: 'reduced', reduit: 'reduced', ridotto: 'reduced',
  beherbergung: 'accommodation', beherbergungssatz: 'accommodation', accommodation: 'accommodation', hébergement: 'accommodation', hebergement: 'accommodation', alloggio: 'accommodation',
  keine: 'none', ohne: 'none', befreit: 'none', exempt: 'none', none: 'none', exonéré: 'none', exonere: 'none', esente: 'none', '0': 'none',
};

/**
 * A VAT cell as a kind, read before any number reading (a code is no currency): a word («reduziert»),
 * a rate with or without its point and percent («8.1», «2,6 %», «81», «26»), or a code that ends in
 * one («UN81», «UN26», «V81», «V0»). Undefined when none fits.
 */
export function vatKindOf(cell: string, today: string): VatKind | undefined {
  const w = normWord(cell);
  if (KIND_WORDS[w]) return KIND_WORDS[w];
  const m = /^[A-Za-z]{0,4}[\s-]*(\d{1,3})(?:[.,](\d{1,2}))?\s*%?$/.exec(cell.trim());
  if (!m) return undefined;
  // «81», «UN26»: the digits of a rate without its point (one decimal); «0», «8.1», «2,6 %» as written.
  const rate = m[2] !== undefined ? Number(`${m[1]}.${m[2]}`) : m[1].length >= 2 ? Number(`${m[1].slice(0, -1)}.${m[1].slice(-1)}`) : Number(m[1]);
  return kindOfRate(rate, today);
}

/** A unit cell as one of the firm's units: its id or its word in any language. */
function unitOf(cell: string, units: readonly UnitDef[]): string | undefined {
  const w = normWord(cell);
  const u = units.find((x) => [x.id, x.de, x.fr, x.it, x.en].some((v) => normWord(v) === w));
  return u?.id;
}

function rowArticle(cell: (f: ArticleField) => string, units: readonly UnitDef[], today: string): { article?: ArticleFields; problems: ArticleProblem[] } {
  const name = cell('name');
  if (!name) return { problems: ['name'] };
  const problems: ArticleProblem[] = [];
  const priceText = cell('price');
  const price = priceText ? tableNumber(priceText) : 0;
  if (priceText && ambiguousNumber(priceText)) problems.push('priceUnclear');
  else if (price === undefined) problems.push('price');
  const typeText = normWord(cell('type'));
  const type = GOODS.includes(typeText) ? 'goods' : 'service';
  if (typeText && !GOODS.includes(typeText) && !SERVICE.includes(typeText)) problems.push('type');
  const unitText = cell('unit');
  const unit = unitText ? unitOf(unitText, units) : undefined;
  if (unitText && !unit) problems.push('unit');
  const vatText = cell('vat');
  const vatKind = vatText ? vatKindOf(vatText, today) : 'normal';
  if (vatText && !vatKind) problems.push('vat');
  const accountText = cell('account');
  const account = /^\d{4}$/.test(accountText) ? accountText : undefined;
  if (accountText && !account) problems.push('account');
  const code = cell('code');
  if (code.length > 30) problems.push('code');
  const text = cell('text'), group = cell('group');
  return {
    article: {
      ...(code && code.length <= 30 ? { code } : {}),
      type, name,
      ...(text && text !== name ? { text } : {}),
      ...(unit ? { unit } : {}),
      price: price ?? 0,
      vatKind: vatKind ?? 'normal',
      ...(account ? { account } : {}),
      ...(group ? { group } : {}),
    },
    problems,
  };
}

const codeKey = (s: string) => s.trim().toUpperCase();

/** Pure. The rows of `csv` read with `mapping` (absent: the proposed one), each with its problems, its duplicate by code and its choice. */
export function previewArticleImport(csv: string, mapping: ArticleMapping | undefined, existing: readonly Article[], units: readonly UnitDef[] = DEFAULT_UNITS, today = new Date().toISOString().slice(0, 10)): ArticleImportPreview {
  const table = readTable(csv, mapping, ARTICLE_FIELDS, HEADERS);
  const byCode = new Map<string, { articleId: string; name: string } | { line: number; name: string }>();
  for (const a of existing) if (a.code && !a.deleted) byCode.set(codeKey(a.code), { articleId: a.id, name: a.name });
  const rows = table.rows.map(({ cell, line }): ArticleImportRow => {
    const { article, problems } = rowArticle(cell, units, today);
    if (!article || problems.some((p) => BLOCKING.includes(p))) return { line, ...(article ? { article } : {}), problems, choice: 'skip' };
    const same = article.code ? byCode.get(codeKey(article.code)) : undefined;
    if (!same && article.code) byCode.set(codeKey(article.code), { line, name: article.name });
    return { line, article, problems, ...(same ? { same } : {}), choice: same ? 'same' : 'new' };
  });
  return { header: table.header, mapping: table.mapping, rows, leftOut: table.leftOut };
}

/**
 * Pure. The Artikel to add: each row the preview reads, as the person's choice for its line says
 * (else the proposed one). A row taken as new whose code another Artikel (or an earlier row) holds
 * comes without its code: a code names one Artikel.
 */
export function importArticles(csv: string, mapping: ArticleMapping | undefined, choices: Record<string, ImportChoice>, existing: readonly Article[], units?: readonly UnitDef[], today?: string): { articles: ArticleFields[]; skipped: number } {
  const preview = previewArticleImport(csv, mapping, existing, units, today);
  const taken = new Set(existing.flatMap((a) => (a.code && !a.deleted ? [codeKey(a.code)] : [])));
  const articles: ArticleFields[] = [];
  for (const row of preview.rows) {
    const choice = choices[String(row.line)] ?? row.choice;
    if (choice !== 'new' || !row.article || row.problems.some((p) => BLOCKING.includes(p))) continue;
    const { code, ...rest } = row.article;
    const keep = !!code && !taken.has(codeKey(code));
    if (keep) taken.add(codeKey(code!));
    articles.push(keep ? row.article : rest);
  }
  return { articles, skipped: preview.rows.length - articles.length };
}
