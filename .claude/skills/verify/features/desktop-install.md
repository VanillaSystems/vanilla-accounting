# Desktop: installation and first start

The owner downloads the dmg, opens it and starts the app. The build is unsigned
(`identity: null` in `desktop/electron-builder.config.cjs`) until the Developer ID arrives, so
macOS Gatekeeper blocks the first start. Started outside /Applications, the app first offers to move
itself there. The first start, with no books known, opens «Einrichtung» (FirstRun, src/app/ai/FirstRun.tsx,
books first since #343: `Hallo! Vanilla Accounting ist die Buchhaltung deiner Firma: …`, `Was möchtest du?`,
the choices `[data-answer=create|open|switch|demo]` at once, `Zur Startseite` `[data-act=first-leave]`).
The look at this Mac's AI runs in the background (one test call when a CLI is signed in); once it has its
answer, the line under the choices is `[data-ready=claude]` (`Claude Code ist bereit: …`) with
`Ohne KI einrichten` `[data-act=by-hand]`, or `[data-ai=none]` (`Belege lesen und Buchungen vorschlagen
macht eine KI …`) with `KI einrichten` `[data-act=ai-setup]`. No AI card and no command on this screen.
`KI einrichten` opens the AI step: the cards `.aicli[data-cli][data-state]` say what a program needs
(account, plan, about 20 USD, Terminal, sign-in in English, it can wait), the command is folded under
`Befehl zeigen` (`details.aishow`), the answers are `[data-answer=install-claude|install-codex|no-ai]`;
`Ohne KI weiter` leads back to the choices. Never click install or `Anmelden` outside a VM: they open
the real Terminal. The start
screen (`Wähle die Buchhaltung, mit der du arbeiten willst.`, `Bestehende Buchhaltung öffnen`,
`Neue Buchhaltung anlegen`, `Demo ansehen`, each with a hint line, `Zuletzt geöffnet`, language DE FR IT
EN) shows from `Zur Startseite`, at `/start`, or on a later start without books; a later start with
books reopens the last ones directly (src/desktop/main.ts). The language follows the system's until one is
picked (English on `vanilla-clean`).

## Sub-features

- `di-dmg`: the dmg window (app icon, arrow, Applications link).
- `di-gatekeeper`: "can't be opened" (OK / Show in Finder), then System Settings › Privacy &
  Security › `Open Anyway` › `Open` › admin password. A move by hand afterwards asks again; the
  app's own move does not.
- `di-move`: before any window, outside /Applications: `Move Vanilla Accounting to the Applications
  folder?` (system language; de `… in den Ordner «Programme» verschieben?`) with `Not now` / `Move`.
  `Move` copies it to /Applications and relaunches; from ~/Desktop macOS first asks for Desktop access
  (`Allow`) before the original goes.
- `di-start`: the start screen and its language switch (top right); the menu Ablage › `Buchhaltung
  öffnen…`, `Neue Buchhaltung…`, `Demo`, `Zuletzt geöffnet`. `Demo ansehen` opens a copy of the
  bundled demo in the app's user data (`<userData>/Demo`, src/desktop/server.ts).
- `di-demo`: the demo says that it is one (#343). From the start screen or `[data-answer=demo]` it opens
  on `/automation`. `[data-testid=demo-bar]` along the bottom stays while it is open (`Demo: Muster Kaffee
  GmbH ist eine erfundene Firma. Nichts hier ist echt, du arbeitest in einer Kopie.`, `Zu deiner
  Buchhaltung`, or `Zur Startseite` when the Mac knows no other books, `[data-act=demo-leave]` → `/start`). On its first opening `[data-testid=demo-intro]`
  (`Das ist die Demo`, three links) lies over the lower left corner until `Verstanden`
  `[data-act=demo-intro-close]` (kept in localStorage `demoIntroSeen`): close it before clicking rows there.

## How to get to it (user POV)

Double-click the dmg in Downloads, then the app icon in the dmg window (the common mistake) or drag
it to Applications first (the intended way).

## Driving it with vm.sh + app.mjs

```bash
$V sh 'open ~/Downloads/*.dmg'; $V shot 01-dmg
$V dclick 724 385; $V shot 02-gatekeeper          # app icon in the dmg window (1400-px coordinates)
$V click 700 573                                   # OK
$V sh 'open "x-apple.systempreferences:com.apple.preference.security?Security"'; $V shot 03-privacy
# Open Anyway, Open, then click the password field, $V type admin, $V key enter; shot after each
$V app; node $A 04-start "await clickText('DE')"
```

The move offer, driven 2026-10-21 without the Settings detour: after the Gatekeeper shot,
`$V sh 'ditto "/Volumes/<dmg>/Vanilla Accounting.app" ~/Desktop/"Vanilla Accounting.app" && xattr -dr
com.apple.quarantine ~/Desktop/"Vanilla Accounting.app" && open ~/Desktop/"Vanilla Accounting.app"'`,
`$V shot 03-move-offer`, `$V click 780 521` (Move), `$V click 780 405` (Allow Desktop access): `ls -d
/Applications/"Vanilla Accounting.app"` exists, the Desktop copy is gone, the start screen shows.

Driven again 2026-11-12 for #363, from a fresh clone each time (a VM that already answered the
Desktop or Documents question does not ask again, so a repeat needs `down` + `up`): the dmg mounted
with `hdiutil attach -nobrowse ~/Downloads/*arm64.dmg`, the app `ditto`'d to ~/Desktop,
unquarantined and `open`ed as above; on the 1400-px shot `Move` is at 731 287, then macOS asks for
the Desktop folder (`Allow` 731 241, asked by the Desktop copy while it moves itself), then the
relaunched copy in /Applications opens its window and macOS asks for the Documents folder over it
(`Allow` 731 241, `Don't Allow` 667 241). Expected: the window behind the Documents question,
the first screen («Hello! Vanilla Accounting is …», `Create new books` …) within a few seconds
of the answer, by itself. Before the fix of #363 it showed no window for over a minute, a Dock click a
blank one (#363). The relaunched copy runs without a DevTools port and its stdout goes nowhere:
read its state from the shots, and from `curl -s http://127.0.0.1:49152/api/desktop` in the VM
(`$V sh`); `$V app` restarts it (with the port), which is a second start, not the first. To see
inside the first start, a temporary build that appends `--remote-debugging-port` and writes a line
per step to /tmp (see the commit history of #363) is the way; never ship it.
A drag over VNC: `vncdo … move X Y mousedown 1 drag X2 Y2 mouseup 1` in screen pixels (the
`.png`, not the `.s.png`); it moves pixel by pixel and takes about a minute for 700 px.

Proof: the dialog texts on the shots, and the start screen's text from `app.mjs`.

## Gotchas

- The coordinates hold for the 1024×768 `vanilla-clean` display; read them off the newest `.s.png`.
- "Your screen is being controlled" covers the top right for a few seconds after each VNC
  connection and can swallow a click there (the language switch). Click again after it fades.
- The dmg name carries the build (`Vanilla Accounting-0.4.0-rc.N-g<sha>[.dirty]-arm64.dmg`); `vm.sh up`
  takes the newest in `release/`.
