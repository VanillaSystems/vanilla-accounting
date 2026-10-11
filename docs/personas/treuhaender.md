# Treuhänder (accountant)

An external accountant or fiduciary firm with many clients. Knows Swiss accounting and VAT
thoroughly, usually works in their own software (Banana, Abacus, Bexio), bills by the hour,
and signs off the annual accounts.

## Jobs

- Review the books: is each entry on the right account, with the right VAT code, backed by
  a receipt?
- Correct what is wrong, in the open period.
- Ask the owner about what the books cannot tell (private or business, which project).
- Check the VAT returns, and prepare the corrections of filed quarters (form 0535).
- Book the year-end entries: depreciation, accruals, provisions, tax.
- Close the year with the owner; prepare the annual accounts.

## How often

Per quarter (VAT review), and intensively at year-end. Many clients, so each visit is short and
must start with "what changed since I last looked".

## Skill level

Either kind ([skill level](README.md#skill-level-technical-or-non-technical)). An expert in
accounting, not necessarily in software. We ask for a browser, a link and a login, never an
install, a command line, git or a configuration step. A technical Treuhänder may bring his own
agent; the app does not count on it.

## Where they work

**In the browser, with nothing installed:** a link, an e-mail code, and the app. His local stack
is a browser. Two ways of working with him ([ADR 0003](../adr/0003-deployment-and-collaboration.md),
section 5):

- **Review:** the company books, he reviews. The owner opens a temporary cloud instance with
  the current and the previous year ("Prüfung öffnen"), he corrects in the browser, the owner
  closes it. Corrections are handwork; he needs no model for them.
- **Full service:** the company only delivers receipts and statements, he books. The instance is
  permanent and is his workplace for this client. Reading receipts and proposing entries run in
  the instance with an API key the company stores once; he configures nothing. If he has his own
  Claude plan, he may add the instance as a connector in claude.ai and work through it.

He edits directly. No proposal step: every save is a git commit with his name and an optional
reason, pushed at once. The owner sees "changed by Treuhand" and can revert any change; a
revert is a new change, so the history stays complete.

The fallback is the classic way: the owner sends an export (Banana import file, reports, the
receipts as a ZIP), and the Treuhänder answers by mail or in their own software.

## What they may change

Everything in open periods, like the bookkeeper, plus year-end entries. Not company settings,
not access, not closed periods. He works on a review (or full-service) branch that the owner
takes over into `main`.

## What they need from the app

- A login without installing anything.
- "Since your last visit": what the company changed, grouped.
- Questions to the owner on an item, and the answers on the same item.
- A review status per quarter ("Q3 geprüft"), visible to the owner.
- Exports in their software's format (Banana TSV today).

## Risks and pains

- Real books on any public URL publish them; access must sit behind a login on every path.
- A Treuhänder who must learn a new tool per client will not; the app must feel like
  bookkeeping, not like software.
