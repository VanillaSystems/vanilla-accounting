# ADR 0004: Versions across clones, and the record envelope

Status: accepted (2026-10-10), revised the same day after two outside reviews (Codex). Builds on
the versioning in [releasing.md](../releasing.md) and `src/workspace/schema.ts`; nothing of this
built yet.

## Problem

The app already versions itself and its data: Semantic Versioning for the app, and a `schema`
in `books.json` and `belege.workspace.yaml` with a ladder of pure, forward-only migration steps
(`BOOKS_SCHEMA`, `WORKSPACE_SCHEMA`). The seals of closed quarters (`src/books/seal.ts`) are the
SHA-256 of the canonical JSON of every closed entry, transaction and mapping, all fields
included; they refuse a step that changes a closed record.

Local-first ([ADR 0003](0003-deployment-and-collaboration.md)) brings several clones, branches,
several app versions at once and cloud instances. Three questions follow: what keeps different
versions from damaging the books, does each record need sync metadata (as the base object of
SAP Field Service Management's data API does), and how is metadata added without breaking the
seals.

## Decision

### Versions across clones and branches

- **The workspace has one data version** (`VERSION`, the successor of the per-file `schema`
  once the data is split by year). Every file of a workspace is at the same version.
- **Unknown versions fail closed.** An app that finds a workspace newer than itself may read it
  only if it has an explicit reader for that version; it never writes it, and says "please
  update".
- **A migration is a finalization** ([ADR 0003](0003-deployment-and-collaboration.md), section 6):
  run on `main`, by a maintainer, under the finalization lock, committed on its own and pushed at
  once. It is never done inside a merge.
- **Open branches are migrated before they are merged.** Before work from a branch is taken
  over, the app migrates that branch to the version of `main` as an explicit step on the branch
  (the merge base included, by migrating from where the branch left `main`), and only then
  merges. The merge driver refuses to merge sides at different versions.
- **An interrupted migration** leaves the workspace at the old version (the migration commits as
  one unit) or is resumed from its recorded intent.
- **Contracts with what updates separately are versioned on their own:** the HTTP API of a cloud
  instance (`/api/v1/…`) and the upload format for receipts (`"v": 1`). A contract stays
  compatible for several app versions.

### Upgrades in a mixed environment

Apps update on their own schedules: each member's desktop app or CLI, each cloud instance, the
phone app through the App Store. The repository does not change when an app does. SAP FSM solves
this with a server that stores the newest shape and translates for every client; there is no such
server here, the files are the storage. The same goal is reached by these rules.

**The workspace format is the one authority.** `VERSION` names the workspace's storage format.
Each app declares, in code, which formats it can **read** and which it can **write**. An app
writes a workspace only if it can write that exact format; a version range of app releases does
not establish that. A minimum app version in the workspace is used only to exclude a release
with a known defect.

**Compatibility is checked inside every write transaction,** not only at start and sync: a
running process whose workspace changed underneath it (a pull, a take-over, another process)
refuses the write instead of applying it. A desktop app that opens several workspaces checks
each one separately.

| The app finds | It does |
|---|---|
| a format it can write | works normally |
| an older format it can read but not write | read-only; offers the owner the migration ("Datenformat aktualisieren") |
| a newer format it cannot read | stops with an update and recovery screen; nothing is written |

**Changes without a format change are the exception, not the rule.** A new field may be added
without raising the format only if an older app can safely ignore it **while editing the same
record**: a free-text note, a display hint. A field that takes part in an invariant, a
validation, an enum, a calculation or the meaning of other fields (an allocation, a VAT detail,
a new kind of entry) raises the format, because an older app that preserved the field but
changed the amount next to it would leave a record that looks intact and is wrong. Preserving
unknown fields guards against losing data, not against corrupting it.

**Unknown fields are preserved, and that is an implementation duty.** Writes keep the raw
persisted record and apply a validated patch to the known fields, instead of rebuilding the
record from a domain object (which drops what the object does not know; today's `manifest.ts`
would). Defaults for missing fields live in the in-memory view, never written back unless an
explicit migration writes them. Round-trip tests run through the real write paths (UI, CLI, MCP,
merge), nested unknown fields included.

**Closed records keep their historical shapes forever.** A workspace at format 8 still holds
records sealed under format 1. So the app keeps a reader for every historical record shape and
the seal verifier for every `sealVersion`, and normalizes old shapes into the in-memory view.
"Expand and contract over two releases" applies to the storage format and to open records; it
never removes the ability to read and verify a closed record.

**A format change is an owner event:** a finalization on `main`, under the lock, as its own
commit ([ADR 0003](0003-deployment-and-collaboration.md), section 6). Open branches are upgraded
explicitly at take-over, with the merge base normalized, before records are merged. A bookkeeper
who keeps writing an old branch afterwards is not blocked on her machine, but her work is
upgraded at take-over, and her app stops as soon as it pulls the newer format.

**Cloud instances run an exact version.** The instance's deployment state records the exact app
artifact it runs, not a range. A migration commit and a redeployment cannot be one atomic step:
after a migration the instance is write-disabled until it is redeployed with a version that
writes the new format; the redeployment is retryable and shown to the owner until it succeeded.

**What updates separately keeps its own contract:** the HTTP API (`/api/v1/…`) and the receipt
upload format (`"v": 1`), compatible for several app versions (see above).

### The record envelope, outside the seals

New records carry a small envelope beside their own fields:

```json
{
  "id": "je_7Hq2Xb…",
  "createdAt": "2026-10-10T14:03:11Z",
  "origin": "import",
  "deleted": false
}
```

| Field | Why |
|---|---|
| `id` | Stable and never sequential, so records created on two clones cannot collide. Receipts keep the SHA-256 of their file, bank transactions the bank's reference within its account; new entries and manual transactions get a random id. Existing references (`M2026-001`) stay. |
| `createdAt` | When it came into the books. Only known for records created after the change; never invented from the accounting date. Absent means unknown. |
| `origin` | How it came about: `import`, `classify`, `manual`, `correction`. Absent means unknown. |
| `deleted` | A deletion is a flag, so "deleted on one side, changed on the other" is a visible conflict. |

**Closed records are not touched.** A record dated in a closed period keeps exactly the fields
it was sealed with: the migration adds no envelope to it, and the seal verifies it with the
algorithm it was written with. Concretely:

- The envelope fields are optional in the record type; records of closed periods simply lack
  them, which reads as unknown.
- Closed records already have stable identities, the ones the seal groups them by: an entry its
  `id`, a transaction its `ref`, a mapping the pair `transactionRef ↔ receiptId`. The migration
  adds no `id` field to them; the merge driver uses those keys.
- The seal's canonical JSON sorts keys and skips absent fields (`canonical` in
  `src/books/seal.ts`), so a closed record without envelope fields hashes exactly as before.
- A seal records the algorithm and the record format it hashed (`sealVersion`). Splitting the
  storage into years and lines changes where records are stored, not their canonical JSON; the
  verification reads the records back into the same canonical form and hashes it as before. A
  test proves every existing seal still verifies after the migration, in addition to the golden
  master proving the figures.
- A later seal format, if ever needed, is a new `sealVersion`; old seals are never rewritten.

Deliberately **not** in the envelope: `updatedAt`, `updatedBy`, revision counters, per-type
versions. Git records who changed what and when, and gives every merge its common base. The
concurrency check a write needs ([ADR 0003](0003-deployment-and-collaboration.md), section 7)
uses the record's content hash as the expected state, so no counter is stored.

## Rejected

- **A version per record type** (as SAP FSM's DTO versions): FSM needs them because many clients
  of different ages talk to one server at once. Here a newer app migrates the whole workspace;
  where clients of different ages do meet (the API, receipt uploads), the contract is versioned.
- **Change metadata in each record** (`updatedAt`, `updatedBy`, `rev`): duplicates git, and
  creates conflicts on every edit.
- **Adding the envelope to every record, closed ones included:** it would change the canonical
  JSON of closed records and break their seals, although no figure changes.
- **Inventing `createdAt` from the accounting date:** a guess presented as a fact in an audit
  trail.
- **Migrating inside the merge driver:** a per-file driver cannot migrate a workspace, and two
  branches migrated separately do not converge when their inputs differ.
- **"Tolerant reader" as write compatibility:** preserving unknown fields keeps data, it does not
  keep it correct; an old app editing next to a field it does not understand can corrupt the
  record.
- **An app-version range in the workspace as the compatibility rule:** releases do not prove
  which formats they write; the formats an app declares do.
- **N and N−1 only:** closed records keep their shapes forever; historical readers stay.

## Consequences

- `schema.ts` moves from two per-file versions to one workspace version, with the same ladder
  and the same rules ([releasing.md](../releasing.md)).
- The seal gains `sealVersion`; a test verifies every existing seal after each migration.
- New records get the envelope; closed records keep their sealed shape.
- An app refuses to write a newer workspace, and the merge driver refuses to merge across
  versions; branches are migrated before take-over.
- Each app declares its readable and writable formats; every write checks them.
- Writes become raw-record patches; round-trip tests cover every write path.
- The app keeps readers for every historical record shape and every `sealVersion`.
- [releasing.md](../releasing.md) changes: "`npm run update` writes the new format" holds for a
  workspace with a single writer; with a contributor or a cloud instance, the migration is the
  owner's event on `main`.
