# AI setup on a fresh install

**Status: proposal, 25.10.2026. Nothing here is built yet.** Mockups:
[mockups/ai-setup/index.html](mockups/ai-setup/index.html). Related: #121 (Codex as a provider),
#139 and #145 (the setup conversation), #146 (Im Terminal).

The app's AI runs through the person's own CLI: Claude Code with a Claude subscription, and later
Codex with a ChatGPT subscription (#121). Today a Mac without `claude` gets one sentence
(`error.noClaude`, `ai.cli.missing`) and the setup conversation falls back to the form. This page
proposes how a fresh install reaches «KI bereit» before the person chooses or creates books, and
how the same help shows up later.

## What must hold

- **The app never reads a login.** It does not open `~/.claude`, `~/.codex`, their credential
  files or the Keychain. It asks the CLI itself (`claude auth status`, `codex login status`) and
  keeps only the answer: signed in or not, the kind of login, and for Claude the plan name.
- **The person installs, with the vendor's official installer.** The app opens Terminal with the
  command written out. Nothing runs before the person presses Enter. The command and the vendor's
  guide are on the card, so copy and paste works the same.
- **The login happens in the CLI and the browser**, with the person's own account.
- **The app notices the result by itself.** No restart, no «Ich bin fertig» button needed.
- **A way on without AI exists at every step** (MISSION: whatever the AI does, a person can do by
  hand). Reading receipts, booking proposals and the KI column need an AI. Everything else does
  not.
- **State, not reminders.** Each place states what this Mac has. Nothing nags once the person
  chose «Ohne KI weitermachen».
- **No vendor branch in the app** beyond the two CLIs the app runs (ADR 0015). Both go through
  one table of facts (program, installer, status command, plans page), as `TERMINAL_CLIS` already
  does in src/platform/terminal.ts.

## Installers as the vendors document them (checked 25.10.2026)

| | Claude Code | Codex CLI |
| - | - | - |
| Native installer (recommended by the vendor) | `curl -fsSL https://claude.ai/install.sh \| bash` | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |
| Installs to | `~/.local/bin/claude` (launcher into `~/.local/share/claude/versions/`) | `~/.local/bin/codex` (`CODEX_INSTALL_DIR` overrides) |
| Updates itself | yes, in the background | the same command updates |
| Homebrew | `brew install --cask claude-code` (stable channel, no auto-update; `claude-code@latest` for latest) | `brew install --cask codex` |
| npm | `npm install -g @anthropic-ai/claude-code`, needs Node 22 or later (installs the same native binary) | `npm install -g @openai/codex`, package declares Node 16 or later |
| Sign in | `claude` on first start, or `claude auth login`, in the browser | `codex` on first start, or `codex login`, «Sign in with ChatGPT» in the browser |
| Status without a session | `claude auth status`: JSON, exit 0 signed in, 1 not; fields include `loggedIn`, `authMethod`, `subscriptionType` | `codex login status`: exit 0 signed in, prints the method («Logged in using ChatGPT») |
| Diagnose | `claude doctor`, `claude --version` | `codex --version` |

Sources: code.claude.com/docs/en/setup, /authentication, /cli-reference;
learn.chatgpt.com/docs/codex/cli, /docs/auth, the Codex README on GitHub; `claude auth status
--help` and `codex login --help` run locally (Claude Code 2.1.x, codex-cli 0.163.0).

### A Mac without Node or Homebrew

Both native installers need only `curl` and `bash` or `sh`, which macOS has. So the recommended
path is the same on every Mac, and the card says so as a fact («Der offizielle Installer von
Anthropic. Er braucht weder Homebrew noch Node.»). The app never installs Node or Homebrew for
the person.

When the app finds Homebrew or Node, the card adds «Andere Wege auf diesem Mac» with the brew and
npm commands. Homebrew's cask does not update Claude Code by itself, and the card says that too.
npm is offered only when the Node version found fits the package.

The native installers write to `~/.local/bin`, which a fresh Mac's shell may not have on its PATH
until a new terminal opens. The app therefore looks in that folder directly, not only on the
login shell's PATH (see Detection).

## Plans (checked 25.10.2026)

The card states the minimum as a fact, with a link to the vendor's plans page, and says
«etwa 20 USD im Monat» rather than an exact price:

- **Claude Code: Claude Pro or higher.** claude.com/pricing lists Pro at USD 20 a month billed
  monthly (17 billed yearly) with «Claude Code» as a feature, and «Claude Code is included in all
  paid plans». The free plan has no Claude Code.
- **Codex CLI: ChatGPT Plus or higher.** The Codex pricing page (learn.chatgpt.com/docs/pricing)
  lists Plus at USD 20 a month with «Codex on the web, in the CLI, in the IDE extension, and on
  iOS». Free and Go (USD 8) list only the desktop app, so the CLI starts at Plus.
  chatgpt.com/pricing refused an automated read (403); the figure comes from the Codex docs.

Wording on the card: «Mit Claude Pro oder höher, etwa 20 USD im Monat. Abos bei Anthropic ↗».
No comparison, no recommendation of a plan, no tracking parameter in the link.

## The flow

Two alternatives were drawn (A and B in the mockups). Both use one component, the **CLI card**:
the program, its vendor, a state, the minimum plan and one action.

| State | What the card shows | What the app does |
| - | - | - |
| not installed | the official command, «Im Terminal installieren», the vendor's guide | finds nothing |
| installing | «Drück dort Enter», a waiting line | opened Terminal; looks every 2 s |
| installed, not signed in | version, place, «Im Terminal anmelden» | found the program; status says not signed in |
| signing in | «Im Browser ist claude.ai offen», a waiting line | opened Terminal with the login command; asks the status every 2 s |
| ready | signed in (plan), version, the test call | status says signed in; one test call answered |
| plan too small | what the CLI said, the minimum plan, the plans page, another account | the test call was refused for the plan |
| not found | «Seit 15 Minuten kein … gefunden», where it looked, three ways on | nothing after 15 minutes of waiting |

### A: «KI einrichten» before the start screen

On a fresh install the Mac app opens a «KI einrichten» page in the start screen's frame, before
the three choices. Two equal cards side by side. «Weiter» unlocks once one is ready. «Ohne KI
weitermachen» goes to the start screen, which then states the AI as a fact under its choices.

### B: the setup conversation starts with the AI (recommended)

On a fresh install the app opens straight into «Einrichtung». Its first message is the AI, with
the two cards stacked in the conversation and the answers as buttons: «Claude Code
installieren», «Codex installieren», «Ohne KI weiter». Each step answers in the conversation
(«Ich habe das Terminal geöffnet … Drück dort Enter»). When one CLI is ready, the conversation
goes on with the folder, «Ich habe schon eine Buchhaltung» or «Erst die Demo ansehen». Typing in
your own words waits for an AI. The buttons and fields work from the start, because the setup
conversation is drawn by code (src/onboarding/draft.ts), not by the model.

Consequences of B:

- The start screen is no longer the first screen on a fresh install. It stays what the app shows
  when it opens without books later, and the menu still reaches it.
- «Ohne KI weiter» keeps the conversation, with buttons and fields only, instead of switching to
  the separate form (today's `{ kind: 'form', noAi: true }` in StartScreen.tsx). The form stays as
  «Ohne KI einrichten» for those who prefer it.
- The folder becomes a question after the AI, with today's default folder as the proposal.

### From a fresh install to «KI bereit» (B, on a Mac without Node or Homebrew)

1. The app starts with no books and no AI setting: it opens «Einrichtung». The first message
   shows both cards, «nicht installiert».
2. The person clicks «Claude Code installieren». Terminal opens and shows the official command
   and «Enter: starten · Ctrl-C: abbrechen». The card says it waits.
3. The person presses Enter. The installer writes `~/.local/bin/claude`. Within 2 seconds the
   app finds it and runs `claude --version`: the card says «installiert · nicht angemeldet».
4. The person clicks «Anmelden». Terminal runs `claude auth login`, which opens claude.ai in the
   browser. The person signs in with their account.
5. `claude auth status` exits 0 with `loggedIn: true`. The app makes one test call with the
   cheapest model. It answers: «Claude Code ist bereit: angemeldet mit Claude Pro».
6. The conversation asks for the folder, and goes on as today (firm, VAT, banks).

## Detection

What the app checks, in order, for each CLI. None of it reads a credential.

1. **Found.** The program on the login shell's PATH (src/platform/login-path.ts, as today), then
   in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, and in npm's global bin when Node
   is found. The first executable wins. Its path is kept for running it, as `FoundCli.bin` is
   today.
2. **Version.** `claude --version` or `codex --version`, with a short timeout. A program that does
   not answer counts as not found, with the reason «antwortet nicht».
3. **Signed in.** `claude auth status` (JSON; exit 0 or 1) or `codex login status` (exit code).
   From Claude's JSON the app keeps `loggedIn`, `authMethod` and `subscriptionType` and discards
   the rest (email, organization, folders). Today Claude's sign-in is known only from the newest
   claude-cli call in the books' ledger (`claudeSignedIn` in src/platform/terminal-open.ts), and
   before the first call it is unknown. The status command answers before any books exist.
4. **Works.** One test call with the cheapest model, once when the status first says signed in,
   and on «Nochmals prüfen». This is the only check that catches a plan without the CLI, a region
   the vendor does not serve, or a limit reached. Its refusal is shown as the CLI said it.

**When the app looks.** Every 2 seconds while a card waits (after «Im Terminal installieren» or
«Anmelden»), when the window gets focus, and when a page with a card opens. A wait stops after 15
minutes and shows «nicht gefunden» with what was searched. Nothing polls in the background
otherwise.

**No restart.** Two caches block this today and must go in the build: the login shell's PATH is
asked once per process (`terminalPath` in src/platform/terminal-open.ts), and the desktop finds
`claude` once at start (`findClaude` in src/desktop/main.ts, `CLAUDE_BIN`). A new detection call
asks again.

**How Terminal opens.** As «Im Terminal» does today (#146): a `.command` file run by
`open -a Terminal`, which needs no permission to control Terminal. For an install, the script
prints the vendor's command and waits for Enter (`read`) before it runs it. Ctrl-C ends it. For a
login, the script runs `claude auth login` or `codex login`.

## Where the same help appears later

- **Firma › KI.** «KI-Programme auf diesem Mac» with both cards replaces the row «Claude-Abo
  (Claude Code) · bereit». The minimum plans stand in one sentence above. With both ready, «Die
  App fragt» chooses one (this also decides what «Im Terminal» opens), and an option says whether
  to ask the other when the first cannot answer.
- **The KI column without an AI.** The column says what it needs and shows the cards. The composer
  is off, with the reason as its placeholder.
- **A limit reached.** The answer states what the CLI said («Nutzungsgrenze deines Abos
  erreicht, wieder ab 18:00»). When the other CLI is signed in, «Mit Codex fragen» is offered once.
- **The error line** where `error.noClaude` shows today: «Beleg lesen braucht eine KI. Auf diesem
  Mac ist weder Claude Code noch Codex angemeldet.», with «KI einrichten» (opens the cards) and
  «Von Hand erfassen». `error.noClaude` and `ai.cli.missing` go; the new keys live in the
  dictionaries in all four languages (docs/i18n.md).
- **The start screen** after A states «KI: Claude Code, angemeldet mit Claude Pro» or «KI: keine
  eingerichtet» under its choices, with one link.

## Open questions

1. **A or B for the first run?** Recommendation: B. The owner chose the conversation for the
   move, and B makes the AI its first message instead of a gate before it. It also ends the split
   between «conversation with AI» and «form without». A's side-by-side cards stay the shape for
   Firma › KI.
2. **A test call when the CLI reports signed in?** It costs a few tokens of the person's plan.
   Recommendation: yes, once at «bereit» and on «Nochmals prüfen», with the cheapest model. It is
   the only check that sees a plan too small or a limit.
3. **Show the account (email) from `claude auth status`?** It would help someone with a work and
   a private account. Recommendation: no. Show the plan only and do not keep the email. «Mit
   anderem Konto anmelden» covers the case.
4. **Ask the other CLI by itself when one hits its limit?** Recommendation: off by default. Offer
   «Mit Codex fragen» in the answer, and keep the automatic fallback as an option in Firma › KI.
   Two subscriptions may bill differently, so the person decides.
5. **Homebrew as the main path when the Mac has it?** Recommendation: no. The native installers
   update themselves, and Homebrew's cask does not. Homebrew stays under «Andere Wege».
6. **Remember «Ohne KI weitermachen» on this Mac?** Recommendation: yes. The first run does not
   ask again. Firma › KI, the KI column and the error line keep the way back.
7. **Codex in the first run before #121 is built?** The app cannot use Codex for its own steps
   until #121 lands; today it only opens it in Terminal. Recommendation: show the Codex card in
   the first run only once #121 is merged, never as «kommt». Until then the first run shows
   Claude Code alone, and Firma › KI shows Codex for «Im Terminal».
8. **Wait time.** Recommendation: 2-second checks, 15 minutes before «nicht gefunden». A slow
   network rarely needs more for a download of this size.

## For the build (not in this PR)

Rough scope, to size the work. The mockups change no app code.

- `src/platform/ai-cli.ts`: the one table of CLI facts (program, installer, Homebrew and npm
  commands, status command, plans page), detection (found, version, status, test call) without
  caches, and the install and login scripts beside `launchScript`.
- `GET /api/ai/clis` (also before books exist, under /api/desktop) returning the card states;
  `POST /api/ai/clis/:cli/install` and `/login` opening Terminal.
- One `CliCard` component in src/app (tokens and classes as in mockups/ai-setup/ai-setup.css),
  used in the setup conversation, Firma › KI, the KI column and the error line.
- Tests: detection with a fake `claude` and `codex` on a temporary PATH (installed, signed out,
  signed in, not answering), and that no code path opens a credential file.
