# ADR 0014: Sources, one concept for collecting from outside

**Status: accepted (0.4.0), being built.** Requirements: docs/0.4.0/collection-requirements.md.

## Context

Documents and data reach a company through mailboxes, vendor portals behind a login, APIs,
links in mails and paper. Three documents named the missing concept differently ("extension",
"integration module", "source"), and the app collected only from IMAP, from the CLI, with
passwords in `.env` and its dedupe journal in `data/`.

## Decision

- **One concept, the source.** A source is a folder `sources/<id>/` in the app or the company
  workspace: `source.yaml` (what it may reach, what it delivers, read and approved by a person,
  parsed without running code) and code (one async generator per feed that yields documents,
  records and checkpoints). App code a company reuses is bound (`code: app:imap`).
- **Feeds and reach.** A source's feeds each have one output (a document, records of a declared
  kind) and a cadence. Its reach is at most one mail account, one set of web addresses and one
  API, as patterns of hosts and paths, never regular expressions.
- **One mechanism.** A source runs as a workflow run: `collection` (daily) starts one `collect`
  run per source with a feed due; a login, a missing secret or a changed page is a person's task.
  There is no second job system and no cron per source.
- **The host owns everything else.** Secrets (the keychain; no source sees one), sessions,
  connections, reach checks before a request leaves, dedupe, cursors and provenance. A source
  writes nowhere but its output.
- **The collected ledger** `collected/<source>.jsonl` (in git, append-only) is the only state of
  collection: cursors and delivered keys. It commits with the run.
- **No model in a source.** Collection is code; the AI may repair a source on the draft, and a
  person switches the fix on.
- **Module kinds lose `integration`.** A module stays a packaging unit (jurisdiction, layouts,
  capabilities).

## Consequences

- Vendor-specific collection and booking leave the public app; a company's sources live in its
  workspace.
- Source code runs in a child process behind a fence (permission model, a static check, deleted
  globals). Node cannot deny the network, so this is a fence against mistakes among the company's
  own people, not a boundary against malice; a cloud runtime replaces the child's launcher.
