# Desktop: installation and first start

The owner downloads the dmg, opens it and starts the app. The build is unsigned
(`identity: null` in `desktop/electron-builder.config.cjs`) until the Developer ID arrives, so
macOS Gatekeeper blocks the first start. Started outside /Applications, the app first offers to move
itself there. The first start shows the start screen (`Wähle die Buchhaltung, mit der du arbeiten
willst.`, `Bestehende Buchhaltung öffnen`, `Neue Buchhaltung anlegen`, `Demo ansehen`, each with a
hint line, `Zuletzt geöffnet`, language DE FR IT EN). The language follows the system's until one is
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

Proof: the dialog texts on the shots, and the start screen's text from `app.mjs`.

## Gotchas

- The coordinates hold for the 1024×768 `vanilla-clean` display; read them off the newest `.s.png`.
- "Your screen is being controlled" covers the top right for a few seconds after each VNC
  connection and can swallow a click there (the language switch). Click again after it fades.
- The dmg name carries the build (`Vanilla Accounting-0.4.0-rc.N-g<sha>[.dirty]-arm64.dmg`); `vm.sh up`
  takes the newest in `release/`.
