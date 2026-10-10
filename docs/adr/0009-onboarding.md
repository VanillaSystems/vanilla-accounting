# ADR 0009: Onboarding: install the plugin, set up in Cowork, bring what you have

Status: accepted (2026-10-10). Today's onboarding is [getting-started.md](../getting-started.md):
clone the app, `npm install`, `npm run init`. It is rewritten when the plugin exists.

## Problem

A company starts either from scratch (a new GmbH) or from existing bookkeeping (Banana, Bexio,
spreadsheets, a Treuhänder's books). Today's path assumes a developer: install Node, poppler and
Claude Code, clone the app repository, run the wizard in a terminal. The wizard itself
(`npm run init`: profiles, fourteen questions, bank accounts, opening balances from Banana) is
good; the way to it is not.

## Decision

### The flow

```
 1. Install        download vanilla-accounting (the plugin, ADR 0006), double-click
                   → Claude Desktop installs it
 2. Set up         in Cowork: "Richte meine Buchhaltung ein"
                   → the same questions as today's wizard (profile, company, UID, VAT,
                     bank accounts), asked by the agent
                   → the person picks a folder; the app creates the workspace there
                     as a local git repository (no account, no remote)
 3. Bring          into the inbox (ADR 0008):
                   new company:  nothing yet, or the first statements and receipts
                   switching:    the opening balances (a Banana export, or the
                                 Treuhänder's balance sheet as PDF), this year's bank
                                 statements (camt.053 since 1 January), this year's
                                 receipts (a folder or a ZIP)
                   → "Verarbeite meinen Eingang"
 4. First check    bank balances match the statements? the first quarter booked?
                   → "Öffne die Buchhaltung" shows it in the browser

 Later, when needed:
   • backup and collaboration: "Sicherung einrichten" (GitHub, ADR 0006)
   • mailboxes for automatic receipt collection
   • a bookkeeper: "Buchhalterin einladen"
   • the Treuhänder: "Prüfung öffnen" (ADR 0003)
```

### Rules

- **No repository first.** The workspace starts as a local git repository; a remote is for
  backup and a second person, offered after the first week, never required to start.
- **Two doors, one setup.** In Cowork (the plugin) or with an agent in a terminal ("set up
  Vanilla Accounting for my company", calling `vanilla init`); both run the same setup command
  of the registry ([ADR 0005](0005-agents-command-registry-cli-mcp.md)), which takes over
  today's wizard.
- **A switching company brings opening balances and the current year, not its history.** Old
  years stay in the old system, or as PDFs with the Treuhänder. `npm run import-opening` already
  reads a Banana export; a balance sheet as PDF is read by the agent.
- **Unsupported cases stop early and say why,** as today's wizard does (no VAT, Saldosteuersatz,
  vereinbarte Entgelte, a non-calendar fiscal year).
- **Agents are connected without editing a file:** the plugin is the connection for Claude
  Desktop and Cowork; for Claude Code, `claude mcp add vanilla -- vanilla mcp`.

### Where it is explained

A small static website (a free static host) with the download, the four steps, and the MCP
instructions, once the app is public. Until then, `README.md` and `getting-started.md` carry the
same flow; `getting-started.md` keeps the developer path as its last section.

## Consequences

- The setup command moves from the `init` script into the registry, so Cowork, the CLI and the
  app UI ask the same questions.
- The plugin needs the Skills "Buchhaltung einrichten" and "Eingang verarbeiten".
- `getting-started.md` is rewritten around this flow when the plugin ships.

## Rejected

- **"Create a GitHub repository first":** the hardest step at the very start, for something only
  needed later.
- **Migrating a switching company's whole history:** a large, error-prone import for years that
  are closed and filed elsewhere.
- **A separate onboarding wizard per channel:** the questions and their rules belong to one
  command.
