import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Calendar, ChevronDown, ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import {
  ALL, addDays, derivePeriod, localToday, parsePeriod, parseSwissDate, rangeToken,
  type IsoDate, type Period, type RelativePreset,
} from '../../accounting/periods.js';
import { cn, formatDate } from '../lib/utils.js';
import { monthLocale, t } from '../i18n/index.js';
import { monthName, periodLabel, periodName } from '../lib/period-label.js';

type Menu = 'root' | 'last' | 'todate' | 'quarters' | 'years';

const LAST: RelativePreset[] = ['last-7d', 'last-30d', 'last-90d', 'last-365d', 'last-week', 'last-month', 'last-quarter', 'last-12m', 'last-year'];
const TO_DATE: RelativePreset[] = ['wtd', 'mtd', 'qtd', 'ytd'];

interface Props {
  period: Period;
  onChange: (token: string) => void;
  /** The quarters and years that hold transactions, newest first. */
  quarters: string[];
  years: string[];
  /** Quarters ending on or before it are filed: shown with a lock. */
  closedThrough?: string;
}

/**
 * The header's period button and its popover, after Shopify's date picker: presets on the left,
 * a two-month calendar with typed dates on the right, Cancel/Apply below. A preset or a calendar
 * pick only changes the draft; Apply puts it in the URL.
 */
export function PeriodPicker({ period, onChange, quarters, years, closedThrough }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!popover.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('app.periodPicker')}
        data-testid="period-picker"
        className="flex items-center gap-1.5 border border-border rounded px-2 py-1 text-xs text-foreground bg-background hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="whitespace-nowrap">{periodLabel(period)}</span>
        <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div ref={popover} className="absolute right-0 top-full mt-1 z-50">
          <PickerPanel
            initial={period}
            quarters={quarters}
            years={years}
            closedThrough={closedThrough}
            onCancel={close}
            onApply={(token) => { onChange(token); close(); }}
          />
        </div>
      )}
    </div>
  );
}

function PickerPanel({ initial, quarters, years, closedThrough, onCancel, onApply }: {
  initial: Period;
  quarters: string[];
  years: string[];
  closedThrough?: string;
  onCancel: () => void;
  onApply: (token: string) => void;
}) {
  const today = localToday();
  const [draft, setDraft] = useState(initial);
  const [menu, setMenu] = useState<Menu>(() => initialMenu(initial, today));
  /** After a first click on the calendar, the next click ends the range. */
  const [pickingEnd, setPickingEnd] = useState(false);
  /** The first of the left calendar's month; the right one shows the month after. */
  const [shown, setShown] = useState(() => monthStart(addMonths(draft.kind === 'all' ? today : draft.to, -1)));
  const startInput = useRef<HTMLInputElement>(null);

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

  return (
    <div
      role="dialog"
      aria-label={t('app.periodPicker')}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      className="flex rounded-lg border border-border bg-background shadow-xl text-sm text-foreground overflow-hidden"
    >
      <nav className="w-52 shrink-0 bg-muted border-r border-border py-2 max-h-[34rem] overflow-y-auto">
        {menu === 'root' ? (
          <>
            {/* Accounting first: the year so far and this year's quarters, then the rest. */}
            <Item active={draft.token === 'ytd'} onClick={() => choose('ytd')}>{t('period.ytd')}</Item>
            {quartersBegun(today).map((q) => (
              <Item key={q} active={draft.token === q} onClick={() => choose(q)} filed={isFiled(q)}>
                {periodName(parsePeriod(q, today)!)}
              </Item>
            ))}
            <Divider />
            <Item sub active={TO_DATE.includes(draft.token as RelativePreset) && draft.token !== 'ytd'} onClick={() => setMenu('todate')}>{t('period.menuToDate')}</Item>
            <Item sub active={LAST.includes(draft.token as RelativePreset)} onClick={() => setMenu('last')}>{t('period.menuLast')}</Item>
            <Item sub active={draft.kind === 'quarter' && !quartersBegun(today).includes(draft.token)} onClick={() => setMenu('quarters')}>{t('period.menuQuarters')}</Item>
            <Item sub active={draft.kind === 'year'} onClick={() => setMenu('years')}>{t('period.menuYears')}</Item>
            <Divider />
            <Item active={draft.token === 'today'} onClick={() => choose('today')}>{t('period.today')}</Item>
            <Item active={draft.token === 'yesterday'} onClick={() => choose('yesterday')}>{t('period.yesterday')}</Item>
            <Divider />
            <Item active={draft.kind === 'all'} onClick={() => choose('all')}>{t('app.allPeriods')}</Item>
            <Item active={['range', 'month', 'half'].includes(draft.kind)} onClick={() => startInput.current?.focus()}>{t('period.custom')}</Item>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setMenu('root')}
              className="w-full flex items-center gap-2 px-4 py-1.5 mb-1 font-semibold hover:bg-accent focus:outline-none focus:bg-accent"
              aria-label={t('period.back')}
            >
              <ArrowLeft className="h-4 w-4" />
              {t(MENU_TITLE[menu])}
            </button>
            {menu === 'last' && LAST.map((p) => <Item key={p} active={draft.token === p} onClick={() => choose(p)}>{t(`period.${p}`)}</Item>)}
            {menu === 'todate' && TO_DATE.map((p) => <Item key={p} active={draft.token === p} onClick={() => choose(p)}>{t(`period.${p}`)}</Item>)}
            {menu === 'quarters' && quarters.map((q) => (
              <Item key={q} active={draft.token === q} onClick={() => choose(q)} filed={isFiled(q)}>
                {periodName(parsePeriod(q, today)!)}
              </Item>
            ))}
            {menu === 'years' && years.map((y) => (
              <Item key={y} active={draft.token === y} onClick={() => choose(y)} filed={isFiled(y)}>{y}</Item>
            ))}
          </>
        )}
      </nav>
      <div className="flex flex-col">
        <div className="flex items-center gap-2 px-5 pt-4">
          <DateInput inputRef={startInput} label={t('period.start')} value={draft.kind === 'all' ? '' : draft.from} onDate={(d) => typed('from', d)} />
          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
          <DateInput label={t('period.end')} value={draft.kind === 'all' ? '' : draft.to} onDate={(d) => typed('to', d)} />
        </div>
        <Calendars shown={shown} setShown={setShown} draft={draft} today={today} onPick={pickDay} />
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground" data-testid="period-draft">{periodLabel(draft)}</span>
          <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-md border border-border hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onApply(draft.token)}
            disabled={draft.token === initial.token}
            className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {t('period.apply')}
          </button>
        </div>
      </div>
    </div>
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

function Item({ children, active, sub, filed, onClick }: { children: React.ReactNode; active?: boolean; sub?: boolean; filed?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        'w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-accent focus:outline-none focus:bg-accent',
        active && 'font-semibold',
      )}
    >
      <span className="flex-1">{children}</span>
      {filed && <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label={t('period.filed')} />}
      {sub && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
    </button>
  );
}

const Divider = () => <div className="my-1.5 border-t border-border" />;

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
      className={cn(
        'w-56 rounded-md border bg-background px-3 py-1.5 tabular-nums focus:outline-none focus:ring-1 focus:ring-ring',
        invalid ? 'border-destructive' : 'border-input',
      )}
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
    <div className="px-5 pt-3 pb-4">
      <div className="flex items-start gap-6" ref={grid} onKeyDown={onKeyDown}>
        {[shown, second].map((month, i) => (
          <div key={month} className="w-[17rem]">
            <div className="flex items-center h-8 mb-1">
              {i === 0 && (
                <button type="button" onClick={() => setShown(addMonths(shown, -1))} aria-label={t('period.prevMonth')} className="p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring">
                  <ChevronLeft className="h-4 w-4" />
                </button>
              )}
              <span className="flex-1 text-center font-semibold capitalize">{monthName(month)}</span>
              {i === 1 && (
                <button type="button" onClick={() => setShown(addMonths(shown, 1))} aria-label={t('period.nextMonth')} className="p-1 rounded hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring">
                  <ChevronRight className="h-4 w-4" />
                </button>
              )}
            </div>
            <Month month={month} draft={draft} today={today} focusable={visibleFocus} onPick={(d) => { setFocused(d); onPick(d); }} />
          </div>
        ))}
      </div>
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
    <div role="group" aria-label={monthName(month)} className="grid grid-cols-7 text-center">
      {weekdays.map((w) => <div key={w} aria-hidden className="text-xs text-muted-foreground py-1">{w}</div>)}
      {Array.from({ length: lead }, (_, i) => <div key={`lead${i}`} />)}
      {days.map((day) => {
        const edge = selected && (day === draft.from || day === draft.to);
        const inside = selected && day > draft.from && day < draft.to;
        return (
          <div key={day} className={cn('py-0.5', inside && 'bg-accent', selected && day === draft.from && day !== draft.to && 'bg-accent rounded-l-md', selected && day === draft.to && day !== draft.from && 'bg-accent rounded-r-md')}>
            <button
              type="button"
              data-day={day}
              tabIndex={day === focusable ? 0 : -1}
              onClick={() => onPick(day)}
              aria-pressed={edge || inside}
              aria-label={formatDate(day)}
              className={cn(
                'h-8 w-8 rounded-md tabular-nums focus:outline-none focus:ring-2 focus:ring-ring',
                edge ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted',
                !edge && day > today && 'text-muted-foreground',
                !edge && day === today && 'underline underline-offset-4',
              )}
            >
              {Number(day.slice(8))}
            </button>
          </div>
        );
      })}
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

