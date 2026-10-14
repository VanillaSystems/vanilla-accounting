# INSPIRATION.md template

Copy this to the root of an inspiration repo as `INSPIRATION.md` and fill every section. Keep it
under two pages: it routes a reader to the material and does not repeat it.

```markdown
# <Program> <version>, for Vanilla Accounting

**Program:** <name, version, vendor>. **Build studied:** <file, sha256>.
**Jurisdictions:** <cc, cc>. **Method:** <clone | runtime | static | manuals>, and what each covered.
**Last updated:** <date>.

## Read in this order
1. <file>: <what it answers>

## Maturity per area
| Area | State | Where |
|---|---|---|
| Ledger | done / partial / todo | <path> |

## Delivered for the comparison
- `features.yaml`: <n> of <m> capability ids filled
- `scenarios/<cc>.yaml`: <n> scenarios
- `jurisdictions/<cc>.md`: <yes/no>
- glossary column in `CONTEXT.md`: <yes/no>

## How this program extends and upgrades
<Scripts, plugins, templates, file-format upgrades: what a user can change, and what survives an
update. Answers the `platform.*` capabilities.>

## Evidence tags used here
<This repo's tags, and how they map to verified / observed / documented / inferred / unknown.>

## Private: never copy into a public repo
<Paths of vendor material: manuals, help text, installers, data files, decompiled code.>

## Open questions
<What nobody could settle, and what would settle it.>
```
