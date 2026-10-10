# ADR 0006: The desktop shell: a single program first, Electron later

Status: accepted (2026-10-10). Nothing built yet; last in the order of work of
[ADR 0003](0003-deployment-and-collaboration.md).

## Problem

Company members run the app locally ([ADR 0003](0003-deployment-and-collaboration.md)). The
owner is technical; a bookkeeper or an employee who helps with the books may not be. The app's
engine is Node and TypeScript (an Express server, the rules, the books), and local-first adds
needs a plain web page cannot meet: git built in for people who have never installed it, a Sync
button, the conflict view, native file dialogs, and automatic updates.

Today the app starts with `npm start` from a clone of the app repository, which assumes Node,
git and a terminal, and makes every company a fork.

## Options

| Option | Size | Fit |
|---|---|---|
| **Electron** | large (~100 MB and more) | Brings Chromium and Node; the server runs inside unchanged. Mature auto-update. GitHub Desktop is built on it with git embedded (`dugite`), which is this app's case. Same rendering on every system. |
| **Tauri** | small (~10 MB) | Rust shell with the system's web view. The Node server would have to ship beside it as a bundled program (a sidecar), which takes most of the size advantage away; rendering differs between Safari's engine (Mac) and Edge's (Windows). |
| **Electrobun** | small | TypeScript on Bun with the system's web view, closest to this stack. Young: maturity, Windows support and updates are a risk (an assessment at the time of writing, to check again). |
| **No shell** | smallest | One executable (Node or Bun compiled) that starts the server and opens the browser; installable as a web app from the browser. No built-in git, no automatic update, no native dialogs. |

## Decision

1. **First, no shell:** the `vanilla` CLI ([ADR 0005](0005-agents-command-registry-cli-mcp.md)) as
   one executable; `vanilla open` serves the UI and opens the browser. It covers the owner,
   developers and every agent, at no cost, and needs no desktop decision.
2. **Then Electron,** once a company member without a terminal needs to work locally: its own
   window, git built in, Sync, the conflict view, the MCP server for Claude Desktop and Cowork,
   automatic updates, and the `vanilla` command installed alongside. Electron is the proven way
   to ship a web UI with Node and git built in; its size does not matter on a bookkeeper's
   machine.
3. **Look at Electrobun again** when step 2 starts; if it is stable then, it is the lighter path
   with the same stack.

`npm start` from a clone of the app repository stays the path for developers and for anyone who
forks; companies adapt the app through their workspace and keep every upgrade.

## Consequences

- The app becomes an installable package with a single entry (`vanilla`); the server, the UI
  and the commands do not depend on being run from the repository.
- Signing for Electron costs the vendor an Apple developer account (about USD 99 a year) and, for
  Windows, a code-signing certificate; the company pays nothing.
- The Treuhänder and the auditor never install any of this: they use a cloud instance or a
  static export in the browser ([ADR 0003](0003-deployment-and-collaboration.md)).

## Rejected

- **Tauri:** small only without the Node server, which this app needs.
- **Electron from the start:** a desktop app before anyone needs it; the CLI comes first and
  serves the people who exist today.
- **`npm start` from a clone as the path for companies:** needs Node, git and a terminal, and
  makes every company a fork.
