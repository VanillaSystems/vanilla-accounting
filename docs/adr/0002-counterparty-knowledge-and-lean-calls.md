# ADR 0002: Counterparty knowledge and lean model calls

Status: accepted for the process layer (2026-10-07). Code (`decide()`, lean caller) not built yet.

## Problem

Every model call in the app carried everything. `claude -p` runs from the repo,
so each call loaded Claude Code's system prompt, tool schemas, CLAUDE.md,
AGENTS.md, auto-memory, hook injections and skill listings before the prompt
began. On top of that, every classify batch carried rules for every vendor
(`CLASSIFY_INSTRUCTIONS`, 6.2 KB), the full chart, the full MWST table and
2025 samples. Vendor knowledge had five homes: the step guides, the runbook,
AGENTS.md, `prompts.ts`, and patterns in code (`GROUPED_VENDOR_PATTERN`). The
owner's model is per company: "if it's a Coop Pronto case, give it just
Coop Pronto."

## Measured

`claude -p --model sonnet --output-format json`, prompt "Reply with OK", 2026-10-07:

| Invocation | Tokens before the prompt |
|---|---|
| from the repo (today) | 27,525 cache-created + 8,532 cache-read ≈ **36,000** |
| empty cwd, `--system-prompt <short> --tools "" --strict-mcp-config --disable-slash-commands --setting-sources ""` | **627** |

The lean call works on the subscription (OAuth). `--bare` would also work, but
it requires an API key, so it is not used.

## Decision

1. **One file per counterparty with particulars:** `processes/counterparties/<id>.yaml`
   (since 2026-10-09 `processes/<suppliers|customers|authorities>/<id>.yaml`, and
   the company's part in `knowledge/`; see processes/README.md).
   It holds `match` (signals), `grouped`, `accounts`, and rules per step under the
   step's exact `with.guide` address. Guides keep only rules that hold for any
   company. The placement test: *would it still be true for a company we have
   never seen?*
2. **Code routes every item, deterministically**
   (`src/knowledge/counterparties.ts`: `merchantOf`, `identify`). Signal tiers
   are uid > domain > tx > file, and the strongest tier that matches decides.
   Exactly one match means known. Two or more means ambiguous, and the item goes
   to `new_case`. No match means unknown, and the item gets generic rules only.
   No model routes items, and an item never gets a guessed vendor context.
3. **Gates** (closed period, unsettled, no receipt, Wise fee, own transfer,
   human-answered) live in the guides under `gates:`. A gate with a `test:`
   name from `src/knowledge/gates.ts` is evaluated by code before routing, so
   no counterparty rule can outrank it.
4. **Model per step in the flow** (`with: { model, batch }`): who does a step is
   process shape.
5. **One lean caller and one `decide(stepRef, items)`**, still to be built. It
   applies gates, routes, groups items by (step, counterparty), and makes one
   call per group with a byte-identical system prompt. The model must cite a
   rule id it was shown, or answer `new_case`. It never picks the VAT code:
   code composes the code from the account class (`pv-prefix-from-account`)
   and the receipt's facts.
6. **The lint proves the structure on the real index** (`npm run check-processes`):
   - counterparty files parse;
   - section addresses are real steps;
   - rule ids are unique across all files;
   - each signal has one owner;
   - a UID is exclusive to its counterparty in the index;
   - no item is claimed twice in the same tier;
   - a guide rule naming a counterparty is an error;
   - `procedure:` anchors resolve to runbook headings;
   - gate tests exist;
   - section size is capped (warning);
   - hardcoded counterparty names in `src/llm` and `src/cli` are listed as migration backlog (warning);
   - `--unknown` lists unrouted merchants.

## Synthesis

The design came from three independent candidates (Opus, Fable, Sonnet) that
converged on the same shape. A Fable cross-judge scored them, and Opus was
picked as the base: exact step addresses, code-tested gates, one placement
test, and measuring first.

What was grafted in:

- **From Fable:** grouped counterparties are matched as one set per (counterparty, month) (`ai-grouped`); the unrouted-merchant backlog; the lint against counterparty names in code.
- **From Sonnet:** shared UIDs are excluded; the section-size cap; a manifest of the rule ids shown, which the model must cite.
- **From the judge:** a UID may route only when the index shows it exclusively on that company's receipts. A retail group's UID can also appear on another of its retailers' receipts, and the AliExpress and FedEx UIDs also appear on Alibaba and BAZG documents. The base design would have auto-booked such a purchase as "Coop Pronto, Tanken".

What was rejected:

- **Sonnet's "ambiguous → show both vendors' rules":** that is a mixed context.
- **A separate `core.guide.yaml`:** gates per step are more local.
- **Fable's closed `facts` enum and `documents` block:** they widen the schema before any code needs it.
- **Automatic `book:` templates with no model call:** postponed until `decide()` exists, and then only with a merchant-match guard.

## Expected effect (estimates until the ledger measures them)

| Call | Today | After |
|---|---|---|
| classify, 10 transactions | ≈ 36,000 + ≈ 5,500 fixed body + items | ≈ 627 + ≈ 1,500 narrow rules and chart slice + items |
| extract-vat, 1 receipt | ≈ 37,000 | ≈ 1,900 |
| match, 1 receipt + 20 candidates | ≈ 38,500 | ≈ 2,300 |

About 80–90% of the saving comes from the lean caller alone. Narrowing by
counterparty buys the rest. Its main value is accuracy, and one home for each
fact.

## Consequences

- A step's full rule set is spread over its guide plus the counterparty files
  that have a section for it. The lint, `grep '<file>#<step>' processes/`, and
  later `decide()` give the step view.
- Long-tail merchants get a file only when a case teaches something about them.
- `CLASSIFY_INSTRUCTIONS`, `buildMatchPrompt`'s vendor notes and
  `GROUPED_VENDOR_PATTERN` are deleted when `decide()` lands. Until then the lint
  lists them.

## Open questions

- Does `--tools Read --add-dir` work in lean mode for vision calls? Unmeasured.
- Is haiku accurate enough for classify or vat_facts? Measure with a dry run against a quarter of booked entries before switching `with.model`.
- Should `Receipt` store the sender domain, so the domain tier works after collection?
- FedEx 4030 import VAT: is it reclaimable? `fdx-import-mwst` is proposed; ask the advisor.

## Implementation reconciliation

**2026-10-07, lean caller built** (`src/llm/ask.ts`). `extract`, `extract-vat`,
`match` and `classify` now call through it, and their prompts are unchanged.
The vision calls get an absolute PDF path plus `--add-dir`, because the call
runs from an empty directory. The Read tool works in lean mode (probe: a Coop
Pronto receipt read correctly in ≈5,300 tokens including the page image).

A one-off measurement script (removed once the old call was gone) ran the same real prompts both ways, without writing to
the index:

| Call | Old | Lean | Answers |
|---|---:|---:|---|
| classify, 10 transactions | 57,854 | 22,213 | equal accuracy (see below) |
| vat_facts, 3 receipts | ≈ 38,000 each | ≈ 2,400 each | identical facts |
| match, 1 receipt | 41,304 | 5,663 | in a second run with the right transaction among the candidates, both found the booked link in 3 of 3 receipts |
| **total** | **213,216** | **35,011** | **84% fewer input tokens**, and about half the time per call |

Classify accuracy is unchanged, but the lean call is less repeatable. Scored
against the booked entries for the same 10 transactions:

- **Old way:** 6, 6 and 6 correct over three runs. Its two compared runs gave identical answers to each other.
- **Lean way:** 6, 5, 5 and 7 correct over four runs. Its runs agreed with each other on 7 of 10 transactions.

The transactions that vary are the ones with missing knowledge. The old way
booked both Post CH payments as 4010/M0 every time, which is wrong: they are
6513 Porti. A lean run once capitalised a small purchase as 1540, which
breaks the ~CHF 150 rule. Decision: keep lean everywhere. The fix for both is
narrow knowledge with an `accounts:` constraint and a cited rule id, which is
`decide()`, the next step. It is not the old harness prompt.

Sandbox run of the real CLIs (evidence kept locally): `extract-vat`
made 4 calls at ≈2,800 tokens each, and `classify` made 1 call at 12,260 for
3 transactions. There were 0 failures, and the index diff shows exactly the
expected writes. `npm run llm-usage` reports the ledger
(`data/llm-ledger.jsonl`) per step.

**2026-10-08, one path.** The API routes (vision OCR, rename suggest and batch,
receipt date, Auslage suggest) moved from `src/llm/client.ts` onto `ask`, and
`client.ts` with the `@anthropic-ai/sdk` dependency and `ANTHROPIC_API_KEY` is
gone. Vision reads the PDF through the Read tool with the same prompt as
`extract`, so the page is no longer rendered to an image first. Routes without
a guide section ledger as `ui/rename`, `ui/receipt-date` and `ui/auslage`.
The `MATCH_LLM=codex` switch in `match.ts` was deleted: it bypassed the ledger,
ran from the repo with its full context, and ignored vision.
