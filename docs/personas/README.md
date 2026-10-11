# Personas

Who works with the books, what each one does, and what each one may do. One file per persona;
this page is the overview. A real company mixes these: in a one-person GmbH the owner is also
the employee and the bookkeeper; in a firm of twenty, three people send receipts and the
Treuhänder does the journal.

## Overview

| Persona | Main job | The least we may ask of them | Works in |
|---|---|---|---|
| [Owner](owner.md) | Decides, answers, files VAT, closes the year | Installs the Mac app and the Claude Desktop plugin, follows a setup guide. | The Mac app, an AI agent on the workspace |
| [Employee](employee.md) | Hands in receipts | Installs a phone app and scans a QR code; nothing more. | Phone app, mail, a shared folder |
| [Bookkeeper](bookkeeper.md) | Imports statements, links receipts, books | Downloads statements from e-banking, uses the Mac app and Claude Desktop. | The Mac app, an AI agent |
| [Treuhänder](treuhaender.md) | Reviews, corrects, closes, advises | A link and a login; nothing to install. | The app in the browser, or an export |
| [Auditor](auditor.md) | Checks the books for ESTV or AHV | A link and a login, or a file that opens with a double-click. | Read-only audit view |
| [AI agent](ai-agent.md) | Does the work a person asks for | (an actor, not a person) | The workspace, through the app's commands |

The company side (owner, bookkeeper, employees) installs what its work needs, and the owner sets
it up once for everyone. The outside side (Treuhänder, auditor) gets nothing technical: no
install, no command line, no git, no configuration.

## Skill level: technical or non-technical

The skill level is not a persona. Every persona comes in both kinds, and the app serves both
without asking which one it has in front of it.

| | Non-technical | Technical |
|---|---|---|
| **Works with** | the Mac app, and Claude Desktop with Cowork, connected to the app through its plugin (MCP) | the same, plus command-line tools: Claude Code or Codex in a terminal, the `vanilla` CLI, `npm` scripts, git |
| **Talks to the model** | in Claude Desktop: chat, attached files, dictation | in Claude Desktop or in a terminal agent; the app's own model steps run through the `claude` CLI |
| **Sets up** | by double-click: the app, the plugin, a folder for the books | anything the docs describe, including a clone of the app |
| **Never needs** | a terminal, git, `npm`, a configuration file, an API key | (nothing is closed to them) |

Rules:

- **Everything works for the non-technical kind.** A job that only a terminal can do is a gap
  in the app, not a skill the person lacks. The Mac app and the plugin are the reference; the
  CLI is a second door to the same commands
  ([ADR 0005](../adr/0005-agents-command-registry-cli-mcp.md),
  [ADR 0006](../adr/0006-desktop-shell.md)).
- **Same rights at both levels.** The skill level changes how a person works, never what they
  may do: the table below holds for both kinds.
- **The model runs on the person's own Claude subscription at both levels.** The non-technical
  kind reaches it through Claude Desktop, the technical kind through Claude Desktop or the
  `claude` CLI.

## Who can do what

✓ may · – may not · ○ only their own

| | Owner | Bookkeeper | Employee | Treuhänder | Auditor | AI agent |
|---|---|---|---|---|---|---|
| See all books, receipts, statements, reports | ✓ | ✓ | – | ✓ | ✓ | as its person |
| Add receipts | ✓ | ✓ | ✓ | ✓ | – | as its person |
| Note on a receipt ("Material Projekt X", "privat") | ✓ | ✓ | ○ | ✓ | – | as its person |
| Import bank statements (camt.052/053, PDF) | ✓ | ✓ | – | ✓ | – | as its person |
| Link receipts to payments | ✓ | ✓ | – | ✓ | – | as its person |
| Create, change, delete entries in an open period | ✓ | ✓ | – | ✓ | – | as its person |
| Change anything dated in a closed period | – | – | – | – | – | – |
| Book a correction of a filed or closed quarter (in the open period) | ✓ | ✓ | – | ✓ | – | as its person |
| Work on an own branch | ✓ | ✓ | – | ✓ (review branch, via the cloud instance) | – | as its person |
| Take work over into `main` | ✓ | – | – | – | – | – |
| Ask a question on an item / answer it | ✓ | ✓ | ○ | ✓ | – | as its person |
| Undo someone else's change (open period) | ✓ | – | – | – | – | – |
| Mark a quarter as reviewed | ✓ | – | – | ✓ | – | – |
| File a VAT return, seal a quarter | ✓ | – | – | – | – | – |
| Book year-end entries | ✓ | ✓ | – | ✓ | – | as its person |
| Close the year, open the next | ✓ | – | – | – | – | – |
| Allocate the profit | ✓ | – | – | – | – | – |
| Chart of accounts, booking rules, supplier knowledge | ✓ | ✓ | – | ✓ | – | as its person |
| Company settings, bank accounts, roles | ✓ | – | – | – | – | – |
| Add or remove people (on the git host), invite the Treuhänder or an auditor (at the login gate) | ✓ | – | – | – | – | – |
| Export anything | ✓ | ✓ | – | ✓ | ✓ (copies) | as its person |

Filing, sealing, closing and access stay with the owner: they are the decisions the company
is liable for. The Treuhänder may do the work, the owner signs.

## Rules every persona shares

- **A closed period never changes.** Not for the owner, not for the Treuhänder. A correction is
  a new entry in the open period that names the quarter it corrects. (Filed means the VAT return
  is submitted; closed means sealed. The fourth quarter is filed before its year-end entries
  are booked, and closed after.)
- **Every change has an author.** Who, when, what, from what to what, and an optional reason.
  An agent's change carries its person ("Anna via Claude Code"). Reverting is a new change,
  never an erased one, so the history stays complete, like git.
- **No approval of each change.** Bookkeeper and Treuhänder change directly, on their own
  branch; the owner takes their work over into `main` as a whole, sees what changed since his
  last visit, and can undo any single change afterwards. `main` is what counts; the git host
  decides who may write it.
- **The data is the company's.** It lives in the company's own workspace (a git repository),
  not in the app, and not on a vendor's server.
- **A model runs on the company's own subscription** (Claude or ChatGPT) by default; an API key
  is the exception.

## The handover line moves

The work runs in one direction: receipt in, statement in, receipt matched to payment, booked,
reviewed, filed, closed. Where the company stops and the Treuhänder starts differs in every
collaboration. Some companies only hand in receipts and statements; some book everything and
want a review. The app does not hard-wire the line: every step can be done by any role allowed
to, and the history shows who did it.

## How they reach the app

Decided in [ADR 0003](../adr/0003-deployment-and-collaboration.md): local-first books in git,
the cloud only for outsiders. Owner and bookkeeper each work in a local clone (the `vanilla` CLI
or the Electron app) and push; git merges record by record and the app checks every merge
against its rules. Employees get no clone; their receipts reach the repository's inbox. For a
review, the owner opens a temporary cloud instance with the current and the previous year, the
Treuhänder works in it in the browser, and it is deleted afterwards. The auditor gets a static,
read-only export behind a login. Every change is a git commit with its author.
