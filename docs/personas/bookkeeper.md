# Bookkeeper (Buchhaltung)

Whoever turns receipts and bank statements into journal entries. In a small company this is
the owner, an assistant, or already the Treuhänder; the role is defined by the work, not by a
job title.

## Technical level

Medium. Downloads statements from e-banking (camt.053 or PDF), works in the desktop app, may run
an AI agent with prepared instructions. No git, no configuration files.

## Jobs

- Import bank statements: camt.053 (end of day), camt.052 (intraday) or the bank's PDF; Wise,
  PayPal, Stripe and card statements.
- Check that each account's balance matches its statement, month by month; find the gaps.
- Link receipts to payments; chase the missing ones.
- Book: account, VAT code, foreign currency at the ESTV rate. Mostly by letting the agent
  propose and checking what it did.
- Keep the chart of accounts and the booking rules current.

## How often

Weekly or monthly; heavier before each VAT deadline.

## Where they work

The desktop app (Kontoauszüge, Belege, Buchungen) and an AI agent on the workspace for the
bulk: "import the September statements and book what you can".

## What they may change

Everything in open periods: receipts, links, entries, statements. Not company settings, not
roles, not closed periods. She works on her own branch; the owner takes her work over into
`main` ([ADR 0003](../adr/0003-deployment-and-collaboration.md), section 2).

## What they need from the app

- Statements in, balances checked, gaps named, in one place.
- A queue of what is not done: payments without receipt, receipts without payment, entries
  without VAT code.
- To work at the same time as others without overwriting them.

## Risks and pains

- **Several writers, one file.** Two people (or a person and an agent) editing the same books on
  two machines meet in git merges. [ADR 0003](../adr/0003-deployment-and-collaboration.md) stores
  one record per line, merges by record id, checks every merge against the rules, and shows the
  rare real conflict side by side. Agents call the `vanilla` commands instead of editing files.
- A statement imported twice, or a month skipped, shows only in the balance check; it must run
  on every import.
