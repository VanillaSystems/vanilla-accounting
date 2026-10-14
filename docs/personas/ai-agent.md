# AI agent (Claude Code, Claude Cowork, Codex)

Not a person but an actor: a coding or office agent that a person runs on the workspace, on that
person's own subscription. The owner and the bookkeeper use it for bulk work; it could serve
the Treuhänder too.

## Jobs

Whatever its person asks, within the app's rules: collect receipts from the mailboxes, import
statements, match receipts to payments, propose and book entries, explain a figure, prepare a
VAT return for review.

## Where it works

- **On the workspace** (the company's data repository), guided by its `AGENTS.md`, the process
  flows and guides, and the company's knowledge (suppliers, rules).
- **Through the app's commands** (`npm run …` today, the `vanilla` CLI later), never by editing
  the books' files directly. The commands enforce the rules (closed periods, VAT logic) and record
  the change.
- Inside the app, for single steps (extract a receipt, classify a payment), the app calls the
  model itself through the `claude` CLI on the subscription (`src/llm/ask.ts`); the Codex CLI is
  the counterpart for OpenAI subscribers. An API key is supported for the rare company without a
  subscription.

## What it may change

What its person may change, and every change carries that person as author and the agent as
the tool ("Anna via Claude Code").

## What it needs from the app

- Commands for every step, with clear refusals ("Q2 is closed; book the correction in Q3").
- The rules as files in the workspace, so the company teaches its agent without forking the app.
- A cost ledger per step (`data/llm-ledger.jsonl`), so the owner sees what the agent spent.

## Risks and pains

- An agent with write access to the books' files can do anything; the commands, not the agent's
  good behaviour, keep the books consistent.
- Two agents (or an agent and a person) writing at once hit the same multi-writer problem as
  the bookkeeper.
