# ADR 0006: Distribution: a Claude plugin first, then a single program, then Electron

Status: accepted (2026-10-10), revised the same day (plugin first, git inside the app, GitHub
first). Section 2 built 2026-10-11 (release track A): pdf.js text in `src/parsers/pdf-text.ts`,
pdf-lib for photos, isomorphic-git in `src/workspace/git.ts`; the ImageMagick row became
pdf-lib, and no WASM OCR was needed since the vision path covers scans.

## Problem

Company members run the app locally ([ADR 0003](0003-deployment-and-collaboration.md)). The
owner is technical; a bookkeeper may not be. Today the app starts with `npm start` from a clone of
the app repository, and needs Node.js, npm, `pdftotext` (poppler), ImageMagick, `git` and the
`claude` CLI. That is a developer's setup, and it makes every company a fork.

The goal: **download one thing, double-click, and start in Claude Cowork,** with no terminal, no
npm and no git command.

## What makes that possible

- **Claude Desktop installs MCP Bundles (`.mcpb`, formerly `.dxt`) with a double-click.** A bundle
  is a zip with an MCP server, all its dependencies and a `manifest.json`.
- **Claude Desktop ships its own Node.js** on macOS and Windows; a bundle's Node server needs no
  installed runtime.
- **Claude Cowork has full MCP and plugin support, local servers included.** A **plugin** bundles
  MCP tools with Skills and slash commands, and works in Cowork and in Claude Code.

## Decision

### Four forms, in this order

| | Form | For | Install |
|---|---|---|---|
| **1** | **Claude plugin with an MCP Bundle** | owner and bookkeeper with Claude Desktop or Cowork | download, double-click |
| 2 | `vanilla` CLI as one executable (Bun or Node single executable) | developers, Claude Code, Linux | `curl … \| sh`, Homebrew, or a download |
| 3 | Electron app | when a second person needs a window with Sync and the conflict view | download |
| 4 | `npm start` from a clone | developers of the app | as today |

All four run the same engine and the same command registry
([ADR 0005](0005-agents-command-registry-cli-mcp.md)).

### 1. The plugin

- **MCP tools** from the registry (the 10 to 15 coarse tools), **Skills** for the bookkeeping jobs
  ("Buchhaltung einrichten", "Eingang verarbeiten", "Quartal abschliessen"), and the company's
  knowledge read from its workspace. The Skills carry what `AGENTS.md` and the process guides
  carry today, delivered with the app.
- **In plugin mode the agent is the model.** The app's own model calls (`claude -p`) need Claude
  Code, which a Cowork user does not have. The tools therefore hand judgment to the agent ("these
  12 receipts are unread, here is their text"; "save this classification") and the model work
  runs on the user's subscription through Cowork.
- **The UI comes with it:** a tool starts the local server on request and opens the books in the
  browser.
- **Limits:** Claude Desktop runs on macOS and Windows, not Linux (Linux takes the CLI); Cowork
  needs a paid Claude plan; a bundle downloaded from the website does not update itself, a
  listing in the Desktop Extensions gallery would.

### 2. No external programs

Everything runs on a JavaScript runtime the app does not install (Claude Desktop's Node, or the
runtime inside the single executable or Electron), so the engine uses libraries, not programs:

| Today | Instead |
|---|---|
| `pdftotext` (poppler) | pdf.js |
| ImageMagick | a JavaScript or WebAssembly library (`pdf-lib` to wrap images, a WASM codec to compress own scans, [ADR 0008](0008-ingestion-one-inbox.md)) |
| `git` | a pure-JavaScript git (for example `isomorphic-git`), see 3 |
| `claude` CLI | the agent in Cowork (plugin), or the `claude` CLI where installed |

Native add-ons are avoided: they do not travel inside a bundle or a single executable reliably.

### 3. Git inside the app, GitHub first

Nobody types a git command. The app does git itself:

- **Sync** ("Synchronisieren", a button or "synchronisiere meine Buchhaltung" in Cowork): fetch
  `main`, bring it into the person's branch, push the branch. Merging is the app's own
  record-level merge ([ADR 0003](0003-deployment-and-collaboration.md)), not git's.
- **Pure-JavaScript git over HTTPS.** It clones, fetches, commits and pushes; it does not speak
  SSH, and it has no built-in Git LFS (as far as known when writing), which fits keeping PDFs in
  plain git for now.
- **GitHub is the one supported host at first.** "Mit GitHub verbinden" uses GitHub's device-code
  login (the app shows a code, the person confirms it on github.com); the key is kept in the
  operating system's keychain. No token is copied, no SSH key is made.
- **The owner never needs github.com either:** "Sicherung einrichten" creates the private
  repository through GitHub's API and pushes the books; "Buchhalterin einladen" sends the
  invitation.
- **What remains for a bookkeeper:** a GitHub account, made once, and accepting the invitation
  by e-mail.
- **Protection of `main` needs a paid GitHub plan for private repositories** (Pro or Team, as far
  as known when writing; check the prices). Alone, the free plan is enough; with a contributor,
  the company needs a paid plan, or only the app's local guard protects `main`.
- **Other hosts later:** the sync layer is plain git over HTTPS and stays host-neutral, so
  GitLab, Bitbucket and others can be added as adapters (login, repository creation, branch
  rules) without rebuilding it. Until then they are not supported. A remote reachable only by
  SSH or a network share needs the CLI with an installed git.

### 4. Electron, when a second person needs it

The Electron app adds a window of its own with Sync, the conflict view and automatic updates,
and installs the `vanilla` command and the plugin alongside. It comes when a company member
without Claude Desktop, or a second writer, needs it. Electrobun is checked again then.

## Consequences

- The engine drops its external programs (pdf.js, a WASM codec, pure-JavaScript git) before the
  plugin can ship.
- The command registry gains tools that let the agent supply judgment, beside the app's own model
  calls.
- Signing costs the vendor an Apple developer account (about USD 99 a year) for the single
  executable and Electron; the plugin is signed through its own mechanism.
- A GitHub adapter: device-code login, keychain, repository creation, invitations, reading branch
  protection.

## Rejected

- **npm as the way in for companies:** needs Node, npm and a terminal, and makes every company a
  fork.
- **Electron first:** a heavy download before anyone needs a window of its own; the plugin
  reaches the owner and the bookkeeper inside the agent they already use.
- **Bundling poppler, ImageMagick or git as programs:** they do not travel inside a bundle
  reliably; libraries do.
- **Tauri:** small only without the Node server, which this app needs.
- **Every git host from the start:** each needs its own login and API adapter; GitHub covers most
  companies, the sync layer keeps the door open.
