/**
 * Belege: the receipts of a period, what needs you first, then month by month; the receipt with
 * its paper, its payment, its details and its file on the right (the mockup's Belege).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { QuarantinedFile } from '../../../types/drop.js';
import { api, errorText } from '../../lib/api.js';
import type { InboxFile } from '../../../types/index.js';
import type { RouteOf } from '../../shell/route.js';
import { knownChips, type Chip } from '../../shell/chips.js';
import { ChipEmpty, ChipFilter, chipWords } from '../../shell/ChipFilter.js';
import { usePartnerIndex } from '../partners/data.js';
import { receiptFields } from './filter.js';
import { ListHead } from '../../shell/ListHead.js';
import { moveKey } from '../../shell/keyboard.js';
import { useFx } from '../../hooks/use-fx.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { periodName, monthName } from '../../lib/period-label.js';
import { fmt, formatAmount, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { COUNTED, badgeCount, chfOf, groups, isOpen, statesOf, suggestion, visible, type Candidate, type GroupKey, type ReceiptView } from './model.js';
import { pollInbox, setUi, toggleGroup, ui, useUi } from './state.js';
import { at, ledgerFor, listed, noneText } from './view.js';
import { Kbd, accept, runAct, type Act } from './commands.js';
import { intakeAdd } from './intake.js';
import { startIntake, useIntakeRunning } from '../../automation/intake.js';
import { useAutomation } from '../../automation/store.js';
import { processingText } from '../../automation/processing.js';
import { inProcess, type Processing } from '../../../workflows/processing.js';
import type { AutomationView } from '../../../workflows/model.js';
import { Detail } from './Detail.js';
import { I } from './icons.js';
import { EmptyTable, FirstRun, Strip } from './InflowStrip.js';
import { InflowDialogs } from './InflowDialogs.js';
import { ConfirmDiscard, askDiscard } from './Discard.js';
import './receipts.css';
import { useSelectionFollowsRows } from '../../hooks/use-selection-follows-rows.js';
import { baseCurrency } from '../../../engines/index.js';
import { Pick } from '../../selection/Pick.js';
import { SelectionView } from '../../selection/SelectionView.js';
import { receiptRows } from '../../selection/rows.js';
import { clickRow, useSelection, useShown } from '../../selection/store.js';

type Props = AreaProps<RouteOf<'receipts'>>;

const COUNT_LABEL = { linked: 'receipts.filterLinked', open: 'receipts.filterOpen', noDate: 'receipts.filterNoDate' } as const;


/** No receipt in the books and none on its way: the page shows the ways in instead of a list. */
const noReceiptsYet = (books: AreaProps['books'], inbox: readonly InboxFile[]) => books.receipts.length === 0 && inbox.length === 0;

const groupLabel = (key: GroupKey) =>
  key === 'working' ? t('receipts.groupWorking') : key === 'need' ? t('receipts.groupNeed') : key === 'noDate' ? t('receipts.noDate') : monthName(`${key.slice(6)}-01`);

function List(props: Props) {
  const { route, query, period, books, nav, canEdit } = props;
  const s = useUi();
  const { view } = useAutomation();
  const { rates } = useFx();
  const l = ledgerFor(books);
  const toChf = useMemo(() => chfOf(rates), [rates]);
  const accounts = useWorkspace()?.bankAccounts;
  const partners = usePartnerIndex();
  const fields = useMemo(() => receiptFields(l, partners, chipWords), [l, partners]);
  const chips = useMemo(() => knownChips(query.chips ?? [], fields), [query.chips, fields]);
  const setChips = (next: Chip[]) => nav.setQuery({ chips: next.length ? next : undefined });
  const states = statesOf(chips);
  const { rows, counts, hidden, candidates, pool } = useMemo(() => visible(l, period, chips, query.q, accounts ?? [], fields), [l, period, chips, query.q, accounts, fields]);
  const suggestions = useMemo(() => {
    const out = new Map<string, Candidate>();
    for (const v of rows) { const c = suggestion(v, l, toChf); if (c) out.set(v.r.id, c); }
    return out;
  }, [rows, l, toChf]);
  const { groups: gs, later } = groups(rows, l, states.has('noDate'), (v) => suggestions.has(v.r.id));
  const inbox = period.to >= l.openFrom && !chips.length && !query.q ? s.inbox.filter((f) => !l.byId.has(f.id)) : [];
  // A file still being read is in processing (#218); one that could not be read needs you.
  const pending = inbox.filter((f) => !f.failed);
  const failed = inbox.filter((f) => f.failed);
  const busy = gs.find((g) => g.key === 'working');
  const need = gs.find((g) => g.key === 'need');
  const rest = gs.filter((g) => g !== busy && g !== need);
  const workingKey: GroupKey = 'working';
  const needKey: GroupKey = 'need';
  /** A count is a shortcut to the one state chip it names; «alle» takes the state chips away. */
  const onlyState = states.size === 1 ? [...states][0] : undefined;
  const countTo = (state?: string) => setChips([...chips.filter((c) => c.field !== 'state'), ...(state ? [{ field: 'state', value: state }] : [])]);
  const filed = !!l.closedThrough && period.kind !== 'all' && period.to <= l.closedThrough;
  const firstRun = canEdit && noReceiptsYet(books, s.inbox);

  const ids = [
    ...(s.collapsed.has(workingKey) ? [] : [...pending.map((f) => f.id), ...(busy?.rows ?? []).map((v) => v.r.id)]),
    ...(s.collapsed.has(needKey) ? [] : [...failed.map((f) => f.id), ...(need?.rows ?? []).map((v) => v.r.id)]),
    ...rest.filter((g) => !s.collapsed.has(g.key)).flatMap((g) => g.rows.map((v) => v.r.id)),
    ...(s.showLater ? later.map((v) => v.r.id) : []),
    ...(s.showHidden ? hidden.map((v) => v.r.id) : []),
  ];
  listed.ids = ids;
  listed.suggestions = suggestions;
  const picked = useSelection('receipt');
  useShown('receipt', ids.filter((id) => l.byId.has(id)));
  const pickedIds = new Set(picked?.ids);

  useEffect(() => { pollInbox(nav.refresh); }, [nav]);

  // A list with nothing selected selects its first row; a link to a receipt of another period opens that period (urls.md rule 1).
  const seen = useRef<string>();
  useEffect(() => {
    if (!route.id) { if (ids[0]) nav.select({ area: 'receipts', id: ids[0] }); return; }
    if (seen.current === route.id) return;
    seen.current = route.id;
    const v = l.byId.get(route.id);
    if (v && !ids.includes(route.id) && !query.period && v.day && (v.day < period.from || v.day > period.to)) nav.go(at(route, v.day));
  }, [route.id, ids[0], l]);

  const select = (id: string) => nav.select({ area: 'receipts', id });
  useSelectionFollowsRows(route.id, ids, select);
  const row = (v: ReceiptView, same: boolean) => (
    <Row key={v.r.id} v={v} proc={l.processing.get(v.r.id)} view={view} sel={!picked && v.r.id === route.id} picked={pickedIds.has(v.r.id)} same={same} canEdit={canEdit} onSelect={select}
      onClick={(e) => clickRow(e, 'receipt', v.r.id, route.id, select, nav.toast)} toast={nav.toast} onAct={(a) => runAct(props, a, v.r.id)} />
  );
  /** Rows of one group: a row of the same day as the one above names its date only for screen readers. */
  const dated = (rows: ReceiptView[]) => { let prev: string | undefined; return rows.map((v) => { const same = !!v.date && v.date === prev; prev = v.date; return row(v, same); }); };

  return (
    <div className="page">
      <ListHead period={period} books={books} canEdit={canEdit}>
        <div className="counts" role="tablist" aria-label={t('receipts.filters')}>
          {counts.all > 0 ? (
            <>
              <button type="button" role="tab" aria-selected={!states.size} className={states.size ? '' : 'on'} onClick={() => countTo()}>
                <span className="n">{counts.all}</span>{t('receipts.filterAll')}
              </button>
              {COUNTED.filter((f) => counts[f] > 0 || onlyState === f).map((f) => (
                <button key={f} type="button" role="tab" aria-selected={onlyState === f} className={onlyState === f ? 'on' : ''} data-filter={f} onClick={() => countTo(f)}>
                  <span className="n">{counts[f]}</span>{t(COUNT_LABEL[f])}
                </button>
              ))}
            </>
          ) : <span>{filed ? t('receipts.filedReadOnly') : t('receipts.stillEmpty')}</span>}
          {canEdit && <RunInbox />}
        </div>
        <ChipFilter fields={fields} rows={pool} chips={chips} onChips={setChips} q={query.q} onQ={(q) => nav.setQuery({ q })}
          searchLabel={t('receipts.searchLabel')} searchKey={<Kbd keys={['/']} tip={t('receipts.searchTip')} />} />
      </ListHead>

      {canEdit && !firstRun && <Strip {...props} />}
      {firstRun ? <FirstRun {...props} /> : counts.all === 0 && hidden.length === 0 && pending.length === 0 ? (
        <div className="empty">
          <h2>{t('receipts.emptyTitle', { period: periodName(period) })}</h2>
          <p>{t('receipts.emptyText')}</p>
        </div>
      ) : rows.length === 0 && pending.length === 0 ? (
        states.size === 1 && states.has('quarantine') ? null
          : chips.length && candidates.length ? <ChipEmpty fields={fields} rows={candidates} chips={chips} onChips={setChips} />
          : query.q ? (
            <div className="empty"><h2>{t('receipts.nothingFound')}</h2><p>{t('receipts.nothingFoundText', { q: query.q })}</p></div>
          ) : (
            <div className="empty">
              <h2>{t('receipts.none')}</h2>
              <p>{t('receipts.allLinkedText')}</p>
            </div>
          )
      ) : (
        <div className={`rows${picked ? ' picking' : ''}`} role="listbox" aria-multiselectable="true" aria-label={t('area.receipts')}>
          {(pending.length > 0 || busy) && (
            <GroupHead k={workingKey} n={pending.length + (busy?.rows.length ?? 0)}>
              {pending.map((f) => <PendingRow key={f.id} file={f} proc={l.processing.get(f.id)} view={view} sel={f.id === route.id} onSelect={select} />)}
              {busy?.rows.map((v) => row(v, false))}
            </GroupHead>
          )}
          {(failed.length > 0 || need) && (
            <GroupHead k={needKey} n={failed.length + (need?.rows.length ?? 0)}>
              {failed.map((f) => <PendingRow key={f.id} file={f} sel={f.id === route.id} onSelect={select} />)}
              {need && dated(need.rows)}
            </GroupHead>
          )}
          {rest.map((g) => <GroupHead key={g.key} k={g.key} n={g.rows.length}>{dated(g.rows)}</GroupHead>)}
          {later.length > 0 && (
            <>
              <div className="hidden-note">
                {t('receipts.laterNote', { n: later.length })} · <button type="button" onClick={() => setUi({ showLater: !s.showLater })}>{s.showLater ? t('receipts.hide') : t('receipts.show')}</button>
              </div>
              {s.showLater && later.map((v) => row(v, false))}
            </>
          )}
        </div>
      )}
      {hidden.length > 0 && (
        <>
          <div className="hidden-note">
            {!s.showHidden && `${t('receipts.hiddenNote', { n: hidden.length })} · `}
            <button type="button" data-testid="toggle-hidden" onClick={() => setUi({ showHidden: !s.showHidden })}>{s.showHidden ? t('receipts.hideAgain') : t('receipts.show')}</button>
          </div>
          {s.showHidden && (
            <>
            <p className="m hidden-lead" data-testid="hidden-lead">{t('receipts.hiddenLead')}</p>
            <div className={`rows${picked ? ' picking' : ''}`} role="listbox" aria-multiselectable="true" aria-label={t('receipts.notReceipts')}>
              {hidden.map((v) => row(v, false))}
            </div>
            </>
          )}
        </>
      )}
      <Quarantine nav={nav} canEdit={canEdit} asked={states.has('quarantine')} />
      <ConfirmDiscard from="hidden" nav={nav} />
      <InflowDialogs {...props} />
    </div>
  );
}

/** A group of the list: its head folds it, its rows show while it is open. */
function GroupHead({ k, n, children }: { k: GroupKey; n: number; children: React.ReactNode }) {
  const shut = useUi().collapsed.has(k);
  return (
    <>
      <button type="button" className={`group${shut ? ' shut' : ''}`} aria-expanded={!shut} data-group={k} data-tip={shut ? t('receipts.expand') : t('receipts.collapse')} onClick={() => toggleGroup(k)}>
        <span>{I.gch}{groupLabel(k)}</span><span className="mono">{n}</span>
      </button>
      {!shut && children}
    </>
  );
}

function Row({ v, proc, view, sel, picked, same, canEdit, onSelect, onClick, toast, onAct }: { v: ReceiptView; proc?: Processing; view?: AutomationView; sel: boolean; picked: boolean; same: boolean; canEdit: boolean; onSelect(id: string): void; onClick(e: React.MouseEvent): void; toast(msg: string): void; onAct(a: Act): void }) {
  const { r } = v;
  const act = (run: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); onSelect(r.id); run(); };
  const edit = canEdit && !v.locked;
  return (
    <div
      className={`row${sel ? ' sel' : ''}${picked ? ' picked' : ''}${v.none ? ' nonreceipt' : ''}${inProcess(proc) ? ' working' : ''}`}
      role="option"
      aria-selected={sel || picked}
      tabIndex={sel ? 0 : -1}
      data-id={r.id}
      onClick={onClick}
    >
      <Pick kind="receipt" id={r.id} on={picked} label={v.vendor || r.filename} toast={toast} />
      <span className="d mono">{same ? <span className="sr">{formatDate(v.date)}</span> : v.date ? <><span className="dl">{formatDate(v.date)}</span><span className="ds">{formatDate(v.date).slice(0, 6)}</span></> : <span className="d none">{t('receipts.noDate')}</span>}</span>
      <span className="t">{inProcess(proc) ? <span className="spin small" aria-hidden="true" /> : isOpen(v) && !v.locked && !v.none && I.dot}{v.vendor}{v.desc && <small> {v.desc}</small>}{inProcess(proc) && <small className="proc" data-testid="row-processing"> · {processingText(proc, view)}</small>}{v.none && <small className="nonewhy" data-testid="none-why" data-by={v.noneBy} data-tip={noneText(v)}> · {noneText(v)}</small>}</span>
      <span className="a mono">{r.amount != null && <>{(r.currency ?? baseCurrency()) !== baseCurrency() && <span className="c">{r.currency}</span>}{fmt(r.amount)}</>}</span>
      <span className="acts">
        {v.none ? (
          canEdit && (
            <>
              <button type="button" aria-label={t('receipts.isReceipt')} onClick={act(() => onAct('mark'))}>{I.check}</button>
              {!v.locked && <button type="button" className="del" data-testid="discard" data-tip={t('receipts.discard')} aria-label={t('receipts.discard')} onClick={act(() => askDiscard({ from: 'hidden', files: [{ id: r.id, file: r.filename }] }))}>{I.trash}</button>}
            </>
          )
        ) : (
          <>
            <button type="button" data-tip={t('receipts.previewKey')} aria-label={t('receipts.preview')} onClick={act(() => setUi({ overlay: 'quick' }))}>{I.eye}</button>
            {edit && <button type="button" data-tip={t('receipts.linkKey')} aria-label={t('receipts.link')} onClick={act(() => onAct('link'))}>{I.link}</button>}
            {canEdit && <button type="button" data-tip={t('receipts.editKey')} aria-label={t('receipts.edit')} onClick={act(() => onAct('edit'))}>{I.edit}</button>}
            {edit && <button type="button" className="del" data-tip={t('receipts.deleteKey')} aria-label={t('receipts.delete')} onClick={act(() => onAct('del'))}>{I.trash}</button>}
          </>
        )}
      </span>
    </div>
  );
}

/**
 * data/quarantine/: what came in and is no receipt by its words, each with its reason; «Ist ein
 * Beleg» puts it into the inbox, whose run reads it, «Löschen» deletes it for good once confirmed
 * (src/server/routes/quarantine.ts).
 */
function Quarantine({ nav, canEdit, asked }: { nav: AreaProps['nav']; canEdit: boolean; asked: boolean }) {
  const [files, setFiles] = useState<QuarantinedFile[] | undefined>();
  const [shown, setOpen] = useState(false);
  const load = () => { api.quarantine().then(setFiles, () => setFiles([])); };
  useEffect(load, []);
  // The state chip «Quarantäne» opens the list, and says when it is empty (#211).
  const open = shown || asked;
  if (!files?.length) return asked && files ? <div className="empty"><h2>{t('chips.quarantineEmpty')}</h2></div> : null;
  const why = (q: QuarantinedFile) => [
    q.reason.kind === 'held' ? t('receipts.quarantineHeld') : q.reason.kind === 'unreadable' ? t('receipts.quarantineUnreadable') : t(`receipts.why.${q.reason.why ?? 'no-receipt'}`),
    q.reason.kind === 'not-receipt' && q.reason.from ? t('receipts.quarantineFrom', { from: q.reason.from }) : '',
  ].filter(Boolean).join(' · ');
  async function take(file: string) {
    try {
      await api.takeFromQuarantine(file);
      nav.toast(t('receipts.quarantineTaken', { file }));
      load();
      nav.refresh();
    } catch (e) { nav.toast(errorText(e)); }
  }
  return (
    <div className="quarantine" data-testid="quarantine">
      <div className="hidden-note">
        {t('receipts.quarantineNote', { n: files.length })} · <button type="button" onClick={() => setOpen(!shown)}>{open ? t('receipts.hideAgain') : t('receipts.show')}</button>
      </div>
      {open && (
        <>
          <p className="m qlead">{t('receipts.quarantineLead')}</p>
          <ul className="qlist">
            {files.map((q) => (
              <li key={q.file} data-file={q.file}>
                <span className="mono qfile">{q.file}</span>
                <span className="m">{why(q)} · {formatDate(q.at.slice(0, 10))}</span>
                <span className="qacts">
                  <a href={`/api/quarantine/${encodeURIComponent(q.file)}`} target="_blank" rel="noreferrer">{t('receipts.quarantineOpen')}</a>
                  {canEdit && <button type="button" className="linkbtn" onClick={() => void take(q.file)}>{t('receipts.quarantineTake')}</button>}
                  {canEdit && <button type="button" className="linkbtn danger" data-testid="quarantine-delete" onClick={() => askDiscard({ from: 'quarantine', files: [{ id: q.file, file: q.file }] })}>{t('receipts.discard')}</button>}
                </span>
              </li>
            ))}
          </ul>
          {canEdit && files.length > 1 && (
            <button type="button" className="linkbtn danger qall" data-testid="quarantine-delete-all" onClick={() => askDiscard({ from: 'quarantine', all: true, files: files.map((q) => ({ id: q.file, file: q.file })) })}>
              {t('receipts.discardAll', { n: files.length })}
            </button>
          )}
        </>
      )}
      <ConfirmDiscard from="quarantine" nav={nav} done={load} />
    </div>
  );
}

/** "Eingang verarbeiten": reads the inbox and statements, the VAT facts, names, links and books (src/intake/). */
function RunInbox() {
  const running = useIntakeRunning();
  return (
    <button type="button" className="runinbox" data-testid="run-inbox" disabled={running} data-tip={t('intake.runTip')} onClick={() => void startIntake()}>
      {I.spark}{running ? t('intake.running') : t('intake.run')}
    </button>
  );
}

function PendingRow({ file, proc, view, sel, onSelect }: { file: InboxFile; proc?: Processing; view?: AutomationView; sel: boolean; onSelect(id: string): void }) {
  if (file.failed) {
    return (
      <div className={`row reading failed${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={file.id} data-tip={file.failed.error} onClick={() => onSelect(file.id)}>
        <span className="d mono" />
        <span className="t">{file.filename} <span style={{ fontSize: 12, marginLeft: 6 }}>{t('receipts.readFailed')}</span></span>
        <span className="a mono" />
      </div>
    );
  }
  return (
    <div className={`row reading${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={file.id} data-tip={t('receipts.readingTip')} onClick={() => onSelect(file.id)}>
      <span className="d mono"><span className="shimmer" style={{ width: 70 }} /></span>
      <span className="t"><span className="shimmer" style={{ width: 150 }} /> <span style={{ fontSize: 12, marginLeft: 6 }} data-testid="row-processing">{inProcess(proc) ? processingText(proc, view) : t('receipts.reading')}</span></span>
      <span className="a mono" />
    </div>
  );
}

/** The receipt beside the list; while there is none at all, the empty table of the ways in. */
function ReceiptsDetail(props: Props) {
  const { inbox } = useUi();
  const picked = useSelection('receipt');
  const { rates } = useFx();
  if (picked) return <SelectionView kind="receipt" rows={receiptRows(props.books, picked.ids, rates)} books={props.books} nav={props.nav} canEdit={props.canEdit} />;
  return props.canEdit && !props.route.id && noReceiptsYet(props.books, inbox) ? <EmptyTable /> : <Detail {...props} />;
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('receipts.keySelectTip')],
  [['↵'], t('receipts.keyAccept'), t('receipts.keyAcceptTip')],
  [['␣'], t('receipts.keyPreview'), t('receipts.keyPreviewTip')],
  [['D'], t('receipts.keyDownload'), t('receipts.keyDownloadTip')],
  [['E'], t('receipts.keyEdit'), t('receipts.keyEditTip')],
  [['L'], t('receipts.keyLink'), t('receipts.keyLinkTip')],
  [['⌘', '⇧'], t('keys.pick'), t('keys.pickTip')],
  [['A'], t('keys.actions'), t('keys.actionsTip')],
  [['/'], t('keys.search'), t('receipts.searchTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const receipts: Area<RouteOf<'receipts'>> = {
  id: 'receipts',
  periodRows: true,
  selects: 'receipt',
  label: () => t('area.receipts'),
  dock: { key: 'b', icon: ICONS.receipts, tip: () => t('area.receipts.tip'), badge: (books) => badgeCount(ledgerFor(books)) },
  List,
  Detail: ReceiptsDetail,
  add: intakeAdd,
  legend,
  title: (r, books) => { const v = r.id ? ledgerFor(books).byId.get(r.id) : undefined; return v && (v.vendor || v.r.filename); },
  palette: ({ books, nav, period, canEdit }) => [
    ...(canEdit ? [{ label: t('intake.run'), side: t('area.receipts'), run: () => void startIntake() }] : []),
    ...[...ledgerFor(books).views].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).map((v) => ({
    label: v.desc ? `${v.vendor} · ${v.desc}` : v.vendor,
    side: [v.date && formatDate(v.date), v.r.amount != null && formatAmount(v.r.amount, v.r.currency)].filter(Boolean).join('  '),
    run: () => nav.go(at({ area: 'receipts', id: v.r.id }, v.day, period)),
  }))],
  keys(e, p) {
    const s = ui();
    if (s.overlay === 'quick') {
      if (e.key === ' ' || e.key === 'Escape') setUi({ overlay: null });
      return !e.metaKey && !e.ctrlKey;
    }
    if (s.overlay === 'delete' || s.overlay === 'discard') {
      if (e.key === 'Escape') setUi({ overlay: null, discard: undefined });
      if (e.key === 'Enter') document.querySelector<HTMLButtonElement>('.confirm .danger')?.click();
      return true;
    }
    if (s.overlay) return false;
    const d = moveKey(e);
    if (d) {
      const i = p.route.id ? listed.ids.indexOf(p.route.id) : -1;
      const next = listed.ids[Math.min(listed.ids.length - 1, Math.max(0, i + d))];
      if (next) p.nav.select({ area: 'receipts', id: next });
      return true;
    }
    // Deleting takes ⌘⌫ or the Delete key, as in Buchungen: a bare Backspace never deletes a receipt (r7f-31).
    if (e.key === 'Backspace') { if (e.metaKey && !e.ctrlKey && !e.altKey) runAct(p, 'del'); return e.metaKey; }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const v = p.route.id ? ledgerFor(p.books).byId.get(p.route.id) : undefined;
    switch (e.key) {
      case 'Enter': {
        const c = v && listed.suggestions.get(v.r.id);
        if (!v || !c || !p.canEdit) return false;
        accept(p, v, c);
        return true;
      }
      case ' ': if (!p.route.id) return false; setUi({ overlay: 'quick' }); return true;
      case 'd': case 'D': {
        const a = document.querySelector<HTMLAnchorElement>('.detail a.dl');
        a?.click();
        return !!a;
      }
      case 'e': case 'E': runAct(p, 'edit'); return true;
      case 'l': case 'L': runAct(p, 'link'); return true;
      case 'Delete': runAct(p, 'del'); return true;
      case 'Escape': if (!p.query.q) return false; p.nav.setQuery({ q: undefined }); return true;
    }
    return false;
  },
};
