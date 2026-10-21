/**
 * The areas of the app, one object each (docs/redesign/architecture.md §3). The shell renders
 * an area's list and detail and asks it for its dock entry, add action, palette entries, keys
 * and tab title, so the add button, N, the URLs and ⌘K work the same in every area.
 */
import type { ComponentType, ReactNode } from 'react';
import type { Index } from '../../types/index.js';
import type { Period } from '../../accounting/periods.js';
import type { AreaId, Location, Query, Route, RouteOf } from '../shell/route.js';
import { t } from '../i18n/index.js';
import { close } from './close/close.js';
import { company } from './company/company.js';
import { invoices } from './invoices/invoices.js';
import { journal } from './journal/journal.js';
import { codes } from './codes/codes.js';
import { receipts } from './receipts/receipts.js';
import { bank } from './bank/bank.js';
import { reports } from './reports/reports.js';
import { vat } from './vat/vat.js';
import { automation } from './automation/automation.js';
import { changes } from './changes/changes.js';
import { partners } from './partners/partners.js';
import { knowledge } from './knowledge/knowledge.js';
import { ICONS } from './icons.js';

export interface Nav {
  /** To another place: a new history entry when the area changes, else the current one replaced (urls.md rule 4). */
  go(loc: Location): void;
  /** A row of the current page: replaces the history entry and keeps the query. */
  select(route: Route): void;
  /** The page's period, search or filter: replaces the history entry. */
  setQuery(query: Query): void;
  toast(msg: string, undo?: () => void): void;
  /** Takes the shown toast away (a form that now shows an error must not keep the earlier «Gespeichert»). */
  dismissToast(): void;
  refresh(): void;
}

export interface AreaProps<R extends Route = Route> {
  route: R;
  query: Query;
  /** The query's period, else the open quarter. */
  period: Period;
  books: Index;
  nav: Nav;
  /** A write could succeed: the API answers and is not in audit mode. */
  canEdit: boolean;
}

export interface PaletteItem {
  label: string;
  side?: string;
  run(): void;
}

/** One line of the key legend: the keys, a word, and the tooltip. */
export type LegendItem = [keys: string[], label: string, tip: string];

export interface Area<R extends Route = Route> {
  id: R['area'];
  label(): string;
  /** In the dock: G + `key` opens it. Absent: reached from another area (codes from MWST). */
  dock?: { key: string; icon: ReactNode; tip(): string; badge?(books: Index): number };
  /** The dock entry marked while this area is open, when it has none of its own. */
  dockAs?: AreaId;
  List: ComponentType<AreaProps<R>>;
  /** Absent: the list takes the whole page (the old tabs until their phase). */
  Detail?: ComponentType<AreaProps<R>>;
  /** The add button and N; absent when the area has nothing to add. */
  add?: { label(route: R): string; title(route: R): string; run(props: AreaProps): void };
  /** Files dropped on the page while this area is open, and what the drop zone says; absent: they go to the receipts' inbox. */
  drop?: { text(): string; formats(): string; run(files: File[], props: AreaProps): void };
  /** The objects ⌘K finds in this area, under the area's name. */
  palette?(props: AreaProps): PaletteItem[];
  /** Keys handled while this area is open, beyond the shell's own; true when handled. */
  keys?(e: KeyboardEvent, props: AreaProps<R>): boolean;
  legend?(): LegendItem[];
  /** The object the route names, for the tab title "<object> · <area>" (urls.md rule 6). */
  title(route: R, books: Index): string | undefined;
  /** Wider list column (journal, reports). */
  wide?: boolean;
  /** A route whose page takes the whole width: the list shows it, there is no detail column. */
  fullPage?(route: R): boolean;
  /** Pages without a period (company, codes): no period in the top bar or the heading. */
  periodless?: boolean;
  /** Its rows belong to a period: another period opens the new list at its first row instead of keeping the object. */
  periodRows?: boolean;
}

type Registry = { [A in AreaId]: Area<RouteOf<A>> };

export const AREAS: Registry = {
  receipts,
  invoices,
  bank,
  journal,
  vat,
  codes,
  reports,
  close,
  company,
  automation,
  changes,
  partners,
  knowledge,
};

/** The dock's order; a divider stands before the last group. */
export const DOCK: AreaId[][] = [['receipts', 'invoices', 'bank', 'journal', 'vat', 'reports', 'close'], ['automation', 'partners', 'knowledge', 'changes', 'company']];

/** The area of a route, typed for its own route: the registry pairs them, a lookup cannot show it to the compiler. */
export const areaOf = <R extends Route>(route: R) => AREAS[route.area] as unknown as Area<R>;

