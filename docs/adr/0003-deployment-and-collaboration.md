# ADR 0003: Local-first books in git, the cloud only for outsiders

Status: accepted (2026-10-10), revised the same day after an outside review (Codex). Nothing
built yet; the order of work is at the end.

## Problem

The app runs on the owner's machine, against a workspace folder that is a git repository. That
works for one person. It does not yet work for the people around the books
([personas](../personas/README.md)):

- **Company members** (owner, bookkeeper) work on their own machines, often offline, and should
  not depend on a company server.
- **The Treuhänder and the auditor are not technical.** They need a link and a login. A
  workstation acting as their server was tried and was a headache: it sleeps, changes networks,
  and its owner has to be there.
- **Several people change the books,** and someone must decide what counts as accepted.
- **Twenty years of books must not go to the cloud** for a three-week review.
- **Every change must be visible and revertible,** like git history, without approving each one.
- **Filing a VAT return and closing a period act on the outside world** and must happen on
  books that are complete and current.
- **The model runs on a person's own subscription** where that person works on their own
  machine; a shared server cannot borrow a personal subscription.

Terms used below, as the app already uses them: a quarter is **filed** when its VAT return is
submitted; it is **closed** when `config.closedThrough` passes its end and its seal is written.
Q1 to Q3 are filed and closed; the fourth quarter is filed first, its year-end entries dated
31.12. are booked after, and the year close then closes it ([year-end.md](../year-end.md)).
**A closed period never changes.** A filed but not yet closed period may still take entries
that do not change its return (year-end entries carry no VAT).

## Decision

### The landscape

```
                     Git host (GitHub / GitLab / Bitbucket / …): users and permissions
   ┌──────────────────────────────────────────────────────────────────────────────────┐
   │  main  (protected: only maintainers push and merge)                              │
   │   ●────●─────●─────────────────●────────────────●──────►  filing, closing,       │
   │         \                     /                  \         migrations: on main,  │
   │          ●──●──●──●──●───────┘                    ●──●──●  by a maintainer       │
   │          bookkeeper/anna                          review/2026-q3                 │
   │          (her branch; she writes only here)       (the cloud instance writes)    │
   └────────▲─────────────────────────▲───────────────────────────▲───────────────────┘
            │ merges branches         │ pushes her branch         │ pushes its branch
            │ in the app, rules       │                           │ (bot identity)
   ┌────────┴──────────────┐ ┌────────┴──────────────┐ ┌──────────┴──────────────────┐
   │ Owner (maintainer)    │ │ Bookkeeper            │ │ Cloud instance (container)  │
   │ vanilla CLI / desktop │ │ desktop app           │ │ window of years, behind a   │
   │ + own agent           │ │ + own agent           │ │ login gate · review: deleted│
   │ "übernehmen", filing  │ │                       │ │ after · full service: stays │
   └───────────────────────┘ └───────────────────────┘ └──────────────▲──────────────┘
                                                                      │ browser
   Employees: no access to the repository; receipts by mail     ┌─────┴──────┐
   or a shared folder (later an upload endpoint)                │ Treuhänder │
                                                                └────────────┘
   Auditor: static read-only export of the audited years, behind the same login gate
```

### 1. The trust model: the git host decides who may do what

Users and permissions live where the company keeps its repository: the git host. Adding or
removing a person is done there, by the host's administrator (or through the app, which asks the
host). GitHub is the one supported host at first; the sync layer is plain git over HTTPS, so
other hosts can follow as adapters ([ADR 0006](0006-desktop-shell.md), section 3).

| Role | On the git host | May |
|---|---|---|
| **Host administrator** (usually the owner) | admin | add and remove people, set branch rules |
| **Maintainer** (owner, a trusted partner) | write, may push and merge `main` | accept work into `main`; file, close, migrate |
| **Contributor** (bookkeeper) | write, may push only their own branches | book on their branch; never on `main` |
| **Outsider** (Treuhänder) | no account; works through a cloud instance whose bot may push only its review branch | book on the review branch, through the browser |
| **Employee** | no access | hand in receipts |
| **Auditor** | no access; a static export behind a login | read the audited years |

**`main` is what counts.** It holds the accepted books. Only maintainers write it, and the host
enforces that (protected branch). Write access to the repository is not admin rights.

What this model does and does not guarantee:

- **Reading is all or nothing.** No git host restricts reading by path: whoever can read the
  repository reads every year, every salary, every customer. Hence employees get no access.
- **Enforcement depends on the host and its plan.** Protected branches are offered by GitLab
  and Bitbucket in their free tiers, and by GitHub for private repositories only on paid plans
  (Pro, Team) as far as known when writing; check before relying on it. Without protected
  branches, a contributor can technically push `main`, and only the app's local guards stand in
  the way: they prevent mistakes, not intent. A company with one person needs no protection; a
  company with a contributor needs a host that protects `main`.
- **The app's roles follow the host.** Locally the app reads the person's permission from the
  host where it can (or from `access.yaml`, maintained by a maintainer on `main`) and hides what
  the person may not do. Outsiders get their role from the login gate and `access.yaml`.
- **Authorship:** a contributor's commits carry their git identity, which the host has
  authenticated on push; the cloud instance writes commits with the gate-verified person as
  author and may sign them. Signing proves who wrote a commit, not that the action was allowed;
  the branch rules decide that.

### 2. Branches: each contributor and each review works on its own branch

- **A contributor works on a branch of their own** (`bookkeeper/anna`). The app creates it,
  keeps it current by bringing `main` into it on every sync, and pushes it.
- **A Treuhänder review works on a review branch** (`review/2026-q3`, `fullservice/treuhand-xy`),
  written by the cloud instance.
- **A maintainer takes work over into `main` in the app** ("Arbeit übernehmen"), not with the
  host's merge button: the host merges text and knows nothing of records or rules. The app
  fetches the branch, merges by record (see 3), runs the checks, shows real conflicts, and pushes
  `main`. The host's merge button is not used.
- **Take over often** (weekly, monthly, at the end of a review), so branches stay close to
  `main` and conflicts stay small.

This is not a proposal step. A maintainer does not approve changes one by one; he takes over a
body of work. Each change stays in the history with its author and reason, and can be undone
on its own afterwards (see 4).

### 3. Data that git can merge record by record

The data is split by fiscal year and stored one record per line (JSON Lines), sorted by id:
`books/<year>/entries.jsonl`, `transactions.jsonl`, `mappings.jsonl`, plus `receipts/<year>/`,
`bank-statements/<year>/`, `filings/<year>/`. Shared data stays at the top
(`belege.workspace.yaml`, `accounts.json`, `knowledge/`, `access.yaml`, `VERSION`). How sealed
records keep their seals through this is in [ADR 0004](0004-versions-and-record-envelope.md);
a company's own fields and external references live beside the records, outside the seals
([ADR 0007](0007-external-references-and-annotations.md)).

- **Identities never collide:** receipt = SHA-256 of the file, bank transaction = the bank's
  reference within a namespace per account (with a fallback for lines without a reference),
  new entries and manual transactions = a random id. Existing references stay.
- **The app's merge driver** merges by record id: records added on both sides are kept, the same
  record added twice is kept once, the same record changed on both sides is a conflict. A record
  is one unit; two people changing different fields of the same entry is a conflict.
- **Two kinds of checks.** *Structural invariants* run on every merge and refuse a merge that
  breaks them: entries balance, references point to existing records, nothing closed changed,
  each entry's amounts and accounts are valid. *Close-readiness checks* (every transaction
  booked, every receipt linked, bank balances match the statements, no duplicates) do not block
  a merge, because unfinished work must be able to sync; they block filing and closing (see 6).
- **Booking groups are explicit.** A payment split over several entries, a receipt covering
  several payments, a grouped purchase: the relation is modeled (allocations), so "booked once"
  and "linked once" mean "fully allocated", and duplicates are told apart from splits.
- **Conflicts across records** (two people booked the same payment as different entries) are
  found by the close-readiness checks and shown as a group to resolve, not only side by side for
  one record. An agent may propose a resolution; a person confirms.
- **Economic duplicates** (the same receipt scanned twice gives two files and two hashes) are
  found by content (amount, date, counterparty), not by id.

### 4. The history is git; undo is a bookkeeping operation

Every change is a commit with the person as author and an optional reason ("6580 → 6570:
Informatikaufwand, nicht Webshop"), and trailers for the app (`Vanilla-Role`, `Vanilla-Via:
cli | mcp | web | ai`).

- **"Since your last visit"** is the log of `main` (and of open branches) since that person last
  looked, grouped by record.
- **Undo is a domain operation, not a bare `git revert`.** The app reverses a change only if the
  record is still in an open period and nothing that followed depends on it; it then commits the
  reversal under the person who undoes. A change in a period closed since then is undone by a
  correction entry in the open period. Some actions are not undoable: a filing, a seal, a year
  close.
- **Deleting is a flag** on the record, so "deleted on one side, changed on the other" is a
  visible conflict.

### 5. The Treuhänder works in a cloud instance, with nothing installed

His local stack is a browser: a link, an e-mail code, and the app. No install, no API key, no
git, no repository account.

| Case | Who books | Instance | Branch |
|---|---|---|---|
| **Review** | the company | temporary: "Prüfung öffnen" … "Prüfung schliessen" | `review/<period>`, taken over at the end |
| **Full service** | the Treuhänder; the company delivers receipts and statements | permanent: his workplace for this client | `fullservice/<firm>`, taken over regularly by the owner |

How a save becomes a commit:

```
  Treuhänder (browser)        Instance (server)                         Git host
  1. 6580 → 6570, Speichern   2. checks role, rules, and that the
                                 record is still what he saw (3)
                              3. writes the record's line
                              4. git commit (author: Lea Muster,
                                 reason, Vanilla-Role, Vanilla-Via)
                              5. git push of the review branch ──────►  review/2026-q3
  6. "gespeichert ✓"
```

- **Its own clone,** fetched at creation (partial clone, sparse checkout of the window). It
  pushes with a token for this one repository that may write only its branch; the owner stores
  it once; the Treuhänder never sees it.
- **The window is footprint, not secrecy.** The instance's token can read the whole repository;
  the window only limits what is checked out and processed. A company that needs the books
  outside the window to stay unreadable to the instance needs a separate repository or a
  restricted export, which this ADR does not build. The window includes every period the open
  work corrects (`corrects:` reaches back), and the instance does not verify old seals; `main`
  and the maintainers' clones do.
- **Saves are serialized and checked** (see 7): two browser sessions cannot overwrite each
  other; the second sees "inzwischen geändert".
- **Nothing acknowledged is lost.** The instance keeps its clone on durable storage; a commit
  not yet pushed shows "noch nicht synchronisiert" and is retried; the instance is deleted only
  after the app has verified that its branch on the host contains every commit. Backups of the
  volume, secrets in the host's secret store, expiring credentials renewed, the MCP endpoint
  authenticated through the same gate.
- **Concurrent changes on `main`** reach his branch when the instance brings `main` in; only the
  same record changed on both sides is shown to him as a conflict.

#### Who pays for the model, and how it is billed

In the full-service case the Treuhänder needs the model for reading receipts, matching and
proposing entries. The app's own cost ledger (`data/llm-ledger.jsonl`, [ADR 0002](0002-counterparty-knowledge-and-lean-calls.md))
measured per call, on Sonnet: about 2,500 tokens in and 260 out to read a receipt's VAT facts,
5,500 in and 1,000 out for a scanned receipt, 5,700 in and 440 out to match a receipt to a
payment, 22,000 in and 2,500 out to classify a batch of payments. For a small company (about 80
receipts and 95 payments a month) that is roughly **USD 5 a month at Sonnet's API list price**,
less with a smaller model (an estimate from those measurements; the ledger shows the real
figure). Next to a Treuhänder's hourly rate this is minutes of his time, and the model saves him
hours.

| Way | Who pays | How it is billed | Fit |
|---|---|---|---|
| **API key of the company, stored once in the instance** | the company, directly to the model provider | nothing to bill: the cost lands on the company's own invoice; the ledger shows it per step and per month | **default**: no setup for the Treuhänder, transparent |
| **API key of the Treuhänder's firm** | the firm | as an expense at cost (Auslagen), from the ledger's monthly figure per client | for firms that run many clients on one account |
| **The Treuhänder's own subscription** (Claude or ChatGPT plan, the instance added as a connector) | the Treuhänder | not per client: it is his tool, like his other software, and part of his hourly rate | for Treuhänder who already work with an assistant |

The instance makes model calls only with a key; without one every screen works and the model
work is done through a connector or not at all.

### 6. Finalization happens on `main`, by a maintainer, exclusively

Filing a VAT return, closing a period, the year close, the profit allocation and a data
migration act on the outside world or on everyone's data. They run only on `main`, only by a
maintainer, and one at a time:

1. The app takes a **finalization lock** on the remote (a commit to `main` naming the action and
   the holder; a second attempt sees it and stops).
2. It brings every open branch the maintainer chooses into `main`, runs the close-readiness
   checks, and **freezes that commit**: the return is computed from exactly this commit.
3. It records the **intent** (the action, the frozen commit, the figures) before acting.
4. It acts: the return is submitted, or the period is closed and sealed.
5. It records the **result** (the ESTV receipt, the seal) and releases the lock.

If any step fails, the recorded intent says where it stopped, and the next attempt resumes or
cleans up instead of repeating a submission. Ordinary bookkeeping continues on branches during
all of this; only finalization is exclusive.

### 7. Every write is a transaction with a precondition

Whether from the browser, the CLI, an agent or the desktop app, every change goes through the
command layer ([ADR 0005](0005-agents-command-registry-cli-mcp.md)), which:

- knows the **actor** and checks their permission;
- serializes writes to one workspace (one writer process at a time);
- requires the **state the change was based on** (the record's content hash, or the commit it
  read): a save based on a stale read is refused, not silently applied;
- takes an **idempotency key**, so a retried request does not apply twice;
- applies the change, commits and records it as one recoverable unit, with a journal that a
  crash can be resumed from.

### 8. The auditor gets a static export

An auditor only reads. The audit export ([audit-export.md](../audit-export.md)) of the audited
years goes to a static host behind the login gate for the audit's duration, then is deleted. It
must open as a link, no longer with `npx serve`.

### 9. Receipts from employees: the existing ways first

The app already collects receipts from mailboxes and folders. Employees use those: forward to
the company's receipt address, or drop into a shared folder a maintainer's or contributor's app
watches. A phone gets no repository credentials. Later, an upload endpoint on a cloud instance,
with a token per device that can be revoked, size limits, idempotent uploads and an
acknowledgement the phone can show; only then the App Store receipt app with QR pairing.

#### The receipt app: encrypted, paired by QR, never plain HTTP

Today the receipt app (`ios/Accounting`) uploads over plain `http://` to an address typed by hand,
and `/api/upload` accepts files from anyone who can reach it. That is replaced, on iOS and on a
later Android app alike, before the app is distributed:

```
 Desktop app (first start)                        Phone (receipt app, iOS or Android)
 1. creates its own key and certificate
    (self-signed, long-lived)
 2. shows a QR code with:                         3. scans it once and keeps, in the
    • its address (IP:port) and its                  system keychain:
      Bonjour name                                    • where the desktop is
    • the SHA-256 fingerprint of its certificate      • which certificate is genuine
    • an upload token for this phone                  • its upload token
                                                  4. uploads over HTTPS, and only if the
                                                     server's certificate has exactly
                                                     that fingerprint
```

- **Always encrypted in transit.** The app speaks HTTPS only; there is no plain-HTTP fallback,
  not even on the local network. The phone does not ask whether a certificate authority trusts
  the desktop, but whether the certificate is the one the QR code introduced (certificate
  pinning). No domain, no certificate authority, no warning; someone on the same Wi-Fi cannot
  sit in between, because his certificate has another fingerprint. The desktop serves this with
  Node's `https` and its generated certificate; iOS checks the fingerprint in `URLSession`'s
  server-trust challenge, Android in OkHttp's trust check. iOS additionally declares the
  local-network exception (`NSAllowsLocalNetworking`) and the local-network permission text;
  Android needs no cleartext exception, because there is no cleartext.
- **Encrypted at rest on the phone.** Receipts waiting for upload are stored in the app's own
  storage with the operating system's data protection (iOS: file protection
  `completeUntilFirstUserAuthentication`, so a background upload still works after the first
  unlock; Android: app-private storage, encrypted by the system). The pairing (address,
  fingerprint, token) lives in the keychain (iOS) or the Keystore (Android), not in plain
  settings. A delivered receipt is deleted from the phone once the desktop acknowledged it.
- **Authorized per device.** The token in the QR code is the upload permission for that phone
  and nothing else: it cannot read the books. The desktop lists paired phones and revokes one
  with a click; a revoked or unknown token is refused. Uploads carry an idempotency key, so a
  retry after a lost acknowledgement does not store a receipt twice.
- **Found again when the address changes.** The desktop announces itself by Bonjour/mDNS (the
  app already depends on `bonjour-service`); the phone looks it up by name when the stored
  address no longer answers. The fingerprint stays the same, so the phone still knows it is the
  right computer.
- **When the desktop is not reachable** (switched off, the phone on the road), the phone keeps the
  receipts and shows "3 Belege warten"; they go out the next time it reaches the desktop. With a
  cloud instance, the phone uploads there instead, over ordinary HTTPS with the host's public
  certificate, from anywhere. Without either, a shared folder (iCloud Drive) is the stop in
  between ([ADR 0008](0008-ingestion-one-inbox.md)).
- **The vendor is never in the path.** No relay, no pairing service and no analytics of the
  vendor: receipts go from the phone to the company's own desktop or instance only. The app
  stores declare no data collected by the vendor.

Rejected for the phone:

- **Plain HTTP on the local network:** receipts and the token would cross the Wi-Fi unencrypted,
  and Android blocks it by default.
- **A public certificate for every desktop** (a subdomain per customer, as Plex or Home Assistant
  Cloud do): needs a domain, a certificate service and infrastructure run by the vendor, which
  would put the vendor into the data path.
- **Plain HTTP with an encryption of our own on top:** home-made cryptography instead of standard
  TLS, and Android still blocks plain HTTP.

### 10. The model runs where the person is

Each person's agent (Claude Code, Claude Cowork, Codex) runs on their own machine and
subscription and calls the app's commands ([ADR 0005](0005-agents-command-registry-cli-mcp.md)).
The app's own model calls (`src/llm/ask.ts`) run through the `claude` CLI (or the Codex CLI) on
the subscription of whoever runs the app locally. A cloud instance uses an API key (see 5), or
none.

### 11. Where a cloud instance runs is the company's choice

| Choice | Example | Data location | Cost, roughly (to check) |
|---|---|---|---|
| Simple | Fly.io (Frankfurt), with a volume, stopped when idle | EU | cents for a review month; a few CHF a month when permanent |
| Swiss | Google Cloud Run, Zurich region, with persistent storage | Switzerland | near zero when idle; more setup |
| Own server | a small VPS | the company's choice | a few CHF a month |

One target is built and supported first; the others follow.

## Consequences

- **The command layer comes first** (7), on today's storage: actor, permission, preconditions,
  idempotency, atomic and recoverable writes. Everything else rests on it.
- **One writer before many:** the first collaboration is a maintainer plus one cloud instance on
  a review branch, taken over in the app. Contributors on their own branches, and merging
  between several of them, follow once take-over, conflicts and their resolution work.
- **Data migration** to years and records, with the seals untouched ([ADR 0004](0004-versions-and-record-envelope.md)).
- **Host requirements:** protected branches for any company with a contributor; a login gate
  for outsiders; one supported cloud target.
- **Real books leave the company's machines** only for a cloud instance (its token can read the
  repository; the window limits what it processes) and an audit export (the audited years).
- **No company server and no running cost** for a company without outsiders; a review costs
  cents; full service costs a few CHF a month plus the model.

## Rejected

- **A workstation as the server for outsiders:** unreliable for the people least able to deal
  with it.
- **Everyone pushing to `main`:** write access would be admin rights, and filing could act on
  books someone else is still changing.
- **The host's merge button:** merges text, not records, and skips the rules.
- **A permanent team server everyone logs in to:** costs every month and takes the books off the
  members' machines; branches and take-over give the same collaboration. A full-service instance
  is the one permanent server, and only for the outsider who needs it.
- **One `books.json` merged as text, conflicts left to an LLM:** the dangerous merges are the
  ones git does not flag.
- **Approving each change before it counts:** slower for everyone; take-over plus per-change undo
  gives the owner the same control.
- **The window as an access boundary:** it is not one; claiming it would mislead.
- **The server calling models on someone's subscription:** a subscription is personal.

## Order of work

1. **Command layer** on today's storage: actor, permission, preconditions, idempotency, atomic
   recoverable writes; commit per change with author and reason; the `vanilla` CLI on top.
2. **Finalization** (6): lock, frozen commit, intent and result, recovery; "closed" and "filed"
   kept apart everywhere.
3. **Undo** as a domain operation (4); "since your last visit".
4. **Cloud instance** for a review: one host target, login gate, review branch, durable clone,
   verified sync before deletion; take-over into `main` in the app.
5. **Data by year and record** (3), seals untouched ([ADR 0004](0004-versions-and-record-envelope.md));
   merge driver, structural invariants, close-readiness checks, allocations, group conflicts.
6. **Contributors on branches**, host permissions read by the app, regular take-over.
7. **Full service:** permanent instance, model calls with the company's key, the remote MCP
   endpoint ([ADR 0005](0005-agents-command-registry-cli-mcp.md)).
8. **Audit export** on a static host.
9. **Upload endpoint** for receipts; later the receipt app with QR pairing.
10. **Electron app** ([ADR 0006](0006-desktop-shell.md)).
