# Upgrades

**Status: proposed.** Upgradability is the reason for the module split. A company that changed
one invoice header should own one file, not a fork of the app, and keep receiving every fix.

## Five version numbers

| What | Version | Where | Changes when |
|---|---|---|---|
| The app | SemVer, 0.x | `package.json` | each release (`docs/releasing.md`) |
| The books format | `schema` | `books.json` | the record shape changes; a ladder step in `src/workspace/schema.ts` |
| The workspace format | `schema` | `belege.workspace.yaml` | the same, for the manifest |
| A module | `version` (CalVer for law data) and `schema` | `module.yaml` | the module's data changes / its file format changes |
| A contract or engine | major version | `provides`, `requires` | a breaking change; contracts only grow within a major |

The first three exist today. 0.4.0 adds the last two and one file:

**`modules.lock.json`** in the workspace, written by the app and never by hand. It records, per
module: the shipped version, the overlay's `basedOn`, the contract versions, the provider
chosen for each capability, and a hash of each overlaid key's upstream value. ADR 0004's record
envelope and seals stay as they are; the lock file sits beside them, not inside the seal.

## The update cycle

1. **Replace the app.** The Mac app updates itself; a clone pulls. The workspace is untouched.
2. **Climb.** Old `books.json`, workspace and module schemas climb in memory. Nothing is
   written back until `npm run update` or the update dialog.
3. **Resolve.** Each overlay merges onto its shipped module, key by key.
4. **Classify each key:**
   - **flows silently**: upstream changed a key the company never touched;
   - **notice**: upstream changed a key the company replaced; the company keeps its value until
     it decides (Firma › Module);
   - **refuse loudly**: a module needs a contract or engine major the app no longer has; the
     affected function stops with a sentence that says why, and never falls back to a default
     that books wrongly.
5. **Check.** References, formulas, codes; then the figure delta on the open period, and the
   0535 difference on every filed quarter, each explained by correction cases.
6. **Gate.** If a figure changes, a person switches the new state on. Otherwise the update is
   done.

## What can never happen on upgrade

- A filed quarter's figures change. The seal check refuses the books first.
- A rate applies before its validity date. Rates carry `from:`/`to:`.
- A company's overlaid key silently reverts to upstream.
- A module keeps booking after its contract went away.

## How a release proves it is safe

| Check | Proves | Exists today? |
|---|---|---|
| demo golden master | figures of the demo workspaces | yes (`npm test`) |
| `test:books` | figures of a real workspace | yes |
| overlay fixture: one invoice overlay, one rate overlay | flows / notice / refuse classify correctly | no |
| `xx` jurisdiction | the core names no country | no |
| old-workspace fixtures (0.3.0 demo snapshot) | a 0.3.x workspace opens and climbs | partly (`update.test.ts`, `schema.test.ts`) |

## Changelog

Every release says per module what changed, so `npm run update` can print it. A changed rate or
formula in a shipped module is **⚠ figures** even when no engine changed.
