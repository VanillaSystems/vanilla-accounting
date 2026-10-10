# Redesign: the architecture of the new UI

Status: decided 2026-10-11 (phase 0 of the redesign). The spec for look and behaviour is the
clickable mockup in the private workspace (`planning/ui-mockup/index.html`). This file fixes the
shape of the code that ports it. Port the mockup's behaviour and CSS, not its code structure.

## 1. One stylesheet, the mockup's tokens

- `src/app/styles/tokens.css` holds the mockup's custom properties (`--bg`, `--ink`, `--ink-2`,
  `--muted`, `--faint`, `--date`, `--line`, `--line-2`, `--accent`, `--accent-soft`, `--on-accent`,
  `--hover`, `--glass`, `--glass-line`, `--shadow`, `--warn`, `--warn-soft`, `--pos`, `--pos-soft`,
  `--neg`, `--paper-bg`, `--desk`) for `[data-theme="light"]` and `[data-theme="dark"]`.
- `src/app/styles/shell.css` and one CSS file per area (`src/app/areas/<area>/<area>.css`) hold
  the mockup's component CSS with its class names. Plain CSS, imported by the module that uses it.
- The theme is `data-theme` on `<html>`, set from the preference `system | light | dark`
  (System follows `prefers-color-scheme` live).
- Fonts are self-hosted with `@fontsource`: Hanken Grotesk (headings), Instrument Sans (text),
  Geist Mono (numbers, dates, codes). No request to Google; the audit export works offline.
- Tailwind stays only for old components until phase 10 deletes them. New code uses no Tailwind
  classes.

## 2. Routing: real paths, one parser

- `src/app/shell/route.ts` owns the route type and the only parser and formatter:

  ```ts
  type Route =
    | { area: 'receipts'; id?: ReceiptId }
    | { area: 'bank'; statement?: StatementKey; payment?: BankRef }
    | { area: 'journal'; id?: EntryId }
    | { area: 'vat'; ziffer?: string }
    | { area: 'codes'; code?: VatCode }
    | { area: 'reports'; report: 'income' | 'balance' | 'trial'; account?: string }
    | { area: 'close'; step?: string }
    | { area: 'company'; section: CompanySection }
    | { area: 'invoices'; view: 'list' | 'customers' | 'sent'; id?: string };
  interface Location { route: Route; query: { period?: string; q?: string; filter?: string; status?: string; vat?: string } }
  parseLocation(path: string, search: string): Location | Redirect
  formatLocation(loc: Location): string
  ```

  Paths and query parameters are exactly those of `docs/urls.md`. The period is parsed by
  `src/accounting/periods.ts`; a route never carries a token string past the parser.
- Old links `/<lang>/<period>/<tab>?receipt=&tx=&je=&account=&ziffer=` are parsed into a
  `Redirect` to the new location (replaceState), so bookmarks keep working. The language moves out
  of the path into the per-viewer preference (urls.md rule 3: links do not carry the language).
- Changing area pushes a history entry; selecting a row replaces it (urls.md rule 4). Back and
  forward re-parse the URL.
- The static audit export keeps the path after `#` (`#/journal/M2026-001`), as it does today.
- Vite dev and the Express server answer every app path with `index.html`. The data paths that
  collide with app paths (`/receipts/<file>.pdf`, `/bank-statements/<file>`) are recognized by
  their file extension, so `/receipts/<id>` is the app and `/receipts/<name>.pdf` is the file.

## 3. The shell and the area contract

```
src/app/shell/      Shell.tsx (main grid, list | split | detail), TopBar, Dock, Palette (⌘K),
                    Toast (with undo), PeriodPicker, Menu, keyboard.ts, route.ts, history.ts
src/app/areas/      one folder per area: receipts, bank, journal, vat, codes, reports, close,
                    company, invoices
src/app/data/       BooksProvider (books.json + accounts, refresh), derived selectors
```

Every area is one object of this type, registered in `src/app/areas/index.ts`:

```ts
interface Area<R extends Route = Route> {
  id: R['area'];
  dock?: { key: string; icon: ReactNode; label: () => string; tip: () => string; badge?: (b: Books) => number };
  List: ComponentType<AreaProps<R>>;
  Detail: ComponentType<AreaProps<R>>;
  /** The add button and N; absent when the area has nothing to add. */
  add?: { label: () => string; run: (ctx: ShellContext) => void };
  /** Entries the ⌘K palette offers from this area (objects and actions). */
  palette?: (books: Books, ctx: ShellContext) => PaletteItem[];
  /** Keys handled while this area has focus, beyond the shell's own. */
  keys?: (e: KeyboardEvent, ctx: ShellContext) => boolean;
  /** The tab title for the current route (urls.md rule 6). */
  title: (route: R, books: Books) => string;
  /** Wider list column (journal, reports). */
  wide?: boolean;
}
interface AreaProps<R> { route: R; query: Location['query']; period: Period; books: Books; nav: Nav; }
interface Nav { go(loc: Location): void; select(route: Route): void; toast(msg: string, undo?: () => void): void; }
```

The shell owns: the grid with the resizable divider (width per area in localStorage, double-click
resets), the top bar and dock (shown on approach to the edge, `G` + letter, labels), zoom
(⌘+/⌘−/⌘0, CSS `zoom` on `<main>` with `--z`), theme `T`, language, the ⌘K palette, the toast with
undo, `?` for the key legend, the drop zone, and URL sync. Areas own only their list, detail and keys.
Row selection follows the mockup: ↑/↓ or J/K move, Enter opens, Esc goes back to the list.

## 4. Data

- The UI keeps loading `books.json` and computing in the browser with the app's own functions
  (`src/accounting/*`, `src/books/*`): reports, VAT figures and ledgers come from the same code the
  CLI and the golden master use. No figure is computed by code written for the UI.
- Writes go through the existing API (`src/server/routes/`, `withBooks`, `assertOpen`). A new route
  only where an area needs a write that does not exist yet; every new write route gets its row in
  `tests/period-lock.test.ts`.
- Every user-visible text goes through `t()` (de source; fr, it, en).

## 5. Invoices

Decided in phase 8 with ADR 0012 (PDF path) after the prototype of headless Chromium against a PDF
library. Records carry the ADR 0004 envelope and live in the workspace beside `books.json`.
