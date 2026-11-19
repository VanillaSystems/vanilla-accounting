/**
 * Artikel (docs/specs/invoicing.md 4.3, 4.4.3, 4.8): the products and services as one table
 * (layout A), an Artikel opened as the panel over it with its form, a new one in a dialog, the
 * picker «＋ Artikel» of a draft's sheet (a search by code or name), and the import from a CSV.
 */
import { useState } from 'react';
import { ARTICLE_FIELDS, type ArticleField, type ArticleImportRow } from '../../../invoices/article-import.js';
import { articleLine, documentsNaming, searchArticles } from '../../../invoices/articles.js';
import { ARTICLE_TYPES, DEFAULT_UNITS, VAT_KINDS, unitWord, type Article, type ArticleType, type Draft, type Prices, type VatKind } from '../../../invoices/model.js';
import { totals } from '../../../invoices/rules.js';
import { baseCurrency, chargesVat, invoiceActivities, rateOfKind } from '../../../engines/index.js';
import { localToday } from '../../../accounting/periods.js';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { api, errorText, type ArticleInput, type InvoiceList } from '../../lib/api.js';
import { fmt } from '../../lib/utils.js';
import { language, t } from '../../i18n/index.js';
import type { AreaProps, Nav } from '../index.js';
import { listed, setUi } from './state.js';
import { invoiceAt, saveDraft } from './actions.js';
import { reloadInvoices } from './data.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import { Frame, close } from './frame.js';
import { rowTab } from './Sent.js';
import { Search, Views } from './views.js';
import { contactOf } from './model.js';
import { insertLine } from './edit.js';
import { TableImport, type ImportKind } from './import-dialog.js';

type Props = AreaProps<RouteOf<'invoices'>>;

export const ARTICLE_TABS = ['all', 'goods', 'service', 'archived'] as const;
export type ArticleTab = (typeof ARTICLE_TABS)[number];

/** The Artikel of a tab, by code then name, searched by code, name, text and group. */
export function articleRows(articles: readonly Article[], q: string | undefined, tab: ArticleTab): Article[] {
  const needle = q?.trim().toLowerCase();
  return articles
    .filter((a) => (tab === 'archived' ? !!a.archived : !a.archived && (tab === 'all' || a.type === tab)))
    .filter((a) => !needle || [a.code, a.name, a.text, a.group].filter(Boolean).join(' ').toLowerCase().includes(needle))
    .sort((a, b) => (a.code ?? '￿').localeCompare(b.code ?? '￿') || a.name.localeCompare(b.name));
}

/** «reduziert · 2.6 %»: the kind and the percent it has today. */
const kindText = (k: VatKind) => (chargesVat() ? `${t(`articles.vat.${k}`)} · ${rateOfKind(k, localToday())} %` : t(`articles.vat.${k}`));

// ─── the table ──────────────────────────────────────────────────────────────────

export function ArticleTable(props: Props & { d: InvoiceList }) {
  const { route, query, nav, d, canEdit } = props;
  const ws = useWorkspace();
  const [tab, setTab] = useState<ArticleTab>('all');
  const rows = articleRows(d.articles, query.q, tab);
  listed.ids = rows.map((a) => a.id);
  const count = (x: ArticleTab) => articleRows(d.articles, undefined, x).length;
  const open = (id: string) => nav.select({ area: 'invoices', view: 'articles', id });
  const unit = (id: string | undefined) => (id ? unitWord(ws?.invoicing?.units, id, language() as 'de') : '');
  return (
    <div className="page ivtable" data-view="articles">
      <ListHead {...props} noPeriod>
        <div className="counts">
          <span>{t('articles.n', { n: count('all') })}</span>
          <Views on="articles" props={props} />
          <Search props={props} />
        </div>
      </ListHead>
      <div className="ivtabs" role="tablist" aria-label={t('articles.tabs')}>
        {ARTICLE_TABS.map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x} className={`${tab === x ? 'on' : ''}${x === 'archived' ? ' apart' : ''}`} data-tab={x} onClick={() => setTab(x)}>
            {t(`articles.tab.${x}`)} <span className="n mono">{count(x)}</span>
          </button>
        ))}
      </div>
      {canEdit && (
        <div className="ivfacts">
          <span>{t('articles.facts', { n: rows.length })}</span>
          <button type="button" className="quiet2" data-act="new-article" onClick={() => setUi({ dialog: { kind: 'article' } })}>{t('articles.new')}</button>
          <button type="button" className="quiet2" data-act="import-articles" onClick={() => setUi({ dialog: { kind: 'articleImport' } })}>{t('contacts.import')}</button>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="empty"><h2>{t(tab === 'archived' ? 'articles.noneArchived' : 'articles.none')}</h2><p>{t(tab === 'archived' ? 'articles.noneArchivedText' : 'articles.noneText')}</p></div>
      ) : (
        <div className="ivscroll">
          <table className="ivt atab" aria-label={t('invoices.view.articles')}>
            <thead>
              <tr>
                <th className="c-number">{t('articles.col.code')}</th><th>{t('articles.col.name')}</th><th>{t('articles.col.type')}</th>
                <th>{t('articles.col.unit')}</th><th className="num">{t('articles.col.price', { currency: baseCurrency() })}</th><th>{t('articles.col.vat')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, i) => {
                const sel = a.id === route.id;
                return (
                  <tr key={a.id} className={`trow${sel ? ' sel' : ''}`} data-id={a.id} aria-selected={sel} tabIndex={rowTab(sel, i, rows.some((x) => x.id === route.id))}
                    onClick={() => open(a.id)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(a.id); }}>
                    <td className="mono c-number">{a.code ?? ''}</td>
                    <td className="tt">{a.name}{a.group && <small>{a.group}</small>}</td>
                    <td>{t(`articles.type.${a.type}`)}</td>
                    <td>{unit(a.unit)}</td>
                    <td className="num mono">{fmt(a.price)}{a.prices === 'gross' && chargesVat() ? <small> {t('invoices.prices.gross')}</small> : null}</td>
                    <td>{kindText(a.vatKind)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── the form ───────────────────────────────────────────────────────────────────

type Form = { code: string; type: ArticleType; name: string; text: string; unit: string; price: string; prices: Prices; vatKind: VatKind; account: string; activity: '1' | '2'; group: string };

const formOf = (a: Article | undefined): Form => ({
  code: a?.code ?? '', type: a?.type ?? 'service', name: a?.name ?? '', text: a?.text ?? '', unit: a?.unit ?? '', price: a ? String(a.price) : '',
  prices: a?.prices ?? 'net', vatKind: a?.vatKind ?? (chargesVat() ? 'normal' : 'none'), account: a?.account ?? '', activity: a?.activity === 2 ? '2' : '1', group: a?.group ?? '',
});

const numberOf = (s: string): number | null => {
  const n = Number(s.replace(/[’'\s]/g, '').replace(',', '.'));
  return s.trim() && Number.isFinite(n) ? n : null;
};

function errorsOf(f: Form): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.name.trim()) e.name = t('customer.err.missing');
  if (f.price.trim() && numberOf(f.price) === null) e.price = t('invoices.errNumber');
  if (f.account.trim() && !/^\d{4}$/.test(f.account.trim())) e.account = t('contacts.err.account');
  if (f.code.trim().length > 30) e.code = t('articles.err.code');
  return e;
}

/** The request of the form: every field, an empty optional one as null (it clears what the Artikel had). */
const inputOf = (f: Form): ArticleInput => ({
  code: f.code.trim() || null, type: f.type, name: f.name.trim(), text: f.text.trim() || null, unit: f.unit || null, price: numberOf(f.price) ?? 0,
  prices: f.prices === 'gross' ? 'gross' : null, vatKind: f.vatKind, account: f.account.trim() || null, activity: f.activity === '2' ? 2 : null, group: f.group.trim() || null,
});

/** One form for a new Artikel (in a dialog) and a known one (in its panel). */
function ArticleForm({ article, nav, canEdit, onSaved }: { article?: Article; nav: Nav; canEdit: boolean; onSaved: (a: Article) => void }) {
  const ws = useWorkspace();
  const [f, setF] = useState<Form>(() => formOf(article));
  const [tried, setTried] = useState(false);
  const errors = tried ? errorsOf(f) : {};
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((was) => ({ ...was, [k]: v }));
  const units = ws?.invoicing?.units ?? DEFAULT_UNITS;
  const input = (k: 'code' | 'name' | 'text' | 'price' | 'account' | 'group', label: string, ph: string, cls: string, mono = false, autoFocus = false) => (
    <label key={k} className={`cf ${cls}${errors[k] ? ' err' : ''}`}>
      <span>{label}{errors[k] && <em>{errors[k]}</em>}</span>
      <input className={mono ? 'mono' : undefined} value={f[k]} placeholder={ph} disabled={!canEdit} onChange={(e) => set(k, e.target.value)} autoFocus={autoFocus} data-field={k} />
    </label>
  );
  async function save() {
    setTried(true);
    if (Object.keys(errorsOf(f)).length) return;
    try {
      const saved = article ? await api.patchArticle(article.id, inputOf(f)) : await api.createArticle(inputOf(f));
      await reloadInvoices();
      onSaved(saved);
    } catch (e) { nav.toast(errorText(e)); }
  }
  const activities = invoiceActivities();
  return (
    <AsyncForm className="ibody cform aform" data-testid="article-form" onSubmit={(e) => { e.preventDefault(); return save(); }} noValidate>
      {input('code', t('articles.code'), 'HM-1', 's2', true)}
      {input('name', t('articles.name'), t('articles.namePh'), 'w2', false, !article)}
      <div className="cf s2"><span>{t('articles.typeLabel')}</span>
        <span className="seg2" role="radiogroup" aria-label={t('articles.typeLabel')}>
          {ARTICLE_TYPES.map((x) => <button key={x} type="button" role="radio" data-type={x} aria-checked={f.type === x} className={f.type === x ? 'on' : ''} disabled={!canEdit} onClick={() => set('type', x)}>{t(`articles.type.${x}`)}</button>)}
        </span>
      </div>
      {input('text', t('articles.text'), t('articles.textPh'), 'w2')}
      <label className="cf s1"><span>{t('articles.col.unit')}</span>
        <select value={f.unit} disabled={!canEdit} data-field="unit" onChange={(e) => set('unit', e.target.value)}>
          <option value="">–</option>
          {units.map((u) => <option key={u.id} value={u.id}>{u[language() as 'de']}</option>)}
          {f.unit && !units.some((u) => u.id === f.unit) && <option value={f.unit}>{f.unit}</option>}
        </select>
      </label>
      {input('price', t('articles.price'), '0.00', 's1', true)}
      {chargesVat() ? (
        <div className="cf s2"><span>{t('articles.prices')}</span>
          <span className="seg2" role="radiogroup" aria-label={t('articles.prices')}>
            {(['net', 'gross'] as const).map((x) => <button key={x} type="button" role="radio" data-prices={x} aria-checked={f.prices === x} className={f.prices === x ? 'on' : ''} disabled={!canEdit} onClick={() => set('prices', x)}>{t(`invoices.prices.${x}`)}</button>)}
          </span>
        </div>
      ) : <span className="cf s2" />}
      <label className="cf s2"><span>{t('articles.vatKind')}</span>
        <select value={f.vatKind} disabled={!canEdit} data-field="vatKind" onChange={(e) => set('vatKind', e.target.value as VatKind)}>
          {VAT_KINDS.map((k) => <option key={k} value={k}>{kindText(k)}</option>)}
        </select>
      </label>
      {input('account', t('contacts.revenueAccount'), t('articles.accountPh', { account: ws?.invoicing?.revenueAccount ?? '' }), 's2', true)}
      {activities.length > 0 && (
        <label className="cf s2"><span>{t('articles.activity')}</span>
          <select value={f.activity} disabled={!canEdit} onChange={(e) => set('activity', e.target.value as '1' | '2')}>
            {activities.map((r, i) => <option key={i} value={String(i + 1)}>{r.label ?? `${i + 1}`} · {r.rate} %</option>)}
          </select>
        </label>
      )}
      {input('group', t('articles.group'), t('articles.groupPh'), 's2')}
      <p className="m w2 anote">{t('articles.vatNote')}</p>
      {canEdit && <p className="w2 aacts"><AsyncButton type="submit" className="btn primary" data-act="save-article">{article ? t('common.save') : t('articles.create')}</AsyncButton></p>}
    </AsyncForm>
  );
}

// ─── the panel and the dialog ───────────────────────────────────────────────────

export function ArticlePanel({ d, route, nav, canEdit }: Props & { d: InvoiceList }) {
  const a = d.articles.find((x) => x.id === route.id);
  if (!a) return <div className="detail-empty"><div>{route.id ? t('articles.gone') : t('invoices.noneSelected')}</div></div>;
  const docs = documentsNaming(d, a.id).sort((x, y) => y.date.localeCompare(x.date));
  async function remove() {
    try {
      const out = await api.removeArticle(a!.id);
      await reloadInvoices();
      if (out.outcome === 'archived') nav.toast(t('articles.archived', { name: a!.name }), () => { void restore(); });
      else { nav.toast(t('articles.deleted', { name: a!.name })); nav.go({ route: { area: 'invoices', view: 'articles' }, query: {} }); }
    } catch (e) { nav.toast(errorText(e)); }
  }
  async function restore() {
    try { await api.patchArticle(a!.id, { archived: false }); await reloadInvoices(); nav.toast(t('articles.restored', { name: a!.name })); } catch (e) { nav.toast(errorText(e)); }
  }
  return (
    <div className="detail-in cpanel" data-for={a.id}>
      <div className="head">
        <h2 className="who">{a.name}<small>{[a.code, t(`articles.type.${a.type}`), a.group].filter(Boolean).join(' · ')}</small></h2>
        <div className="amount"><small>{baseCurrency()}</small>{fmt(a.price)}</div>
      </div>
      <div className="facts"><span>{kindText(a.vatKind)}</span>{chargesVat() && <span>{t(`invoices.prices.${a.prices ?? 'net'}`)}</span>}</div>
      {a.archived && <p className="cnote" data-testid="article-archived">{t('articles.archivedNote')}</p>}
      {canEdit && (
        <div className="ivacts">
          {a.archived
            ? <AsyncButton type="button" className="btn ghost" data-act="restore-article" onClick={restore}>{t('contacts.restore')}</AsyncButton>
            : <AsyncButton type="button" className="btn ghost danger" data-act="remove-article" data-tip={t(docs.length ? 'articles.archiveTip' : 'articles.deleteTip')} onClick={remove}>{t(docs.length ? 'contacts.archive' : 'common.delete')}</AsyncButton>}
        </div>
      )}
      <div className="csecs">
        <section className="csec">
          <ArticleForm key={a.id} article={a} nav={nav} canEdit={canEdit && !a.archived} onSaved={(x) => nav.toast(t('articles.saved', { name: x.name }))} />
        </section>
        <section className="csec">
          <h3>{t('contacts.sec.documents')}</h3>
          <div className="ftab cinv">
            {docs.length ? docs.map((i) => (
              <button key={i.id} type="button" className="fr" onClick={() => nav.go(invoiceAt(i))}>
                <span className="mono">{i.status === 'issued' ? i.number : t('invoices.draft')}</span>
                <span>{t(`invoices.docKind.${i.kind}`)}</span>
                <span className="m">{contactOf(d, i)?.name ?? ''}</span>
                <span className="r mono">{i.kind === 'delivery-note' ? '' : `${i.currency} ${fmt(totals(i).gross)}`}</span>
              </button>
            )) : <p className="m">{t('articles.noDocuments')}</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

export function ArticleDialog({ nav, canEdit }: Props) {
  return (
    <Frame className="cdlg contact" label={t('articles.new')} title={t('articles.new')}
      foot={<><span style={{ flex: 1 }} /><button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button></>}>
      <ArticleForm nav={nav} canEdit={canEdit} onSaved={(a) => { close(); nav.go({ route: { area: 'invoices', view: 'articles', id: a.id }, query: {} }); nav.toast(t('articles.created', { name: a.name })); }} />
    </Frame>
  );
}

// ─── «＋ Artikel» on a draft ───────────────────────────────────────────────────

/** The most hits the picker lists; it names the rest. */
const PICK_LIMIT = 50;

/** A search by code or name; a pick puts the Artikel position after the position the person is in (`after`). */
export function ArticlePicker({ d, nav, draft, after }: Props & { d: InvoiceList; draft: Draft; after: number }) {
  const ws = useWorkspace();
  const [q, setQ] = useState('');
  const all = searchArticles(d.articles, q, Number.MAX_SAFE_INTEGER);
  const hits = all.slice(0, PICK_LIMIT);
  async function pick(a: Article) {
    const line = articleLine(a, draft, contactOf(d, draft), ws?.invoicing?.units);
    const { lines } = insertLine(draft.lines, line, after, t('invoices.newLine'));
    close();
    await saveDraft(nav, draft, { lines });
  }
  const unit = (id: string | undefined) => (id ? unitWord(ws?.invoicing?.units, id, language() as 'de') : '');
  return (
    <Frame className="apick" label={t('articles.pick')} title={t('articles.pickTitle')}
      foot={<><span className="m">{all.length > PICK_LIMIT ? t('articles.pickMore', { n: PICK_LIMIT, of: all.length }) : ''}</span><span style={{ flex: 1 }} /><button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button></>}>
      <div className="ibody">
        <input type="search" className="apq" autoFocus value={q} placeholder={t('articles.pickPh')} data-testid="article-search"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { e.preventDefault(); void pick(hits[0]); } }} />
        {hits.length ? (
          <div className="ftab apl">
            {hits.map((a) => (
              <button key={a.id} type="button" className="fr" data-pick={a.id} onClick={() => { void pick(a); }}>
                <span className="mono">{a.code ?? ''}</span>
                <span>{a.name}</span>
                <span className="m">{[unit(a.unit), kindText(a.vatKind)].filter(Boolean).join(' · ')}</span>
                <span className="r mono">{fmt(a.price)}</span>
              </button>
            ))}
          </div>
        ) : <p className="m">{t(d.articles.some((a) => !a.archived) ? 'articles.pickNone' : 'articles.pickEmpty')}</p>}
      </div>
    </Frame>
  );
}

// ─── the import ─────────────────────────────────────────────────────────────────

export function ArticleImportDialog({ nav }: Props) {
  const kind: ImportKind<ArticleImportRow> = {
    label: t('contacts.import'), title: t('articles.importTitle'), text: t('articles.importText'),
    fields: ARTICLE_FIELDS, fieldLabel: (k) => t(`articles.field.${k as ArticleField}`),
    preview: (csv, map) => api.previewArticleImport(csv, map),
    run: (csv, map, choices) => api.importArticles(csv, map, choices),
    done: (n, skipped) => t('articles.imported', { n, skipped }),
    count: (n, of) => t('articles.importCount', { n, of }),
    runLabel: (n) => t('articles.importRun', { n }),
    columns: [
      [t('articles.col.code'), (r) => <span className="mono">{r.article?.code ?? ''}</span>],
      [t('articles.col.name'), (r) => r.article?.name ?? '–'],
      [t('articles.col.price', { currency: baseCurrency() }), (r) => (r.article ? fmt(r.article.price) : '')],
      [t('articles.col.vat'), (r) => (r.article ? kindText(r.article.vatKind) : '')],
    ],
    notes: (r) => <>
      {r.problems.map((p) => t(`articles.problem.${p}`)).join(' · ')}
      {r.same && <span data-testid="import-same">{r.problems.length ? ' · ' : ''}{t('articles.same', { name: r.same.name, where: 'line' in r.same ? t('contacts.sameRow', { line: r.same.line }) : t('contacts.sameContact') })}</span>}
    </>,
    blocked: (r) => !r.article || r.problems.some((p) => p === 'name' || p === 'price'),
    hasSame: (r) => !!r.same,
    newWord: t('articles.choice.new'),
  };
  return <TableImport kind={kind} nav={nav} />;
}
