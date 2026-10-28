/**
 * npm run help:build [-- <out dir>]
 *
 * The public help pages (issue #226), from help/<lang>/: one Markdown file per page (front matter:
 * title, summary, section, order) and site.yaml (the site's words, its sections, and the names of
 * the quarter's steps). A page states facts the app already holds through a placeholder, never by
 * copying them, so app and help cannot drift:
 *
 * - on a line of its own, a generated block: `{{vat-codes}}` (the catalogue of
 *   src/accounting/vat-codes.ts in the language's UI texts), `{{case <id>}}` (a casebook case of
 *   examples/cases/, booked as tests/casebook.test.ts proves it), `{{quarter}}` (the steps of
 *   processes/quarter-close.flow.yaml), `{{contents}}` (the site's pages by section);
 * - anywhere in a line, a value: `{{threshold}}`, `{{files-per-drop}}`, … (VALUES below), read from
 *   modules/ch and the constants the app tells a person when a limit is hit.
 *
 * An unknown placeholder, a link to a page that does not exist, a quarter step without words or
 * words for a step the flow lacks: the build fails and names it. Static HTML and one stylesheet,
 * no script, no font or file from elsewhere, no tracking. Every page says which version of the app
 * it describes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { APP_ROOT } from '../../src/workspace/workspace.js';
import { loadJurisdiction } from '../../src/core/modules/load.js';
import { setJurisdiction } from '../../src/engines/index.js';
import { loadCases, type BookingCase } from '../../src/knowledge/cases.js';
import { lookupVatCode, vatCodes, vatCodeRateName, VAT_CODE_FAMILIES, VAT_CODE_KINDS } from '../../src/accounting/vat-codes.js';
import { loadChart } from '../../src/workspace/chart.js';
import { formatIn } from '../../src/app/i18n/core.js';
import type { Key, Locale } from '../../src/app/i18n/types.js';
import { CHAT_TAKES, PAGE_TAKES } from '../../src/app/lib/folder-drop.js';
import { MAX_SELECTED } from '../../src/app/selection/model.js';
import { ATTACHMENT_MAX_MB } from '../../src/types/attachment.js';
import { MAX_CSV_ROWS } from '../../src/providers/statement-read/csv.js';
import { MAX_READ_PAGES } from '../../src/intake/statement-read.js';
import { MAX_PAGES } from '../../src/parsers/pdf-pages.js';
import { MAX_DEPTH, MAX_UNPACKED } from '../../src/intake/unzip.js';
import { anchor, escape, href, inline, markdown } from './markdown.js';

const { jurisdiction } = loadJurisdiction(APP_ROOT, 'ch');
// The catalogue is the shipped jurisdiction's, for a firm on the effective method (as docs/vat-codes.md).
setJurisdiction(jurisdiction);

export const HELP_DIR = join(APP_ROOT, 'help');
export const OUT_DIR = join(APP_ROOT, 'dist-help');
export const VERSION: string = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')).version;

export interface Page {
  slug: string;
  title: string;
  summary: string;
  section: string;
  order: number;
  /** The page's Markdown, placeholders still in it. */
  source: string;
}

export interface Site {
  lang: string;
  title: string;
  sections: Array<{ id: string; title: string }>;
  words: Record<string, string>;
  phases: Record<string, string>;
  /** Per step id of processes/quarter-close.flow.yaml: its name and what happens, in the site's language. */
  quarter: Record<string, { name: string; text: string }>;
  pages: Page[];
}

class HelpError extends Error {}

/** The languages with a help/<lang>/site.yaml. */
export const languages = (root: string = HELP_DIR): string[] =>
  readdirSync(root).filter((d) => existsSync(join(root, d, 'site.yaml'))).sort();

export function loadSite(lang: string, root: string = HELP_DIR): Site {
  const dir = join(root, lang);
  const raw = parse(readFileSync(join(dir, 'site.yaml'), 'utf8')) as Omit<Site, 'lang' | 'pages'>;
  const pages = readdirSync(dir).filter((f) => f.endsWith('.md')).map((file): Page => {
    const text = readFileSync(join(dir, file), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!m) throw new HelpError(`help/${lang}/${file}: no front matter (--- title, summary, section, order ---)`);
    const front = parse(m[1]) as Partial<Page>;
    for (const k of ['title', 'summary', 'section'] as const) {
      if (typeof front[k] !== 'string') throw new HelpError(`help/${lang}/${file}: front matter needs ${k}`);
    }
    if (!raw.sections.some((s) => s.id === front.section)) throw new HelpError(`help/${lang}/${file}: section ${front.section} is not in site.yaml`);
    return { slug: file.replace(/\.md$/, ''), title: front.title!, summary: front.summary!, section: front.section!, order: Number(front.order ?? 99), source: text.slice(m[0].length) };
  });
  return { lang, ...raw, pages: pages.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug)) };
}

// ─── Values: facts the app holds, written into the prose ─────────────────────

const number = (n: number) => n.toLocaleString('de-CH');
const currentRate = (name: string) => Object.values(jurisdiction.rates.rows).find((r) => r.name === name && r.kind === 'supply' && !r.superseded)!.rate;

/** Each value's source is the constant or module file the app itself reads. */
export const VALUES: Record<string, () => string> = {
  version: () => VERSION,
  threshold: () => `CHF ${number(jurisdiction.registration!.turnoverThreshold)}`,
  'due-days': () => String(jurisdiction.periods.vat.dueDays),
  'rate-standard': () => `${currentRate('Normalsatz')} %`,
  'rate-reduced': () => `${currentRate('Reduzierter Satz')} %`,
  'rate-accommodation': () => `${currentRate('Beherbergungssatz')} %`,
  'files-per-drop': () => number(PAGE_TAKES.max),
  'files-per-message': () => number(CHAT_TAKES.max),
  'attachment-mb': () => String(ATTACHMENT_MAX_MB),
  'selection-max': () => number(MAX_SELECTED),
  'csv-rows': () => number(MAX_CSV_ROWS),
  'statement-pages': () => String(MAX_READ_PAGES),
  'receipt-pages': () => String(MAX_PAGES),
  'zip-depth': () => String(MAX_DEPTH),
  'zip-mb': () => String(MAX_UNPACKED / 1024 / 1024),
};

// ─── Blocks: generated sections of a page ────────────────────────────────────

interface Context { site: Site; ui: Locale['messages']; text: (key: string, vars?: Record<string, string | number>) => string; word: (key: string) => string }

const amount = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/’/g, '\'');

function contextOf(site: Site, ui: Locale): Context {
  return {
    site,
    ui: ui.messages,
    text: (key, vars = {}) => {
      if (!(key in ui.messages)) throw new HelpError(`no UI text ${key} in ${site.lang}`);
      return formatIn({ code: site.lang, messages: ui.messages }, key as Key, vars);
    },
    word: (key) => {
      if (!(key in site.words)) throw new HelpError(`help/${site.lang}/site.yaml: words.${key} is missing`);
      return site.words[key];
    },
  };
}

/** The id of a code's row on the VAT-code page, so any page links to `mwst-codes#code-m81-2`. */
export const codeAnchor = (code: string) => `code-${anchor(code.replace(/^-/, ''))}`;

/**
 * A code as a person reads it: what kind it is and its rate, the code beside it.
 * Issue #224 gives every code a plain name in the catalogue; this is the one place that takes it.
 */
function plainName(c: Context, code: string): string {
  const found = lookupVatCode(code);
  if (!found) return code;
  const { entry, negative } = found;
  const parts = [c.text(`vatCodes.kind.${entry.kind}.name`), entry.rate ? `${entry.rate} %` : '', entry.rate ? c.word(`code.${entry.amountIs}`) : ''];
  return `${negative ? `${c.word('code.negative')} ` : ''}${parts.filter(Boolean).join(', ')}`;
}

function vatCodesBlock(c: Context): string {
  const codes = vatCodes();
  const RATE_NAMES: Record<string, string> = { Normalsatz: 'vat.rateStandard', 'Reduzierter Satz': 'vat.rateReduced', Beherbergungssatz: 'vat.rateAccommodation' };
  const out: string[] = [`<p>${escape(c.text('vatCodes.intro'))}</p>`];
  for (const family of VAT_CODE_FAMILIES) {
    const kinds = VAT_CODE_KINDS.filter((k) => k.family === family && codes.some((e) => e.kind === k.kind && e.family === family));
    if (!kinds.length) continue;
    out.push(`<h2 id="${anchor(`familie ${family}`)}">${escape(`${family}: ${c.text(`vatCodes.family.${family}`)}`)}</h2>`);
    for (const k of kinds) {
      out.push(`<h3>${escape(c.text(`vatCodes.kind.${k.kind}.name`))}</h3>`,
        `<p><strong>${escape(c.text('vatCodes.when'))}:</strong> ${escape(c.text(`vatCodes.kind.${k.kind}.when`))}</p>`,
        `<p><strong>${escape(c.text('vatCodes.notWhen'))}:</strong> ${escape(c.text(`vatCodes.kind.${k.kind}.notWhen`))}</p>`,
        `<table class="codes"><thead><tr><th>Code</th><th>${escape(c.word('codes.rate'))}</th><th>${escape(c.word('codes.amount'))}</th><th>${escape(c.text('vatCodes.ziffern'))}</th></tr></thead><tbody>`);
      for (const e of codes.filter((x) => x.kind === k.kind && x.family === family)) {
        const rateName = e.rate ? vatCodeRateName(e.rate) : undefined;
        const rate = e.rate === null ? '' : `${e.rate} %${rateName ? ` ${c.text(RATE_NAMES[rateName])}` : ''}${e.superseded ? ` (${c.text('vatCodes.superseded')})` : ''}`;
        const amountIs = c.text(e.amountIs === 'tax' ? 'vatCodes.amountTax' : e.amountIs === 'net' ? 'vatCodes.amountNet' : 'vatCodes.amountGross');
        const ziffern = !e.ziffern ? c.text('vatCodes.notDeclared') : e.ziffern.length === 0 ? c.text('vatCodes.noZiffer')
          : e.ziffern.map((z) => zifferName(c, z.ziffer)).join('; ');
        out.push(`<tr id="${codeAnchor(e.code)}"><td><code>${escape(e.code)}</code></td><td>${escape(rate)}</td><td>${escape(amountIs)}</td><td>${escape(ziffern)}</td></tr>`);
      }
      out.push('</tbody></table>');
    }
  }
  return out.join('\n');
}

function zifferName(c: Context, z: string): string {
  const key = `vat.z${z}`;
  if (key in c.ui) return `${z} ${c.text(key)}`;
  const row = jurisdiction.rates.rows[z];
  return row ? `${z} ${row.name} ${row.rate} %` : z;
}

let chartNames: Map<string, string> | undefined;
const accountName = (n: string) => (chartNames ??= new Map(loadChart().accounts.map((a) => [a.number, a.name]))).get(n);

function caseBlock(c: Context, id: string | undefined): string {
  const k: BookingCase | undefined = loadCases().find((x) => x.id === id);
  if (!k) throw new HelpError(`{{case ${id ?? ''}}}: no case examples/cases/${id}.yaml`);
  const account = (n: string) => (n ? `<span class="acct">${escape(n)}</span> ${escape(accountName(n) ?? '')}` : '');
  const out: string[] = ['<div class="case">'];
  out.push(`<h3>${escape(c.word('case.receipt'))}</h3>`,
    k.receipt ? `<pre class="receipt">${escape(k.receipt.text.trim())}</pre>` : `<p>${escape(c.word('case.noReceipt'))}</p>`);
  out.push(`<h3>${escape(c.word('case.payment'))}</h3>`);
  if (k.transaction) {
    const t = k.transaction;
    out.push(`<p>${escape(k.date.split('-').reverse().join('.'))} · ${escape(t.description)} · ${escape(c.word(t.direction === 'DBIT' ? 'case.out' : 'case.in'))} ${escape(t.currency)} ${amount(t.amount)} · ${account(t.account)}</p>`);
  } else out.push(`<p>${escape(c.word('case.noPayment'))}</p>`);
  out.push(`<h3>${escape(c.word('case.booking'))}</h3>`,
    `<table><thead><tr><th>${escape(c.word('case.debit'))}</th><th>${escape(c.word('case.credit'))}</th><th class="num">${escape(c.word('case.amount'))}</th><th>${escape(c.word('case.code'))}</th><th>${escape(c.word('case.text'))}</th></tr></thead><tbody>`);
  for (const l of k.lines) {
    const code = l.vatCode
      ? `<a href="${href(`mwst-codes#${codeAnchor(l.vatCode)}`)}"><code>${escape(l.vatCode)}</code></a> ${escape(plainName(c, l.vatCode))}`
      : escape(c.word('case.noCode'));
    const foreign = l.currency && l.rate ? ` (${escape(l.currency)} ${c.word('case.rate')} ${l.rate})` : '';
    out.push(`<tr><td>${account(l.debit)}</td><td>${account(l.credit)}</td><td class="num">${amount(l.amount)}${foreign}</td><td>${code}</td><td>${escape(l.description)}${l.corrects ? ` (${escape(c.word('case.corrects'))} ${escape(l.corrects)})` : ''}</td></tr>`);
  }
  out.push('</tbody></table>');
  const ziffern = Object.entries(k.ziffern);
  if (ziffern.length) {
    out.push(`<h3>${escape(c.word('case.ziffern'))}</h3>`, '<table><tbody>',
      ...ziffern.map(([z, v]) => `<tr><td>${escape(zifferName(c, z))}</td><td class="num">${amount(v)}</td></tr>`),
      `<tr class="total"><td>${escape(c.word(k.payable >= 0 ? 'case.payable' : 'case.refund'))}</td><td class="num">${amount(Math.abs(k.payable))}</td></tr>`,
      '</tbody></table>');
  }
  out.push('</div>');
  return out.join('\n');
}

interface FlowStep { id: string; phase?: string; kind?: string }

function quarterBlock(c: Context): string {
  const flow = parse(readFileSync(join(APP_ROOT, 'processes/quarter-close.flow.yaml'), 'utf8')) as { phases: string[]; steps: FlowStep[] };
  const ids = new Set(flow.steps.map((s) => s.id));
  const missing = flow.steps.filter((s) => !c.site.quarter[s.id]).map((s) => s.id);
  const extra = Object.keys(c.site.quarter).filter((id) => !ids.has(id));
  if (missing.length) throw new HelpError(`help/${c.site.lang}/site.yaml: quarter needs words for the step(s) ${missing.join(', ')} of processes/quarter-close.flow.yaml`);
  if (extra.length) throw new HelpError(`help/${c.site.lang}/site.yaml: quarter names ${extra.join(', ')}, which processes/quarter-close.flow.yaml no longer has`);
  const out: string[] = [];
  for (const phase of flow.phases) {
    const steps = flow.steps.filter((s) => s.phase === phase);
    if (!steps.length) continue;
    if (!c.site.phases[phase]) throw new HelpError(`help/${c.site.lang}/site.yaml: phases.${phase} is missing`);
    out.push(`<h3>${escape(c.site.phases[phase])}</h3>`, '<ol class="steps">',
      ...steps.map((s) => `<li><strong>${inline(c.site.quarter[s.id].name)}</strong> ${inline(c.site.quarter[s.id].text)}</li>`), '</ol>');
  }
  return out.join('\n');
}

function contentsBlock(c: Context): string {
  return c.site.sections.map((s) => {
    const pages = c.site.pages.filter((p) => p.section === s.id && p.slug !== 'index');
    return `<h2 id="${anchor(s.title)}">${escape(s.title)}</h2>\n<ul class="contents">${pages.map((p) =>
      `<li><a href="${href(p.slug)}">${escape(p.title)}</a><span>${inline(p.summary)}</span></li>`).join('')}</ul>`;
  }).join('\n');
}

const BLOCKS: Record<string, (c: Context, arg?: string) => string> = {
  'vat-codes': vatCodesBlock,
  case: caseBlock,
  quarter: quarterBlock,
  contents: contentsBlock,
};

// ─── Pages ───────────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([a-z-]+)(?:\s+([^}\s]+))?\s*\}\}/g;

/** The page's Markdown with every value filled in and each block line replaced by a marker the renderer swaps for its HTML. */
function expand(c: Context, page: Page): string {
  const blocks: string[] = [];
  const lines: string[] = [];
  for (const line of page.source.split('\n')) {
    const block = /^\s*\{\{\s*([a-z-]+)(?:\s+([^}\s]+))?\s*\}\}\s*$/.exec(line);
    if (block && BLOCKS[block[1]]) {
      blocks.push(BLOCKS[block[1]](c, block[2]));
      lines.push(`\u0000${blocks.length - 1}`);
      continue;
    }
    lines.push(line.replace(PLACEHOLDER, (whole, name: string) => {
      if (BLOCKS[name]) throw new HelpError(`help/${c.site.lang}/${page.slug}.md: ${whole} is a block, it stands on a line of its own`);
      if (!VALUES[name]) throw new HelpError(`help/${c.site.lang}/${page.slug}.md: unknown placeholder ${whole} (values: ${Object.keys(VALUES).join(', ')}; blocks: ${Object.keys(BLOCKS).join(', ')})`);
      return VALUES[name]();
    }));
  }
  return markdown(lines.join('\n'), (l) => (l.startsWith('\u0000') ? blocks[Number(l.slice(1))] : undefined));
}

function layout(c: Context, page: Page, body: string): string {
  const nav = c.site.sections.map((s) => `<p>${escape(s.title)}</p><ul>${c.site.pages.filter((p) => p.section === s.id && p.slug !== 'index')
    .map((p) => `<li${p.slug === page.slug ? ' aria-current="page"' : ''}><a href="${href(p.slug)}">${escape(p.title)}</a></li>`).join('')}</ul>`).join('');
  const title = page.slug === 'index' ? c.site.title : `${page.title} · ${c.site.title}`;
  return `<!doctype html>
<html lang="${c.site.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(page.summary)}">
<link rel="stylesheet" href="../style.css">
</head>
<body>
<header><a class="home" href="${href('index')}">${escape(c.site.title)}</a></header>
<div class="frame">
<nav aria-label="${escape(c.word('contents'))}">${nav}</nav>
<main>
<h1>${escape(page.title)}</h1>
${body}
<footer><p>${escape(c.word('version').replace('{version}', VERSION))}</p></footer>
</main>
</div>
</body>
</html>
`;
}

/** Every file of the site, by its path under the output folder. */
export async function buildSite(root: string = HELP_DIR): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const langs = languages(root);
  for (const lang of langs) {
    const site = loadSite(lang, root);
    const ui = ((await import(`../../src/app/i18n/locales/${lang}.js`)) as { default: Locale }).default;
    const c = contextOf(site, ui);
    const slugs = new Set(site.pages.map((p) => p.slug));
    if (!slugs.has('index')) throw new HelpError(`help/${lang}/index.md is missing`);
    for (const page of site.pages) files.set(`${lang}/${page.slug}.html`, layout(c, page, expand(c, page)));
    for (const page of site.pages) {
      for (const m of files.get(`${lang}/${page.slug}.html`)!.matchAll(/href="([a-z0-9-]+)\.html(?:#([^"]*))?"/g)) {
        const target = files.get(`${lang}/${m[1]}.html`);
        if (!target) throw new HelpError(`help/${lang}/${page.slug}.md links to ${m[1]}, which is no page`);
        if (m[2] && !target.includes(` id="${m[2]}"`)) throw new HelpError(`help/${lang}/${page.slug}.md links to ${m[1]}#${m[2]}, which that page does not have`);
      }
    }
  }
  files.set('index.html', `<!doctype html>\n<html lang="${langs[0]}"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${langs[0]}/index.html"><title>Vanilla Accounting</title></head><body><a href="${langs[0]}/index.html">${langs[0]}</a></body></html>\n`);
  files.set('style.css', readFileSync(join(root, 'style.css'), 'utf8'));
  return files;
}

export async function writeSite(dir: string = OUT_DIR): Promise<number> {
  const files = await buildSite();
  rmSync(dir, { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return files.size;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = resolve(process.argv[2] ?? OUT_DIR);
  try {
    console.log(`wrote ${await writeSite(dir)} files to ${dir}`);
  } catch (e) {
    if (!(e instanceof HelpError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
