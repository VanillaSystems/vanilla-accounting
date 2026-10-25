# AI setup on a fresh install

**Status: designed and decided 25.10.2026; built in the PR that closes #175** (see «As built» at the end). Mockups:
[mockups/ai-setup/index.html](mockups/ai-setup/index.html). Related: #121 (Codex as a provider),
#139 and #145 (the setup conversation), #146 (Im Terminal), #175 (a Mac with only an API key).

The app's AI runs through the person's own CLI: Claude Code with a Claude subscription, and later
Codex with a ChatGPT subscription (#121). An API key is the advanced path. Today a Mac without
`claude` gets one sentence (`error.noClaude`, `ai.cli.missing`), and the setup conversation falls
back to the form. This page describes how a fresh install reaches «KI bereit» before the person
chooses or creates books, and how the same help shows up later.

## Decisions (the owner, 25.10.2026)

1. **Design B.** The setup conversation opens with the AI (see «The flow»). Design A stays in
   the mockups as the alternative that was not chosen.
2. **A test call when a CLI or a key is first ready**, and on «Nochmals prüfen», with the
   cheapest model. It is the only check that sees a plan too small, a region not served or a
   limit reached.
3. **The plan only, no email.** From `claude auth status` the app keeps `loggedIn`, `authMethod`
   and `subscriptionType`. It does not keep the email or the organization. «Mit anderem Konto
   anmelden» covers a second account.
4. **No automatic switch when one CLI hits its limit.** The answer offers «Mit Codex fragen»
   (or the other way round). Firma › KI has an option to ask the other one by itself, off by
   default.
5. **No Homebrew and no Node anywhere.** The app brings its own runtime (Electron), the vendors'
   native installers need only what macOS has, and the CLIs they install are standalone
   programs. The app offers no Homebrew or npm way and never installs either.
6. **«Ohne KI weitermachen» is remembered on this Mac.** The first run does not ask again.
   Firma › KI, the KI column and the error line keep the way back.
7. **Codex appears in the first run only after #121 is merged**, never as «kommt». Until then
   the first run shows Claude Code alone, and Firma › KI shows Codex for «Im Terminal».
8. **Checks every 2 seconds while a card waits; «nicht gefunden» after 15 minutes.**
9. **API keys as an advanced path**: «Erweitert: mit API-Schlüssel», folded under the
   subscription cards in the conversation and in Firma › KI. The recommended way is a
   subscription: Claude Pro or ChatGPT Plus, about USD 20 a month.

## What must hold

- **The app never reads a login.** It does not open `~/.claude`, `~/.codex`, their credential
  files or the Keychain entries of the CLIs. It asks the CLI itself (`claude auth status`,
  `codex login status`) and keeps only the answer.
- **The person installs, with the vendor's official installer.** The app opens Terminal with the
  command written out. Nothing runs before the person presses Enter. The command and the vendor's
  guide are on the card, so copy and paste works the same.
- **The login happens in the CLI and the browser**, with the person's own account.
- **The app notices the result by itself.** No restart, no «Ich bin fertig» button.
- **A way on without AI exists at every step** (MISSION: whatever the AI does, a person can do by
  hand). Reading receipts, booking proposals and the KI column need an AI. Everything else does
  not.
- **State, not reminders.** Each place states what this Mac has. Nothing nags once the person
  chose «Ohne KI weitermachen».
- **No vendor branch in the app** beyond the CLIs and key providers the app runs (ADR 0015). The
  CLIs go through one table of facts (program, installer, status command, plans page), as
  `TERMINAL_CLIS` already does in src/platform/terminal.ts.

## Installers (checked 25.10.2026)

| | Claude Code | Codex CLI |
| - | - | - |
| Installer the app offers (the vendor's recommended one) | `curl -fsSL https://claude.ai/install.sh \| bash` | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |
| Installs to | `~/.local/bin/claude` (launcher into `~/.local/share/claude/versions/`) | `~/.local/bin/codex` |
| Updates itself | yes, in the background | the same command updates |
| Needs | `curl` and `bash`, both in macOS | `curl` and `sh`, both in macOS |
| Sign in | `claude auth login` (or `claude` on first start), in the browser | `codex login` (or `codex` on first start), «Sign in with ChatGPT» |
| Status without a session | `claude auth status`: JSON, exit 0 signed in, 1 not | `codex login status`: exit 0 signed in, prints the method |
| Version | `claude --version` | `codex --version` |

The vendors also offer Homebrew casks and npm packages. The app does not offer them (decision 5).
A CLI that a person installed that way is still found, because detection also asks the shell's
PATH.

Sources: code.claude.com/docs/en/setup, /authentication, /cli-reference;
learn.chatgpt.com/docs/codex/cli, /docs/auth, the Codex README on GitHub; `claude auth status
--help` and `codex login --help` run locally (Claude Code 2.1.x, codex-cli 0.163.0).

The native installers write to `~/.local/bin`, which a fresh Mac's shell may not have on its PATH
until a new terminal opens. The app therefore looks in that folder directly (see Detection).

## Plans (checked 25.10.2026)

Each card states the minimum as a fact, with a link to the vendor's plans page. It says
«etwa 20 USD im Monat» rather than an exact price:

- **Claude Code: Claude Pro or higher.** claude.com/pricing lists Pro at USD 20 a month billed
  monthly (17 billed yearly) with «Claude Code» as a feature, and says «Claude Code is included in
  all paid plans». The free plan has no Claude Code.
- **Codex CLI: ChatGPT Plus or higher.** The Codex pricing page (learn.chatgpt.com/docs/pricing)
  lists Plus at USD 20 a month with «Codex on the web, in the CLI, in the IDE extension, and on
  iOS». Free and Go (USD 8) list only the desktop app, so the CLI starts at Plus.
  chatgpt.com/pricing refused an automated read (403), so the figure comes from the Codex docs.

Wording on the card: «Mit Claude Pro oder höher, etwa 20 USD im Monat. Abos bei Anthropic ↗».
No comparison, no recommendation of a particular plan, no tracking parameter in the link.

## The flow (design B)

One component, the **CLI card**, shows a program, its vendor, a state, the minimum plan and one
action. In the conversation the two cards stand one under the other, and the answers below them
are the buttons.

| State | What the card shows | What the app does |
| - | - | - |
| not installed | the official command | finds nothing |
| installing | «Drück dort Enter», a waiting line | opened Terminal; looks every 2 s |
| installed, not signed in | version, place, «Anmelden» | found the program; status says not signed in |
| signing in | «Im Browser ist claude.ai offen», a waiting line | opened Terminal with the login command; asks the status every 2 s |
| ready | signed in (plan), version, the test call | status says signed in; one test call answered |
| plan too small | what the CLI said, the minimum plan, the plans page, another account | the test call was refused for the plan |
| not found | «Seit 15 Minuten kein … gefunden», where it looked, three ways on | nothing after 15 minutes of waiting |

On a fresh install the app opens straight into «Einrichtung». Its first message is the AI, with
the cards and the answers «Claude Code installieren», «Codex installieren» (after #121) and
«Ohne KI weiter». Below the cards, «Erweitert: mit API-Schlüssel» is folded. Each step answers in
the conversation («Ich habe das Terminal geöffnet … Drück dort Enter»). When one CLI or a key is
ready, the conversation goes on with the folder, «Ich habe schon eine Buchhaltung» or «Erst die
Demo ansehen».

Typing in your own words waits for an AI. The buttons and fields work from the start, because the
setup conversation is drawn by code (src/onboarding/draft.ts), not by the model.

Consequences:

- The start screen is no longer the first screen on a fresh install. It stays what the app shows
  when it opens without books later, and the menu still reaches it.
- «Ohne KI weiter» keeps the conversation, with buttons and fields only, instead of switching to
  the separate form (today's `{ kind: 'form', noAi: true }` in StartScreen.tsx). The form stays as
  «Ohne KI einrichten» for those who prefer it.
- The folder becomes a question after the AI, with today's default folder as the proposal.

### From a fresh install to «KI bereit»

1. The app starts with no books and no AI setting, so it opens «Einrichtung». The first message
   shows the Claude Code card, «nicht installiert».
2. The person clicks «Claude Code installieren». Terminal opens and shows the official command
   and «Enter: starten · Ctrl-C: abbrechen». The card says it waits.
3. The person presses Enter. The installer writes `~/.local/bin/claude`. Within 2 seconds the
   app finds it and runs `claude --version`. The card says «installiert · nicht angemeldet».
4. The person clicks «Anmelden». Terminal runs `claude auth login`, which opens claude.ai in the
   browser. The person signs in with their account.
5. `claude auth status` exits 0 with `loggedIn: true`. The app makes one test call with the
   cheapest model. It answers: «Claude Code ist bereit: angemeldet mit Claude Pro».
6. The conversation asks for the folder and goes on as today (firm, VAT, banks).

## Erweitert: mit API-Schlüssel

The advanced path, for a person who already pays a provider per call or cannot use a
subscription. It is folded under the cards and never the first thing the page leads to.

**What the app does with a key today** (src/secrets/secrets.ts, src/llm/providers/keyed.ts,
src/llm/steps.ts, src/llm/ask.ts):

- Two providers take a key: Anthropic (`ai:anthropic`) and OpenAI (`ai:openai`). The desktop
  keeps the key in its keychain-sealed store, once per Mac and never in the books. `npm start`
  and the CLI read `VANILLA_ANTHROPIC_API_KEY` or `VANILLA_OPENAI_API_KEY`, never the general
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, so a key exported for another tool does not make the
  app spend money unasked.
- Saving checks the key by listing the provider's models (`check` in keyed.ts). That costs
  nothing. A refused key (401 or 403) is not saved: «Der Anbieter lehnt diesen Schlüssel ab:
  nichts gespeichert.» (`error.aiKeyRefused`).
- A key can serve every step whose needs a keyed model meets (text, JSON, typed answers, PDF,
  images): reading receipts, VAT on the receipt, receipt titles, matching a receipt to a payment,
  booking, learning from a correction, saves, Tutti purchases, mail triage, and the setup
  conversation.
- A key cannot serve the KI column. Its step `sidebar` needs `agent`, which only Claude Code has
  («nur mit Claude Code»). «Im Terminal» starts a CLI, so it needs Claude Code or Codex too. The
  block says both in one line.
- Billing: each call is billed by the provider to the person's account (`ai.key.costs`). When a
  step set to a key fails, it asks the default provider. The subscription never falls back to a
  key on its own (`ai.fallback`).

**A gap the build must close (#175).** Today a key answers only the steps a person sets to it
under «Modell pro Schritt». Every other step goes to Claude Code, because `usableProviders()`
puts the CLI first and `resolve()` falls back to the first provider. On a Mac with only a key,
nothing would work out of the box. Meanwhile `GET /api/desktop/ai` counts the key as available
and starts the conversation. The design therefore assumes this rule: **when no CLI answers on this
Mac, the key's provider serves every step except the KI column.** With a CLI, the key serves only
the steps set to it, as today. Firma › KI says this in one sentence.

**States in the mockups:** folded (B1, L1), open and empty (B8), checked (B9, L6: the provider
accepted the key, one test call answered, the key is in the keychain), refused (B10, L7). The
words beside the field:

- «Statt eines Abos geht auch ein API-Schlüssel von Anthropic oder OpenAI. Der Anbieter rechnet
  jeden Aufruf ab, auf deine Rechnung; wie viel, hängt davon ab, wie viele Belege die App liest.
  Empfohlen bleibt ein Abo: Claude Pro oder ChatGPT Plus, etwa 20 USD im Monat, ohne Rechnung
  pro Aufruf.»
- «Der Schlüssel liegt im Schlüsselbund dieses Macs, nie in der Buchhaltung.», with a link to the
  provider's key page.
- «Ohne Claude Code oder Codex geht nicht: die KI-Spalte (sie braucht Claude Code) und «Im
  Terminal» (braucht eins der beiden Programme).»

TypeSafe Jev keeps its row in Firma › KI (it answers yes/no and choice questions only). The setup
conversation does not offer it.

## Detection

What the app checks, in order, for each CLI. None of it reads a credential.

1. **Found.** The program in `~/.local/bin`, then on the login shell's PATH
   (src/platform/login-path.ts, as today). The first executable wins. Its path is kept for
   running it, as `FoundCli.bin` is today.
2. **Version.** `claude --version` or `codex --version`, with a short timeout. A program that does
   not answer counts as not found, with the reason «antwortet nicht».
3. **Signed in.** `claude auth status` (JSON, exit 0 or 1) or `codex login status` (exit code).
   Today Claude's sign-in is known only from the newest claude-cli call in the books' ledger
   (`claudeSignedIn` in src/platform/terminal-open.ts), so before the first call it is unknown.
   The status command answers before any books exist.
4. **Works.** The test call of decision 2. Its refusal is shown as the CLI said it.

**When the app looks.** Every 2 seconds while a card waits (after «Im Terminal installieren» or
«Anmelden»), when the window gets focus, and when a page with a card opens. A wait stops after 15
minutes and shows «nicht gefunden» with where the app looked. Nothing polls in the background
otherwise.

**No restart.** Two caches block this today and must go in the build. The login shell's PATH is
asked once per process (`terminalPath` in src/platform/terminal-open.ts), and the desktop finds
`claude` once at start (`findClaude` in src/desktop/main.ts, `CLAUDE_BIN`). A new detection call
asks again.

**How Terminal opens.** As «Im Terminal» does today (#146): a `.command` file run by
`open -a Terminal`, which needs no permission to control Terminal. For an install, the script
prints the vendor's command and waits for Enter (`read`) before it runs it. Ctrl-C ends it. For a
login, the script runs `claude auth login` or `codex login`.

## Where the same help appears later

- **Firma › KI.** «KI-Programme auf diesem Mac» with the cards replaces the row «Claude-Abo
  (Claude Code) · bereit». The minimum plans stand in one sentence above. The API keys move into
  the folded «Erweitert: mit API-Schlüssel». With two CLIs ready, «Die App fragt» chooses one
  (this also decides what «Im Terminal» opens), and the option of decision 4 says whether to ask
  the other one when the first cannot answer.
- **The KI column without an AI.** The column says what it needs and shows the cards. The composer
  is off, with the reason as its placeholder.
- **A limit reached.** The answer states what the CLI said («Nutzungsgrenze deines Abos
  erreicht, wieder ab 18:00»). When the other CLI is signed in, «Mit Codex fragen» is offered.
- **The error line** where `error.noClaude` shows today: «Beleg lesen braucht eine KI. Auf diesem
  Mac ist weder Claude Code noch Codex angemeldet.», with «KI einrichten» (opens the cards) and
  «Von Hand erfassen». `error.noClaude` and `ai.cli.missing` go. The new keys live in the
  dictionaries in all four languages (docs/i18n.md).

## For the build (not in this PR)

Rough scope, to size the work. The mockups change no app code.

- `src/platform/ai-cli.ts`: the one table of CLI facts (program, installer, status command,
  plans page), detection (found, version, status, test call) without caches, and the install and
  login scripts beside `launchScript`.
- `GET /api/ai/clis` (also before books exist, under /api/desktop) returning the card states, and
  `POST /api/ai/clis/:cli/install` and `/login` opening Terminal.
- The provider order of #175: with no CLI ready, a saved key's provider is the default for every
  step except `sidebar`, and `/api/desktop/ai` uses the same rule as `modelReady`.
- One `CliCard` and one key block in src/app (tokens and classes as in
  mockups/ai-setup/ai-setup.css), used in the setup conversation, Firma › KI, the KI column and
  the error line.
- Tests: detection with a fake `claude` and `codex` on a temporary PATH (installed, signed out,
  signed in, not answering); a key-only Mac resolving every step but `sidebar` to the key; and
  that no code path opens a CLI's credential file.

## As built

- The CLI facts are `AI_CLIS` in src/platform/terminal.ts; detection, the Terminal scripts and the sign-in status are src/platform/ai-cli.ts; the card's state machine and the view are src/platform/ai-setup.ts; the routes are src/server/ai-setup.ts under `/api/ai/setup` (the desktop server answers them before any books exist, the books API under `npm start`); the UI is src/app/ai/.
- The card's states: `missing`, `installing`, `silent` (found, does not answer `--version`), `signedOut`, `signingIn`, `testing`, `ready`, `refused` (the test call was refused: plan, limit or another reason), `notFound` (15 minutes of waiting).
- A look tries the PATH (the process's, then the login shell's) before `~/.local/bin`, so a developer's or a test's own `claude` on the PATH wins over the one the native installer wrote.
- Whether Claude Code answers (`claudeCli.ready`, and with it `modelReady`) is now found, answering and signed in, not only found.
- #121 (Codex as a provider) was merged while this was built. Firma › KI shows both cards, «Die App fragt» and «das andere fragen» (#121's `cli` and `askOther`). The first run still offers Claude Code alone (`FIRST_RUN_CLIS`): `codex exec` asks for Apple's developer tools on a Mac without them, so the owner decides when Codex joins it. The KI column names Claude Code (it needs an agent); the error line says «eine KI».
- #175 in #121's structure: where no subscription answers (found and signed in), a key that writes text comes first and serves every step it can; a key that fails asks a subscription, never another key.
