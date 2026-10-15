# Desktop: installation and first start

The owner downloads the dmg, opens it and starts the app. The build is unsigned
(`identity: null` in `desktop/electron-builder.config.cjs`) until the Developer ID arrives, so
macOS Gatekeeper blocks the first start. The first start shows the start screen
(`Bestehende Buchhaltung öffnen`, `Neue Buchhaltung anlegen`, `Demo ansehen`, language DE FR IT EN).

## Sub-features

- `di-dmg`: the dmg window (app icon, arrow, Applications link).
- `di-gatekeeper`: "can't be opened" (OK / Show in Finder), then System Settings › Privacy &
  Security › `Open Anyway` › `Open` › admin password. Moving the app to Applications afterwards
  asks again.
- `di-start`: the start screen and its language switch (top right).

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

Proof: the dialog texts on the shots, and the start screen's text from `app.mjs`.

## Gotchas

- The coordinates hold for the 1024×768 `vanilla-clean` display; read them off the newest `.s.png`.
- "Your screen is being controlled" covers the top right for a few seconds after each VNC
  connection and can swallow a click there (the language switch). Click again after it fades.
- Run from the mounted dmg, the app vanishes when the dmg is ejected. Nothing in the app warns.
