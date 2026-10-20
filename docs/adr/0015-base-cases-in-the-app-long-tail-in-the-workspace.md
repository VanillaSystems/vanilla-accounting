# ADR 0015: Base cases in the app, the long tail in the workspace

**Status: proposed.** The general rule is in the open-architecture research, page «What the app
ships, what the workspace grows». This ADR applies it to Vanilla Accounting.

## Context

Every company collects receipts, books payments and files VAT a little differently. Mailboxes
sit at different providers, vendors hide invoices behind portals, exports come in odd formats.
Building each variant into the app would never finish, and most of it would serve one company.
Leaving everything to each company would make every workspace rebuild the dangerous parts
alone. An LLM in the workspace can write small, specific code on site with the person who knows
the case (ADR 0014: a source may live in the app or the workspace; R10 and R12 in
docs/0.4.0/collection-requirements.md).

## Decision

**The app ships, for every common path:**

- the happy path, working from start to finish with no help
- the empty state, which says what to do first
- the base errors, said plainly and turned into a task for a person (R7)
- the way out: whatever the app can't do automatically, a person can do by hand (MISSION.md)

**The app also owns** the invariants (records, closed periods, permissions, the write door,
seals), the security boundaries (a source's reach, the secret store, the macOS permissions the
app asks for), the rules that produce figures (VAT, filings), and the contracts workspace code
builds on (channels, rule and source formats, schemas).

**The workspace grows** what is specific to one company: its suppliers and customers
(`knowledge/`), its booking rules and precedents, its sources for a particular mail provider,
portal or export, written by the AI with the person and approved by the person through the
source's reach, in plain words.

**Where the line runs,** in the order to ask:

1. A mistake could change a filed or sealed figure, lose data or widen access: the app.
2. It is a boundary other code must not cross: the app.
3. Most companies of the target group need it in the same form: the app, as a base case.
4. It belongs to one company, vendor or provider, or changes when someone else's page
   changes: the workspace.
5. It can be built on what the app offers: the workspace. If it can't, add the missing
   contract to the app, not the special case.

When unsure, prefer the workspace. Promote a workspace solution to the app once several
companies need it in the same form.

## Applied to collecting receipts

| In the app | In the workspace |
|---|---|
| The channels a source uses: IMAP, the mail program on this Mac, a browser session, a folder, each enforcing its reach, holding secrets and asking for permissions | The source on top: which account, which senders, what counts as a receipt, how one vendor's portal works |
| One reference source per channel (`sources/imap/` today), as the base case and as the example the AI starts from | Sources the AI writes for one provider or portal, and repairs when a page changes |
| Deduplication, cursors, the run ledger, recovery to a task, the «ohne Beleg» safety net | Precedents and rules learned from the person's answers |
| The setup flows a non-technical person can follow (docs/personas/README.md) | The AI conversation that applies them to this company |

## Consequences

- App code that branches on one vendor, customer or provider is a defect: move the branch to a
  module's data or to the workspace.
- A new kind of source starts with a channel in the app and a small reference source, not with
  a finished connector per provider.
- The app's base errors must stay loud. A failure the workspace never sees can't be fixed there.
