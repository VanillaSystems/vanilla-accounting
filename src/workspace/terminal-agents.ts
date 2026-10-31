/**
 * The instructions for an AI with full shell rights in the books folder (issue #146): Claude Code
 * or Codex, opened by «Im Terminal öffnen» in vanilla-accounting/. Both read AGENTS.md there
 * (Claude Code through CLAUDE.md's @AGENTS.md), besides the repository's own AGENTS.md, whose
 * app part is marked the same way (REPOSITORY_SECTION, issue #149).
 *
 * The app's part is one marked section of vanilla-accounting/AGENTS.md: written whole when the file
 * is missing, added at the end of a file the company wrote itself, and replaced on each update
 * between its markers, so the rules follow the app while every line outside them stays the
 * company's. A section rather than a file of its own that AGENTS.md references: Codex reads
 * AGENTS.md and follows no reference, so a rule in another file could go unread.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

/** `current` with `section` between its markers; undefined when it has none. */
function replaceSection(current: string, section: string): string | undefined {
  const start = current.indexOf(SECTION_START);
  const end = current.indexOf(SECTION_END, start);
  return start >= 0 && end > start ? current.slice(0, start) + section.trimEnd() + current.slice(end + SECTION_END.length) : undefined;
}

/** The file with the app's section as it is now: the whole file when there was none, the section replaced or added at the end otherwise. */
export function withSection(current: string | undefined): string {
  if (current === undefined || !current.trim()) return TERMINAL_SECTION;
  return replaceSection(current, TERMINAL_SECTION) ?? `${current.trimEnd()}\n\n${TERMINAL_SECTION}`;
}

/**
 * The app's part of the company repository's own AGENTS.md (issue #149). It names no path of the
 * app: the books are kept with the packed Mac app or with a developer checkout, and a command
 * that fits one does not exist in the other. The books' rules are in vanilla-accounting/AGENTS.md.
 */
export const REPOSITORY_SECTION = `${SECTION_START}
This repository holds the company's data, not the code. Each app has its own folder; the books of
Vanilla Accounting are in \`vanilla-accounting/\`: \`belege.workspace.yaml\` (who the company is, how
it works, which ledger account each bank books on), \`knowledge/\` (suppliers, customers,
authorities, rules), \`master-data/accounts.json\` (chart of accounts), \`ledger.json\`, and per
fiscal year \`transactional-data/<year>/\` (\`books/\`, \`receipts/\`, \`bank-statements/\`,
\`filings/\`). Files no app reads (notes, scripts, reference documents) go to \`own/\`.

The books are kept with the app Vanilla Accounting, never by editing these files: in the Mac app
(it opens this folder), or in a developer checkout of the app whose \`.env\` sets
\`VANILLA_WORKSPACE\` to this folder (\`npm start\` and \`npm run doctor\` run there, not here).

Before you work on the books, read \`vanilla-accounting/AGENTS.md\`: what you may read and write,
how to propose a change to the books, and why a filed period never changes.

What goes where:
- Code, generic process rules, public vendor facts: the app.
- Anything naming this company's accounts, amounts, customers, suppliers or the owner's
  decisions: here (\`vanilla-accounting/knowledge/\`, the notes below).
${SECTION_END}
`;

const NOTES_HEADING = 'Company notes:';

/** The repository's AGENTS.md of a new company. */
export function repositoryAgents(name: string): string {
  return `# ${name}: the company's repository (private)\n\n${REPOSITORY_SECTION}\n${NOTES_HEADING}\n- (add what an agent should know about this company)\n`;
}

/**
 * The texts setup wrote up to the company's notes (0.3, then 0.4.0 until issue #149), with
 * \`{name}\` for the company and \`{app}\` for the app's path: \`cd {app} && npm start\` pointed into
 * the Mac app's bundle.
 */
const LEGACY_TEXTS = [`# {name}: books (private workspace)

This folder holds the books, not the code. It is a Vanilla Accounting workspace: \`belege.workspace.yaml\`
(who the company is, how it works, which ledger account each bank books on), \`accounts.json\`
(chart of accounts), \`books.json\`, \`receipts/\`, \`bank-statements/\`, \`filings/\`, plus the
company's own knowledge: \`knowledge/\` (suppliers, customers, authorities, rules), \`mail.yaml\`.
`, `# {name}: the company's repository (private)

This repository holds the company's data, not the code. Each app has its own folder; the books of
Vanilla Accounting are in \`vanilla-accounting/\`: \`belege.workspace.yaml\` (who the company is, how
it works, which ledger account each bank books on), \`knowledge/\` (suppliers, customers,
authorities, rules), \`mail.yaml\`, \`master-data/accounts.json\` (chart of accounts), \`ledger.json\`,
and per fiscal year \`transactional-data/<year>/\` (\`books/\`, \`receipts/\`, \`bank-statements/\`,
\`filings/\`). Files no app reads (notes, scripts, reference documents) go to \`own/\`;
\`npm run doctor\` names every other file.
`].map((head) => `${head}
The app is at \`{app}\`. Its \`.env\` sets \`VANILLA_WORKSPACE\` to this folder, so every
command run there works on these books:

    cd {app} && npm start          # UI on http://localhost:5173
    cd {app} && npm run doctor     # is everything set up?

Read the app's rules first: {app}/AGENTS.md (golden rule 1: a filed quarter never changes;
corrections are booked in the open quarter with \`corrects:\` and declared on a form 0535).

What goes where:
- Code, generic process rules, public vendor facts: the app.
- Anything naming this company's accounts, amounts, customers, suppliers or the owner's
  decisions: here (knowledge/, this file).

${NOTES_HEADING}`);
const LEGACY_REPOSITORY = LEGACY_TEXTS.map((text) => {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace('\\{name\\}', '(.*)').replace('\\{app\\}', '(.+)').replaceAll('\\{app\\}', '\\2')}`);
});

/**
 * The repository's AGENTS.md as this version writes the app's part: renewed between its markers,
 * or, when it is a text setup wrote earlier with only its notes changed, that text replaced and the
 * notes kept. Any other file is the company's own and stays as it is (undefined: no change).
 */
export function withRepositorySection(current: string): string | undefined {
  const renewed = replaceSection(current, REPOSITORY_SECTION);
  if (renewed !== undefined) return renewed;
  const legacy = LEGACY_REPOSITORY.map((pattern) => pattern.exec(current)).find((found) => found);
  if (!legacy) return undefined;
  return `# ${legacy[1]}: the company's repository (private)\n\n${REPOSITORY_SECTION}\n${current.slice(legacy[0].length - NOTES_HEADING.length)}`;
}

/** CLAUDE.md that loads AGENTS.md: as it was when it does already, with the line added when not. */
export function withAgentsImport(current: string | undefined): string {
  if (current === undefined || !current.trim()) return '@AGENTS.md\n';
  if (/^@AGENTS\.md\s*$/m.test(current)) return current;
  return `${current.trimEnd()}\n\n@AGENTS.md\n`;
}

/**
 * The terminal AI's files in the books folder, as this version writes them: AGENTS.md with the
 * app's section, CLAUDE.md loading it, output/ ignored by git; and the app's part of the
 * repository's AGENTS.md (withRepositorySection). Idempotent; returns the files written, relative
 * to the repository.
 */
export function ensureTerminalAgents(paths: Pick<WorkspacePaths, 'root' | 'repository'>): string[] {
  const written: string[] = [];
  const put = (file: string, next: (current: string | undefined) => string | undefined) => {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    const text = next(current);
    if (text === undefined || text === current) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    written.push(relative(paths.repository, file));
  };
  put(join(paths.root, 'AGENTS.md'), withSection);
  put(join(paths.root, 'CLAUDE.md'), withAgentsImport);
  put(join(paths.root, OUTPUT_DIR, '.gitignore'), (current) => current ?? '*\n');
  if (paths.repository !== paths.root) put(join(paths.repository, 'AGENTS.md'), (current) => current && withRepositorySection(current));
  return written;
}
