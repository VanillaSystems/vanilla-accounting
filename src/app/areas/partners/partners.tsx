/**
 * Geschäftspartner (docs/0.4.0/knowledge.md): the businesses the company works with, one page
 * each, prose first. The list filters by role and «Offen» (open questions); a page shows the open
 * questions, the notes, the rules the app carries out for the partner, what the open year's books
 * hold for it (each a link), and, folded, how the app recognises it and what its files say.
 */
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { moveKey } from '../../shell/keyboard.js';
import { ListHead } from '../../shell/ListHead.js';
import type { Location, RouteOf } from '../../shell/route.js';
import type { PartnerDetail, PartnerRow } from '../../../knowledge/partners.js';
import type { Role } from '../../../knowledge/counterparties.js';
import type { QuestionTarget } from '../../../questions/model.js';
import { totals } from '../../../invoices/rules.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { Kbd } from '../receipts/commands.js';
import { at } from '../receipts/view.js';
import { entryAt } from '../vat/links.js';
import { invoiceAt } from '../invoices/actions.js';
import { useInvoices } from '../invoices/data.js';
import { countOf, FILTERS, linkedOf, partnerRules, passes, type PartnerFilter } from './model.js';
import { once, readPartners, refreshKnowledge, useFetched } from './data.js';
import { ChangedNotePrompt, DetailGroup, DetailsBlock, Go, linesOf, NoteRulePanel, NotesBlock, SelfBlock } from './page.js';
import { noteMarks } from '../../../knowledge/note-rules.js';

type Props = AreaProps<RouteOf<'partners'>>;

export const readRules = once('rules', api.rules);

/** The list's filter, kept while the app runs; the rows as last shown, in ↑↓ order, for the keys and ⌘K. */
const ui = { filter: 'all' as PartnerFilter, ids: [] as string[], rows: [] as PartnerRow[] };
const uiListeners = new Set<() => void>();
let uiVersion = 0;
const setFilter = (f: PartnerFilter) => { ui.filter = f; uiVersion++; uiListeners.forEach((l) => l()); };
const useUi = () => { useSyncExternalStore((fn) => { uiListeners.add(fn); return () => { uiListeners.delete(fn); }; }, () => uiVersion); return ui; };

const roleWord = (r: Role) => t(`partners.role.${r}`);
const roleLine = (p: PartnerRow) => [p.role, ...p.roles].map(roleWord).join(' · ');

function List({ route, query, period, books, nav, canEdit }: Props) {
  const load = useFetched('partners', readPartners);
  const s = useUi();
  const rows = load.state === 'ready' ? load.data.partners : [];
  const shown = rows.filter((p) => passes(p, s.filter, query.q));
  ui.rows = rows;
  ui.ids = shown.map((p) => p.id);
  useEffect(() => {
    if (!route.id && shown[0]) nav.select({ area: 'partners', id: shown[0].id });
  }, [route.id, shown[0]?.id]);

  return (
    <div className="page kw">
      <ListHead period={period} books={books} canEdit={canEdit}>
        <div className="counts" role="tablist" aria-label={t('partners.filters')}>
          {FILTERS.filter((f) => f === 'all' || f === s.filter || countOf(rows, f) > 0).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={s.filter === f} className={s.filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              <span className="n">{countOf(rows, f)}</span>{t(`partners.filter.${f}`)}
            </button>
          ))}
          <label className="search">
            {ICONS.search}
            <span className="sr">{t('partners.search')}</span>
            <input type="search" placeholder={t('shell.search')} value={query.q ?? ''} className={query.q ? 'has' : ''} autoComplete="off"
              onChange={(e) => nav.setQuery({ q: e.target.value || undefined })}
              onKeyDown={(e) => { if (e.key === 'Escape') nav.setQuery({ q: undefined }); }} />
            <Kbd keys={['/']} tip={t('partners.search')} />
          </label>
        </div>
      </ListHead>
      {load.state === 'loading' ? <p className="m kwnone">{t('partners.loading')}</p>
        : load.state === 'failed' ? <p className="warnline">{load.error}</p>
          : !rows.length ? <div className="empty"><p className="m">{t('partners.none')}</p></div>
            : !shown.length ? <p className="m kwnone">{t('partners.noMatch')}</p>
              : (
                <div className="rows" role="listbox" aria-label={t('area.partners')}>
                  {shown.map((p) => <Row key={p.id} p={p} sel={p.id === route.id} onPick={() => nav.select({ area: 'partners', id: p.id })} />)}
                </div>
              )}
    </div>
  );
}

function Row({ p, sel, onPick }: { p: PartnerRow; sel: boolean; onPick(): void }) {
  return (
    <div className={`row kwrow${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-partner={p.id} onClick={onPick}>
      <span className="t">{p.name}<small> {roleLine(p)}</small></span>
      <span className="a">{p.open ? <span className="kwop">{t('partners.openN', { n: p.open })}</span> : null}</span>
      <span className="kwks">
        {p.notes ? <span className="kwk">{t('partners.chip.notes')}</span> : null}
        {p.rules ? <span className="kwk">{t('partners.chip.rules')} <b className="mono">{p.rules}</b></span> : null}
        {p.entries.length ? <span className="kwk">{t('partners.chip.entries')} <b className="mono">{p.entries.length}</b></span> : null}
        {p.invoices.length ? <span className="kwk">{t('partners.chip.invoices')} <b className="mono">{p.invoices.length}</b></span> : null}
        {p.layers.app ? <span className="kwk app">{t('partners.chip.app')}</span> : null}
      </span>
    </div>
  );
}

const SHOWN = 5;

/** A group of what the books hold for the partner: its count, the newest rows, «und n weitere». */
function LinkGroup<T>({ title, rows, item, empty }: { title: string; rows: T[]; item(x: T): ReactElement; empty: string }) {
  return (
    <div className="kwlink-g">
      <h4>{title}<span className="n">{rows.length}</span></h4>
      {rows.length ? <ul>{rows.slice(0, SHOWN).map(item)}</ul> : <span className="m">{empty}</span>}
      {rows.length > SHOWN ? <span className="m">{t('partners.linked.more', { n: rows.length - SHOWN })}</span> : null}
    </div>
  );
}

/** Where a question's object is: a payment in its statement, a receipt, a booking. */
const targetAt = (on: QuestionTarget, props: Props): Location => {
  const { books, period } = props;
  if (on.kind === 'payment') return at({ area: 'bank', payment: on.id }, books.transactions.find((x) => x.ref === on.id)?.date, period);
  if (on.kind === 'receipt') return at({ area: 'receipts', id: on.id }, books.receipts.find((x) => x.id === on.id)?.date, period);
  const e = (books.journalEntries ?? []).find((x) => x.id === on.id);
  return e ? entryAt(e, period) : { route: { area: 'journal', id: on.id }, query: {} };
};

function Detail(props: Props) {
  const { route, books, period, nav, canEdit } = props;
  const id = route.id ?? '';
  const load = useFetched(`partner:${id}`, () => api.partner(id));
  const rules = useFetched('rules', readRules);
  const invoices = useInvoices();
  const [proposing, setProposing] = useState<{ id: string; sentence: string }>();
  if (!route.id) return <div className="detail-empty"><div>{t('partners.select')}</div></div>;
  if (load.state === 'loading') return <div className="detail-empty"><div>{t('partners.loading')}</div></div>;
  if (load.state === 'failed') return <div className="detail-empty"><div>{load.error}</div></div>;
  const d: PartnerDetail = load.data;
  const p = d.row;
  const linked = linkedOf(p, books);
  const lines = rules.state === 'ready' ? partnerRules(linesOf(rules.data), p.id) : [];
  const invs = invoices.state === 'ready' ? invoices.data.invoices.filter((i) => p.invoices.includes(i.id)).sort((a, b) => b.date.localeCompare(a.date)) : [];
  const year = d.year;
  const newestPayment = linked.payments[0]?.ref;
  // A sentence of the notes a rule switched on carries out is marked; one the person changed asks «Regel anpassen?».
  const { marked, changed } = noteMarks(d.note?.text ?? '', lines.map((l) => l.row));
  const marks = marked.map((row) => ({ row, line: lines.find((l) => l.row === row)!.line }));
  const notes = d.note?.path ?? d.files[0] ?? '';
  const view = rules.state === 'ready' ? rules.data : undefined;
  // Only a partner with a file of its own can hold a rule: an invoice customer without one cannot.
  const propose = view && d.files.length ? (sentence: string) => setProposing({ id: p.id, sentence }) : undefined;
  const sentence = proposing?.id === p.id ? proposing.sentence : undefined;

  return (
    <div className="detail-in kw" data-for={p.id}>
      <div className="head"><h2 className="who">{p.name}<small>{[roleLine(p), p.payments.length ? t('partners.paymentsIn', { n: p.payments.length, year }) : ''].filter(Boolean).join(' · ')}</small></h2></div>
      <div className="docbody">
        {d.questions.map((q) => (
          <div key={q.id} className="kwq">
            <b>{q.text}</b>
            <span className="m">{t('partners.questions.asked', { date: formatDate(q.askedAt.slice(0, 10)) })} · <Go className="linkbtn" nav={nav} to={targetAt(q.on, props)}>{t(`partners.questions.on.${q.on.kind}`)}</Go></span>
          </div>
        ))}
        <NotesBlock key={`${p.id}:${d.note?.basis ?? 'none'}`} note={d.note} target={{ kind: 'partner', id: p.id }} canEdit={canEdit} nav={nav} empty={t(p.role === 'customer' ? 'partners.notes.emptyCustomer' : 'partners.notes.empty')} marks={marks} propose={propose} />
        <SelfBlock lines={lines} canEdit={canEdit} nav={nav} empty={t('partners.self.none')} changed={canEdit && view ? changed : []}
          adjust={(c) => view && <ChangedNotePrompt key={`${c.row.id}:${c.now ?? ''}`} c={c} partner={p.id} name={p.name} notes={notes} view={view} nav={nav} />}>
          {view && sentence ? <NoteRulePanel key={sentence} partner={p.id} name={p.name} notes={notes} sentence={sentence} view={view} nav={nav} onClose={() => setProposing(undefined)} /> : null}
          {canEdit && newestPayment ? (
            <p className="kwnewrule"><Go className="linkbtn" nav={nav} to={{ route: { area: 'company', section: 'rules' }, query: { payment: newestPayment } }}>{t('partners.self.newRule')}</Go></p>
          ) : null}
        </SelfBlock>
        <section className="kwsec">
          <header><h3>{t('partners.linked.title')}</h3><span className="m">{t('partners.linked.lead', { year })}</span>
            {p.layers.customer ? <Go className="linkbtn" nav={nav} to={{ route: { area: 'invoices', view: 'customers', id: p.id }, query: {} }}>{t('partners.linked.customer')}</Go> : null}
          </header>
          <div className="kwlinked">
            <LinkGroup title={t('partners.linked.entries')} rows={linked.entries} empty={t('partners.linked.none', { year })} item={(e) => (
              <li key={e.id}><Go nav={nav} to={entryAt(e, period)}><span className="mono">{formatDate(e.date)}</span> {e.description ?? `${e.accountDebit || '–'} / ${e.accountCredit || '–'}`}</Go><span className="mono">{fmt(e.amount)}</span></li>
            )} />
            <LinkGroup title={t('partners.linked.receipts')} rows={linked.receipts} empty={t(p.role === 'customer' ? 'partners.linked.noReceiptsCustomer' : 'partners.linked.none', { year })} item={(r) => (
              <li key={r.id}><Go nav={nav} to={at({ area: 'receipts', id: r.id }, r.date, period)}><span className="mono">{formatDate(r.date)}</span> {r.description ?? r.originalFilename}</Go><span className="mono">{r.amount !== undefined ? fmt(r.amount) : ''}</span></li>
            )} />
            <LinkGroup title={t('partners.linked.payments')} rows={linked.payments} empty={t('partners.linked.none', { year })} item={(x) => (
              <li key={x.ref}><Go nav={nav} to={at({ area: 'bank', payment: x.ref }, x.date, period)}><span className="mono">{formatDate(x.date)}</span> {x.counterparty ?? x.description}</Go><span className="mono">{x.direction === 'DBIT' ? '−' : ''}{fmt(x.amount)}</span></li>
            )} />
            {p.layers.customer || invs.length ? (
              <LinkGroup title={t('partners.linked.invoices')} rows={invs} empty={t('partners.linked.none', { year })} item={(i) => (
                <li key={i.id}><Go nav={nav} to={invoiceAt(i, period)}><span className="mono">{i.status === 'issued' ? i.number : t('invoices.draft')}</span> {i.subject ?? ''}</Go><span className="mono">{fmt(totals(i.lines).gross)}</span></li>
              )} />
            ) : null}
          </div>
        </section>
        <PartnerDetails d={d} canEdit={canEdit} nav={nav} />
      </div>
    </div>
  );
}

/** A merchant name the partner's file learned from confirmed links (#190): marked, and a person may take it out for good. */
function LearnedName({ partner, name, canEdit, nav }: { partner: string; name: string; canEdit: boolean; nav: Props['nav'] }) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api.removeLearnedName(partner, name);
      refreshKnowledge();
      nav.toast(t('partners.match.removed', { name }));
    } catch (e) {
      nav.toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {t('partners.match.tx')} <span className="mono">{name}</span> <span className="m">{t('partners.match.learned')}</span>
      {canEdit ? <> <button type="button" className="linkbtn" disabled={busy} data-tip={t('partners.match.removeTip')} onClick={remove}>{t('partners.match.remove')}</button></> : null}
    </>
  );
}

function PartnerDetails({ d, canEdit, nav }: { d: PartnerDetail; canEdit: boolean; nav: Props['nav'] }) {
  const mono = (s: string) => <span className="mono">{s}</span>;
  const learned = new Set(d.learned);
  const signals = (['uid', 'iban', 'domain', 'tx', 'file'] as const).flatMap((k) => d.match[k].map((v) => (k === 'tx' && learned.has(v)
    ? <LearnedName partner={d.row.id} name={v} canEdit={canEdit} nav={nav} />
    : <>{t(`partners.match.${k}`)} {mono(v)}</>)));
  const appNotes = d.fileNotes.filter((n) => n.layer === 'app');
  const ownNotes = d.fileNotes.filter((n) => n.layer === 'workspace');
  const note = (n: PartnerDetail['fileNotes'][number]) => <>{n.when ? `${n.when} → ` : ''}{n.then}</>;
  return (
    <DetailsBlock lead={t('partners.details.lead')}>
      {!d.files.length ? <p>{t('partners.details.onlyCustomer')}</p> : null}
      <DetailGroup title={t('partners.details.match')} items={signals} />
      <DetailGroup title={t('partners.details.documents')} items={d.documents.map((x) => <>{mono(x.id)} · {x.kind}</>)} />
      <DetailGroup title={t('partners.details.accounts')} items={d.accounts?.length ? [mono(d.accounts.join(', '))] : []} />
      <DetailGroup title={t('partners.details.notes')} items={ownNotes.map(note)} />
      <DetailGroup title={t('partners.details.fromApp')} items={[...appNotes.map(note), ...d.facts.map((f) => <>{f.fact}</>)]} quiet />
      <DetailGroup title={t('partners.details.files')} items={[...d.files.map(mono), ...(d.note ? [mono(d.note.path)] : []), ...(d.cases ? [t('partners.details.cases', { n: d.cases })] : [])]} />
    </DetailsBlock>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('keys.selectTip')],
  [['/'], t('keys.search'), t('partners.search')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const partners: Area<RouteOf<'partners'>> = {
  id: 'partners',
  label: () => t('area.partners'),
  dock: { key: 'p', icon: ICONS.partners, tip: () => t('area.partners.tip') },
  List,
  Detail,
  legend,
  periodless: true,
  title: (r) => (r.id ? ui.rows.find((p) => p.id === r.id)?.name ?? r.id : undefined),
  palette: ({ nav }) => ui.rows.map((p) => ({ label: p.name, side: roleLine(p), run: () => nav.go({ route: { area: 'partners', id: p.id }, query: {} }) })),
  keys(e, p) {
    const d = moveKey(e);
    if (d) {
      const i = p.route.id ? ui.ids.indexOf(p.route.id) : -1;
      const next = ui.ids[Math.min(ui.ids.length - 1, Math.max(0, i + d))];
      if (next) p.nav.select({ area: 'partners', id: next });
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === 'Escape' && p.query.q) { p.nav.setQuery({ q: undefined }); return true; }
    return false;
  },
};

