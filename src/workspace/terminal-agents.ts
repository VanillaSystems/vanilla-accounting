/**
 * The instructions for an AI with full shell rights in the books folder (issue #146): Claude Code
 * or Codex, opened by «Im Terminal öffnen» in vanilla-accounting/. Both read AGENTS.md there
 * (Claude Code through CLAUDE.md's @AGENTS.md), besides the company's own files at the
 * repository's root, which stay untouched.
 *
 * The app's part is one marked section of vanilla-accounting/AGENTS.md: written whole when the file
 * is missing, added at the end of a file the company wrote itself, and replaced on each update
 * between its markers, so the rules follow the app while every line outside them stays the
 * company's. A section rather than a file of its own that AGENTS.md references: Codex reads
 * AGENTS.md and follows no reference, so a rule in another file could go unread.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePaths } from './workspace.js';

/** Where the terminal AI writes what it makes (reports, merged PDFs, converted files): ignored by git, so the books' history stays the books'. */
export const OUTPUT_DIR = 'output';
/** Where the terminal AI proposes changes to the books, one JSON file each; the app takes them into its sidebar for the person's «Übernehmen» (src/assistant/terminal-drafts.ts). */
export const PROPOSALS_DIR = 'data/terminal';

export const SECTION_START = '<!-- vanilla-accounting:start: written by the app on every update; edit outside these markers -->';
export const SECTION_END = '<!-- vanilla-accounting:end -->';

export const TERMINAL_SECTION = `${SECTION_START}
# Vanilla Accounting: the books folder

You are in the books of one company, kept with the app Vanilla Accounting, which is open beside
you. A person opened you from the app because its AI sidebar cannot run programs. Answer in the
person's language. Do what they ask with the files here, and never change the books yourself:
the person keeps every change to the books with one click in the app.

## Read freely

Everything in this folder: \`belege.workspace.yaml\` (the company, its banks, its VAT setup),
\`knowledge/\` (suppliers, customers, rules), \`master-data/accounts.json\` (the chart of
accounts), \`ledger.json\` (\`config.closedThrough\`: the last day of the last filed period), and
per year \`transactional-data/<year>/\`: in \`books/\` the bookings (\`entries.jsonl\`, key
\`id\`), the bank payments (\`transactions.jsonl\`, key \`ref\`), the receipts (\`receipts.jsonl\`,
key \`id\`; the files themselves are in \`receipts/\`) and which receipt belongs to which payment
(\`mappings.jsonl\`); \`bank-statements/\`; \`filings/\` (VAT returns as filed).

## Write only here

- \`${OUTPUT_DIR}/\`: everything you make for the person (a merged PDF, a report, a spreadsheet,
  a converted file, a script's result). It is not committed to git. Tell the person the file's
  name; they open it from there.
- \`${PROPOSALS_DIR}/<short-name>.json\`: a proposal to change the books (below).
- \`data/draft/<path>\`: a new version of a file of \`knowledge/\`, \`workflows/\` or
  \`sources/\` (how the app works), its whole content at the same path under \`data/draft/\`. The
  person keeps it in the app (Änderungen, or «Behalten» on a rule's card).

Never edit, move, rename or delete any other file: not the books (\`ledger.json\`,
\`transactional-data/\`, \`invoices.json\`, \`master-data/\`), not \`belege.workspace.yaml\`, not
a receipt or a statement, not \`data/\` outside the two folders above, and never a seal
(\`filings/seal-*.json\`). Never run git commands that change anything (commit, reset, checkout,
stash, rebase): the person saves in the app. The app checks the books when it loads them; a
change made beside it is found, and books whose filed part changed open read-only.

## Changing the books: a proposal

Write one JSON file into \`${PROPOSALS_DIR}/\` and tell the person to open «Verlauf» in the app's
AI sidebar: the proposal shows there as a conversation with your title, each booking as it is and
as it would be, and nothing changes until the person presses «Übernehmen». The app takes the
file in and removes it; a proposal it cannot read shows there with the reason. The app checks every change as it
checks its own and refuses all of them when one is wrong.

\`\`\`json
{
  "title": "Kaffee Juli auf Material",
  "summary": "Two plain sentences for the person: what changes and why.",
  "changes": [
    { "kind": "entry", "id": "<booking id>", "set": { "accountDebit": "4000", "vatCode": "<code>" } },
    { "kind": "newEntry", "entry": { "transactionRef": "<payment ref>", "date": "2026-07-03", "accountDebit": "6500", "accountCredit": "1020", "amount": 12.5, "vatCode": "<code>", "description": "Kaffee" } },
    { "kind": "deleteEntry", "id": "<booking id>" },
    { "kind": "link", "receipt": "<receipt id>", "payment": "<payment ref>" },
    { "kind": "unlink", "receipt": "<receipt id>", "payment": "<payment ref>" },
    { "kind": "receipt", "id": "<receipt id>", "set": { "date": "2026-07-03", "amount": 12.5 } },
    { "kind": "receiptKind", "id": "<receipt id>", "as": "duplicate" },
    { "kind": "account", "number": "6575", "name": "Software-Abos" },
    { "kind": "question", "on": { "kind": "payment", "id": "<payment ref>" }, "text": "Privat oder geschäftlich?" }
  ]
}
\`\`\`

- Ids come from the books files above; never invent one.
- A booking's \`vatCode\` is one the books already use (read \`entries.jsonl\`); a code with
  a rate only when the receipt shows that VAT charged.
- \`receiptKind\` \`as\`: invoice, sales-record, supporting, statement, noise, duplicate, or null.

## Filed periods are set in stone

Nothing dated on or before \`config.closedThrough\` in \`ledger.json\` ever changes: not its
bookings, not its payments, not its returns in \`filings/\`. A correction of a filed period is a
new booking dated in the open period with \`"corrects": "2026-Q2"\` (the period it corrects) and the
original booking's id in its description. The app refuses anything else.

## Commands

There is no command that changes the books: the proposal is the way. The figures the app shows
(VAT return, balances, reports) are the app's: when you compute a figure from the files yourself,
say that it is your own computation and that the app's figure is the one that counts.
${SECTION_END}
`;

/** The file with the app's section as it is now: the whole file when there was none, the section replaced or added at the end otherwise. */
export function withSection(current: string | undefined): string {
  if (current === undefined || !current.trim()) return TERMINAL_SECTION;
  const start = current.indexOf(SECTION_START);
  const end = current.indexOf(SECTION_END, start);
  if (start >= 0 && end > start) return current.slice(0, start) + TERMINAL_SECTION.trimEnd() + current.slice(end + SECTION_END.length);
  return `${current.trimEnd()}\n\n${TERMINAL_SECTION}`;
}

/** CLAUDE.md that loads AGENTS.md: as it was when it does already, with the line added when not. */
export function withAgentsImport(current: string | undefined): string {
  if (current === undefined || !current.trim()) return '@AGENTS.md\n';
  if (/^@AGENTS\.md\s*$/m.test(current)) return current;
  return `${current.trimEnd()}\n\n@AGENTS.md\n`;
}

/**
 * The terminal AI's files in the books folder, as this version writes them: AGENTS.md with the
 * app's section, CLAUDE.md loading it, output/ ignored by git. Idempotent; returns the files written.
 */
export function ensureTerminalAgents(paths: Pick<WorkspacePaths, 'root'>): string[] {
  const written: string[] = [];
  const put = (name: string, next: (current: string | undefined) => string) => {
    const file = join(paths.root, name);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    const text = next(current);
    if (text === current) return;
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    written.push(name);
  };
  put('AGENTS.md', withSection);
  put('CLAUDE.md', withAgentsImport);
  put(`${OUTPUT_DIR}/.gitignore`, (current) => current ?? '*\n');
  return written;
}
