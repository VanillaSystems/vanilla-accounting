# Collecting documents and data from outside: requirements

**Status: requirements, agreed with the owner on 14 October 2026.** Input for an architecture
session. Nothing here decides how it is built; the session does. The company's own sources (which
vendors, which mailboxes) are listed in its workspace, not here.

## The use case

A company's evidence does not arrive in one place. Receipts come as mail attachments, as links in
mails, from vendor portals behind a login, and from APIs. A web shop's admin holds three different
things at once: the sales orders, the payouts that settle them, and the monthly invoice for the
shop's own fees with its VAT. Today a person collects most of this by hand once a quarter, with an
AI helping in a browser. The app should do it on its own, as often as the sources allow, and ask a
person only where a person is really needed.

Three documents name this thing differently today: "extension" (the workspace extensions design of
12 October), "integration module" (modules.md) and "source" (the UI design). The architecture
session settles one name and one mechanism. This page says **source** for "something that fetches
from one place outside".

## What a source must be able to reach

| # | Channel | Example | MVP |
|---|---|---|---|
| C1 | A mailbox through its server (IMAP) | several accounts, folders, sender filters, app passwords | yes |
| C2 | A mailbox through its webmail, in a browser, where server access is blocked | webmail without app passwords | yes, where no 2FA is needed |
| C3 | A vendor portal or admin area, in a browser, behind a login | a shop admin, a supplier portal, a billing page | yes, where no 2FA is needed |
| C4 | A vendor API, where one exists | a shop's or a payment provider's API with a scoped token | yes |
| C5 | A link in a mail that leads to a download, possibly behind a login | an invoice download link | yes |
| C6 | Files a person brings: phone scan, drop | exists today | yes |

**Logins with a second factor (2FA) are not in the MVP.** A source that needs one runs locally, with
a person present, as today. Everything after it (reading, matching, booking) may run anywhere,
also in the cloud.

## What a source delivers

A source delivers one of three kinds of output. They take different paths afterwards.

| # | Output | Example | Goes to |
|---|---|---|---|
| O1 | A document | a PDF invoice, an image, a mail printed as PDF, a shop's monthly fee invoice | the inbox, then the intake workflow |
| O2 | Rebuilt evidence, where the vendor issues no proper document | an order page plus its VAT detail, captured as a PDF | the inbox, marked as rebuilt |
| O3 | Structured records | sales orders, payouts with their fees | a typed import (sales, settlements), not the receipt inbox; it feeds booking and the matching of payouts to the bank |

For every item:

- **R1 Origin.** Which source, which account, which mail id or URL, when it was collected.
- **R2 No duplicates.** The same document from two sources, or twice from one, is kept once.
- **R3 A period.** A run can be asked for a period (a month, a quarter) or for "everything new".

## How it runs

- **R4 On demand and on a schedule.** The minimum is monthly, because some vendors invoice monthly.
  The goal is daily or continuous.
- **R5 Incremental.** A run fetches what is new since the last run of that source and remembers
  where it stopped. Running it twice fetches nothing twice.
- **R6 Each source on its own.** One failing source does not stop the others. A run that stops
  resumes where it stopped.
- **R7 A person only where needed.** A login, a captcha or a changed page becomes a task, and the
  run waits. In the MVP a 2FA login is such a task and is done locally.
- **R8 Gentle with the vendor.** Rate limits, no repeated logins, one session reused.
- **R9 Local now, cloud later.** Sources without a 2FA login can run unattended in the cloud; their
  results are committed for later review like any other run.

## How a source is written and changed

- **R10 Code, not an AI browsing freely.** A source is code: fixed steps on fixed pages. An AI may
  write it and repair it, but a run does not ask an AI where to click. Pages change rarely enough
  (they stay stable for months) that a coded source pays off.
- **R11 Repair is a normal event.** When a page changes, the source fails loudly with the page it
  saw. A person, with the AI, fixes the source, replays the failed case, and switches the fix on.
- **R12 Written by the company's own people only.** In the MVP only the company writes sources, and
  every source and every change to one is approved by a person and committed. Sources from third
  parties are out of scope.

## Safety

- **R13 No source sees a password or a token.** The app logs in and hands the source a session or
  a scoped connection.
- **R14 A source declares what it may reach**, and a person approves that list:
  - mail: which accounts, folders and senders;
  - API: which service and which scopes;
  - browser: which addresses it may open and download from, as host and path patterns
    (for example `admin.example-shop.com/store/*/orders/*`), not free regular expressions. The
    patterns are checked on every navigation and every download. A pattern that turns out too
    narrow fails loudly and is widened by an approved change; narrow is the point.
- **R15 A source writes nowhere but its output.** Documents go to the inbox, records to their typed
  import. It never books, never pays, never sends mail.
- **R16 An AI step that reads outside content holds no other handle.** A mail or a page may carry
  planted instructions; the step that reads it can do nothing with them.
- **R17 Secrets live in the keychain** (later: the platform's secret store), never in plain files of
  the app or the workspace.

## Out of scope for the MVP

- 2FA logins anywhere but locally with a person present.
- An AI that drives a browser without code.
- Sources written by anyone outside the company, and a sandbox strong enough for them.

## Open for the architecture session

- One name and one mechanism for "extension", "integration module" and "source".
- Where structured records (O3) land: their own files per year beside the books, or records of the
  books themselves.
- How a source's browser session is kept, and how it would reach the cloud once 2FA is solved.
- Whether the schedule belongs to each source or to the collection workflow.
