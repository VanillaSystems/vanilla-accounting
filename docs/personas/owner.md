# Owner (Inhaber, Geschäftsführer)

Runs a small Swiss company (GmbH or AG, one to twenty people), installs the Mac app, works with
Claude (in Claude Desktop, or in a terminal if technical), and wants the books done without
hiring a full-time bookkeeper. Answers to the Treuhänder and, every few years, to an auditor.

## Skill level

Either kind ([skill level](README.md#skill-level-technical-or-non-technical)).

- **Non-technical:** installs the Mac app and the Claude Desktop plugin, follows a setup guide,
  and does the company's setup once for everyone in the app (receipt app pairing, Treuhänder
  access). The bulk work runs in Claude Desktop with Cowork.
- **Technical:** the same, or Claude Code or Codex in a terminal on the workspace, the CLI and
  git.

## Jobs

- Decide what the books cannot decide: is this purchase private, is that trip business, how
  is the profit used.
- Answer the questions the app and the Treuhänder raise.
- File the VAT return each quarter; close the year with the Treuhänder.
- See where the company stands: cash, VAT owed, result so far.
- Set the company up: identity, bank accounts, chart of accounts, who may do what.

## How often

A few minutes a week (answer questions, glance at the state); an hour per quarter (VAT);
a day per year (closing, with the Treuhänder).

## Where they work

- The Mac app, for looking, deciding and filing.
- An AI agent on the workspace for the bulk work (Claude Desktop with Cowork, or Claude Code or
  Codex in a terminal): "collect this month's receipts",
  "book what is open", "why is Q3 different from Q2". The agent works through the app's
  commands (see [ai-agent.md](ai-agent.md)), so the owner's instructions become history like any
  other change.

## What they may change

Everything that is not closed. Taking work over into `main`, filing, closing, company settings,
and who has access (on the git host) are the owner's (or another maintainer's).

## What they need from the app

- One place that says what needs them, and nothing else.
- To see what others changed since they last looked, and to revert any of it.
- Upgrades without losing their own rules: their instructions, supplier knowledge and booking
  rules live in the workspace, not in a fork of the app.
- To give the Treuhänder access for a review and take it back afterwards.

## Risks and pains

- Forking the app to adapt it breaks every later upgrade.
- An agent that edits `books.json` by hand bypasses the rules and the history.
- Real books on a public URL publish them.
