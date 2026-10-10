# ADR 0007: External references and annotations, not a custom-object platform

Status: accepted (2026-10-10), after an outside review (Codex). Nothing built yet.

## Problem

Companies connect their books to their own systems. SAP Field Service Management shows how much
that matters: its user-defined fields (UDF), user-defined objects (UDO) and `externalId` are,
for many customers, the most used part of the data model, because that is where their own
references live.

The books already carry such references, without a shared form: the bank's reference, Shopify
order numbers (`SHOPIFY-1001`), AliExpress order numbers, the ESTV reference in a camt line, a
parking lease behind a standing order, the company car behind a private share. A company will
also want its own fields: an internal order number on a receipt, a category tag, a project.

Two constraints shape the answer:

- **Closed records never change** ([ADR 0004](0004-versions-and-record-envelope.md)): their
  seals hash every field. Tagging a receipt from a closed quarter must still be possible.
- **What the books say must not drift.** A sealed value is safe only if its meaning is frozen
  too. A sealed `costCenter: "sales"` whose definition is edited later changes old reports while
  every seal still verifies.

## Decision

### 1. External references: scoped, several per record

A record may carry any number of external references, each scoped so that two systems, two
shops or two kinds of object cannot collide:

```json
{ "source": "shopify", "account": "shop-eu", "kind": "order", "id": "1001" }
```

- **Several per record:** one payout covers many orders; one receipt may belong to an order, a
  payout and a CRM deal.
- **Searchable and exportable** everywhere; agents may read and set them.
- **References that steer imports are protected.** Where a reference decides deduplication on
  import (the bank's reference, a statement line's identity), it is part of the record's
  identity and changes only through a dedicated command with a uniqueness check. Other
  references (extracted by an agent, typed by a person) are freely editable.

### 2. Annotations: a company's own fields, beside the books

A company defines its own fields in the workspace (`annotations.yaml`):

```yaml
- key: bestellnummer        # a stable key, never reused
  label: Interne Bestellnummer
  type: text                # text | number | date | tags
  on: [receipt]
- key: kategorie
  label: Kategorie
  type: tags
  options:                  # options have stable ids; labels may change
    - { id: mat, label: Material }
    - { id: mkt, label: Marketing }
    - { id: rei, label: Reise }
  on: [receipt, entry]
```

- **Values live beside the record, not in it:** one annotation record per target, keyed by the
  target's identity (an entry's `id`, a transaction's `ref`, a receipt's hash), holding that
  target's external references and field values. It is outside every seal, so an annotation may
  change even in a closed period, and it is versioned, merged by record and conflict-checked
  like any other record. Because it is keyed by identity, not by year, an undated receipt or a
  record whose date changes needs no special rule.
- **Annotations never drive the official books.** No VAT figure, balance, return, seal or closing
  check reads an annotation. Management views (a list filtered by `kategorie`, an export
  column) may use them, and say that they show the company's current tags, not the closed
  accounts.
- **Types start small:** text, number, date and tags. References between records and custom
  objects come only when a concrete workflow needs them (see Rejected).
- **Definitions evolve without breaking values:** a key is never reused or retyped; a field that
  is no longer wanted is retired (hidden, values kept), not deleted. An option keeps its id when
  its label changes.
- **Typed, labelled, defined:** a value whose key is not defined is kept but not shown as a
  field; there is no free-form JSON bag.
- **Where they appear:** in a record's detail ("Angaben"), as list filters, as export columns;
  an agent may fill them ("read the order number from the receipt") through the command layer
  ([ADR 0005](0005-agents-command-registry-cli-mcp.md)).

### 3. Accounting dimensions are a product feature, not configuration

Anything that changes what the books say (a cost center that splits the income statement, a
project with its own result) is designed into the app deliberately: with stable identities,
part of the booking record, sealed with it, and with its meaning frozen for closed periods. It
is never a switch a company flips on an annotation.

## Rejected

- **User-defined objects now** (Projekte, Fahrzeuge, Verträge as company-defined record types):
  they bring schema evolution, deleted targets of references, cycles, objects missing from a
  cloud instance's window, merge conflicts across objects and a generic UI. That is a platform,
  for one developer, before any customer needs it. They come back when a concrete workflow asks
  for one, possibly as a product feature (a contract behind a standing order, the car behind a
  private share) rather than a generic object type.
- **An `affectsBooks` flag on annotations:** flipping it would change where existing values live
  and whether they are frozen, and a sealed value whose definition stays editable lets history
  change without any seal noticing.
- **Annotations inside the booking record:** tagging an old receipt would change a closed record
  and break its seal.
- **One `externalId` per record:** one payment covers several orders, and ids collide across
  systems, shops and kinds.
- **A free-form `custom` JSON field:** fields nobody can find, type or export.

## Consequences

- A new record kind, the annotation, with the base envelope ([ADR 0004](0004-versions-and-record-envelope.md)),
  stored one per target and merged by record.
- `annotations.yaml` in the workspace, read by the UI, the exports, the command layer and the
  agents.
- The existing implicit references (bank reference, `SHOPIFY-…`, order numbers in descriptions)
  can move into scoped external references for open records; closed records keep theirs where
  they are, and their annotation can repeat them.
- Reports keep reading only booking records; a management view that uses annotations is labelled
  as such.
