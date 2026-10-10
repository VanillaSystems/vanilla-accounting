import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ALL, addDays, derivePeriod, localToday, parsePeriod, parseSwissDate, rangeToken,
  type IsoDate, type Period, type RelativePreset,
} from '../../accounting/periods.js';
import { formatDate } from '../lib/utils.js';
import { monthLocale, t } from '../i18n/index.js';
import { monthName, periodLabel, periodName } from '../lib/period-label.js';
import { ICONS } from '../areas/icons.js';

type Menu = 'root' | 'last' | 'todate' | 'quarters' | 'years';

const LAST: RelativePreset[] = ['last-7d', 'last-30d', 'last-90d', 'last-365d', 'last-week', 'last-month', 'last-quarter', 'last-12m', 'last-year'];
const TO_DATE: RelativePreset[] = ['wtd', 'mtd', 'qtd', 'ytd'];

interface Props {
  anchor: DOMRect;
  period: Period;
  /** The quarters and years that hold transactions, newest first. */
  quarters: string[];
  years: string[];
  /** Quarters ending on or before it are filed: shown with a lock. */
  closedThrough?: string;
  onApply(token: string): void;
  onClose(): void;
}

/**
 * The period picker, after Shopify's: presets on the left, a two-month calendar with typed dates
 * on the right, Cancel/Apply below. A preset or a calendar pick only changes the draft; Apply
 * puts it in the URL.
 */
export function PeriodPicker({ anchor, period, quarters, years, closedThrough, onApply, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const today = localToday();
  const [draft, setDraft] = useState(period);
  const [menu, setMenu] = useState<Menu>(() => initialMenu(period, today));
  /** After a first click on the calendar, the next click ends the range. */
  const [pickingEnd, setPickingEnd] = useState(false);
  /** The first of the left calendar's month; the right one shows the month after. */
  const [shown, setShown] = useState(() => monthStart(addMonths(period.kind === 'all' ? today : period.to, -1)));
  const startInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    // The anchor's rect is in zoomed pixels, the picker's position in page pixels.
    const z = Number(document.documentElement.style.zoom) || 1;
    ref.current!.style.left = `${Math.max(16, Math.min(anchor.left / z, innerWidth / z - 860))}px`;
    ref.current!.style.top = `${anchor.bottom / z + 8}px`;
    ref.current!.querySelector<HTMLElement>('.pi.on, .pi')?.focus();
  }, [anchor]);

  function choose(token: string) {
    const p = parsePeriod(token, today) ?? ALL;
    setDraft(p);
    setPickingEnd(false);
    if (p.kind !== 'all') setShown(monthStart(addMonths(p.to, -1)));
  }

  function pickDay(day: IsoDate) {
    if (!pickingEnd || draft.kind === 'all') {
      setDraft(rangePeriod(day, day));
      setPickingEnd(true);
    } else {
      const [from, to] = day < draft.from ? [day, draft.from] : [draft.from, day];
      setDraft(rangePeriod(from, to));
      setPickingEnd(false);
    }
  }

  function typed(which: 'from' | 'to', day: IsoDate) {
    const from = which === 'from' ? day : draft.kind === 'all' ? day : draft.from;
    const to = which === 'to' ? day : draft.kind === 'all' ? day : draft.to;
    setDraft(rangePeriod(from <= to ? from : to, from <= to ? to : from));
    setPickingEnd(false);
    setShown(monthStart(addMonths(which === 'to' ? day : addMonths(day, 1), -1)));
  }

  const isFiled = (key: string) => !!closedThrough && derivePeriod(key)!.to <= closedThrough;
  const item = (token: string, label: string, filed = false) => (
    <Item key={token} on={draft.token === token} onClick={() => choose(token)} filed={filed}>{label}</Item>
  );
  const draftFiled = !!closedThrough && draft.kind !== 'all' && draft.to <= closedThrough;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div ref={ref} className="pp" role="dialog" aria-label={t('app.periodPicker')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <nav>
          {menu === 'root' ? (
            <>
              {/* Accounting first: the year so far and this year's quarters, then the rest. */}
              {item('ytd', t('period.ytd'))}
              {quartersBegun(today).map((q) => item(q, periodName(parsePeriod(q, today)!), isFiled(q)))}
              <hr />
              <Item sub on={TO_DATE.includes(draft.token as RelativePreset) && draft.token !== 'ytd'} onClick={() => setMenu('todate')}>{t('period.menuToDate')}</Item>
              <Item sub on={LAST.includes(draft.token as RelativePreset)} onClick={() => setMenu('last')}>{t('period.menuLast')}</Item>
              <Item sub on={draft.kind === 'quarter' && !quartersBegun(today).includes(draft.token)} onClick={() => setMenu('quarters')}>{t('period.menuQuarters')}</Item>
              <Item sub on={draft.kind === 'year'} onClick={() => setMenu('years')}>{t('period.menuYears')}</Item>
              <hr />
              {item('today', t('period.today'))}
              {item('yesterday', t('period.yesterday'))}
              <hr />
              {item('all', t('app.allPeriods'))}
              <Item on={['range', 'month', 'half'].includes(draft.kind)} onClick={() => startInput.current?.focus()}>{t('period.custom')}</Item>
            </>
          ) : (
            <>
              <button type="button" className="pi back" onClick={() => setMenu('root')} aria-label={t('period.back')}>
                <span>‹ {t(MENU_TITLE[menu])}</span>
              </button>
              {menu === 'last' && LAST.map((p) => item(p, t(`period.${p}`)))}
              {menu === 'todate' && TO_DATE.map((p) => item(p, t(`period.${p}`)))}
              {menu === 'quarters' && quarters.map((q) => item(q, periodName(parsePeriod(q, today)!), isFiled(q)))}
              {menu === 'years' && years.map((y) => item(y, y, isFiled(y)))}
            </>
          )}
        </nav>
        <div className="right">
          <div className="ins">
            <DateInput inputRef={startInput} label={t('period.start')} value={draft.kind === 'all' ? '' : draft.from} onDate={(d) => typed('from', d)} />
            <span>→</span>
            <DateInput label={t('period.end')} value={draft.kind === 'all' ? '' : draft.to} onDate={(d) => typed('to', d)} />
          </div>
          <Calendars shown={shown} setShown={setShown} draft={draft} today={today} onPick={pickDay} />
          <div className="ft">
            <span className="lab" data-testid="period-draft">{periodLabel(draft)}{draftFiled && <> · {ICONS.lock} {t('period.filedShort')}</>}</span>
            <button type="button" className="btn2" onClick={onClose}>{t('common.cancel')}</button>
            <button type="button" className="btn2 primary" onClick={() => onApply(draft.token)} disabled={draft.token === period.token}>{t('period.apply')}</button>
          </div>
        </div>
      </div>
    </>
  );
}

/** This year's quarters that have begun, the running one first. */
function quartersBegun(today: IsoDate): string[] {
  const year = today.slice(0, 4);
  const current = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  return Array.from({ length: current }, (_, i) => `${year}-Q${current - i}`);
}

const MENU_TITLE = { last: 'period.menuLast', todate: 'period.menuToDate', quarters: 'period.menuQuarters', years: 'period.menuYears' } as const;

function initialMenu(p: Period, today: IsoDate): Menu {
  if (p.kind === 'ytd' || quartersBegun(today).includes(p.token)) return 'root';
  if (LAST.includes(p.kind as RelativePreset)) return 'last';
  if (TO_DATE.includes(p.kind as RelativePreset)) return 'todate';
  if (p.kind === 'quarter') return 'quarters';
  if (p.kind === 'year') return 'years';
  return 'root';
}

function rangePeriod(from: IsoDate, to: IsoDate): Period {
  return parsePeriod(rangeToken(from, to), localToday())!;
}

function Item({ children, on, sub, filed, onClick }: { children: React.ReactNode; on?: boolean; sub?: boolean; filed?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`pi${on ? ' on' : ''}`} onClick={onClick} aria-current={on || undefined}>
      <span>{children}</span>
      {filed && <span title={t('period.filed')}>{ICONS.lock}</span>}
      {sub && <span className="chev">›</span>}
    </button>
  );
}

/** A date typed as dd.mm.yyyy (Swiss), applied on Enter or when the field loses focus. */
function DateInput({ label, value, onDate, inputRef }: { label: string; value: IsoDate; onDate: (d: IsoDate) => void; inputRef?: React.Ref<HTMLInputElement> }) {
  const [text, setText] = useState(value ? formatDate(value) : '');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(value ? formatDate(value) : ''); setInvalid(false); }, [value]);

  function commit() {
    if (!text.trim() || (value && text === formatDate(value))) return;
    const day = parseSwissDate(text);
    setInvalid(!day);
    if (day) onDate(day);
  }

  return (
    <input
      ref={inputRef}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      aria-label={label}
      aria-invalid={invalid}
      title={invalid ? t('period.invalidDate') : label}
      placeholder={t('period.dateFormat')}
      style={invalid ? { borderColor: 'var(--neg)' } : undefined}
    />
  );
}

function Calendars({ shown, setShown, draft, today, onPick }: {
  shown: IsoDate;
  setShown: (d: IsoDate) => void;
  draft: Period;
  today: IsoDate;
  onPick: (d: IsoDate) => void;
}) {
  const [focused, setFocused] = useState<IsoDate>(draft.kind === 'all' ? today : draft.to);
  const grid = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const second = addMonths(shown, 1);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`)?.focus();
  }, [focused, shown]);

  function move(day: IsoDate) {
    moved.current = true;
    setFocused(day);
    if (day < shown) setShown(monthStart(day));
    else if (day > lastDay(second)) setShown(monthStart(addMonths(day, -1)));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) move(addDays(focused, step[e.key]));
    else if (e.key === 'PageUp') move(addMonths(focused, -1));
    else if (e.key === 'PageDown') move(addMonths(focused, 1));
    else return;
    e.preventDefault();
  }

  const visibleFocus = focused >= shown && focused <= lastDay(second) ? focused : shown;

  return (
    <div className="cals" ref={grid} onKeyDown={onKeyDown}>
      {[shown, second].map((month, i) => (
        <div key={month}>
          <div className="mh">
            {i === 0 ? <button type="button" onClick={() => setShown(addMonths(shown, -1))} aria-label={t('period.prevMonth')}>‹</button> : <span />}
            <b>{monthName(month)}</b>
            {i === 1 ? <button type="button" onClick={() => setShown(addMonths(shown, 1))} aria-label={t('period.nextMonth')}>›</button> : <span />}
          </div>
          <Month month={month} draft={draft} today={today} focusable={visibleFocus} onPick={(d) => { setFocused(d); onPick(d); }} />
        </div>
      ))}
    </div>
  );
}

function Month({ month, draft, today, focusable, onPick }: { month: IsoDate; draft: Period; today: IsoDate; focusable: IsoDate; onPick: (d: IsoDate) => void }) {
  const weekdays = useMemo(() => weekdayNames(), []);
  const first = monthStart(month);
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const days = Array.from({ length: Number(lastDay(month).slice(8)) }, (_, i) => addDays(first, i));
  const selected = draft.kind !== 'all';
  return (
    <div className="mo" role="group" aria-label={monthName(month)}>
      <div className="wd" aria-hidden>{weekdays.map((w) => <span key={w}>{w}</span>)}</div>
      <div className="days">
        {Array.from({ length: lead }, (_, i) => <span key={`lead${i}`} />)}
        {days.map((day) => {
          const edge = selected && (day === draft.from || day === draft.to);
          const inside = selected && day > draft.from && day < draft.to;
          const cls = ['day', edge && 'edge', inside && 'in', selected && day === draft.from && day !== draft.to && 'l',
            selected && day === draft.to && day !== draft.from && 'r', day > today && 'fut', day === today && 'tod'].filter(Boolean).join(' ');
          return (
            <span key={day} className={cls}>
              <button type="button" data-day={day} tabIndex={day === focusable ? 0 : -1} onClick={() => onPick(day)} aria-pressed={edge || inside} aria-label={formatDate(day)}>
                {Number(day.slice(8))}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Monday first, in the UI's language. */
function weekdayNames(): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(monthLocale(), { weekday: 'short', timeZone: 'UTC' }));
}

const monthStart = (d: IsoDate) => `${d.slice(0, 7)}-01`;
function addMonths(d: IsoDate, n: number): IsoDate {
  const [y, m, day] = d.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}
const lastDay = (month: IsoDate) => addDays(monthStart(addMonths(monthStart(month), 1)), -1);
