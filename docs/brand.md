# The brand in the app

Vanilla Accounting is a product of Vanilla Machines. The brand is defined in the Vanilla Machines
brand repository (`brand.json` and the pages under `guidelines/`), which is the source of truth. This
page says how the app follows it and how to bring its files up to date.

## Colour

The product colour is Tram blue `#005B8C` (on dark `#4AA3DF`). In the UI it is `--accent`, with
`--accent-soft` its 10 % tint `#E6EFF4`, the values of `brand.json` → `ui.light`
(`src/app/styles/tokens.css`). Dark mode is grayscale: its accent is `#ededed`. Red never marks
anything in the UI but an error.

## Files from the brand repository

The brand renders its own icons (`npm run icons` in the brand repo). The app copies them byte for
byte, with the SVGs it shows:

```sh
node tools/brand/make.mjs ../path/to/the-brand-repo
```

| File in the app | From the brand repo | Use |
|---|---|---|
| `desktop/icon.icns` | `assets/app-icons/macos/AppIcon.icns` | Mac app icon (Finder, Dock) |
| `desktop/icon.ico` | `assets/app-icons/windows/app.ico` | Windows app icon |
| `desktop/icon.png` | `assets/app-icons/macos/AppIcon-1024.png` | Dock when the app runs unpacked |
| `public/favicon.svg`, `public/favicon.ico`, `public/apple-touch-icon.png` | `assets/app-icons/web/` | Browser tab, home-screen bookmark, audit export |
| `ios/…/AppIcon.appiconset` | `assets/app-icons/ios/AppIcon-1024.png`, `-dark-`, `-tinted-` | iPhone app icon (light, dark, tinted) |
| `src/app/brand/assets/` | the blue lockup, the on-dark lockup, the macOS icon, the muted seals, the wave (as a mask) | Start screen, About, loading, empty states |
| `docs/logo.svg`, `docs/swiss-engineering.svg` | the blue lockup, the seal | README header |
| `docs/social-preview.png` | `assets/app-icons/social-preview-1280x640.png` | GitHub social preview |
| `docs/deploy-button.svg` | the white wave, with Instrument Sans 600 from `@fontsource` embedded | README's "Deploy to Vanilla Machines" |

Run it again when the brand changes, look at the result, and commit the files. The web app has no
manifest, so the brand's `icon-192`/`icon-512` files are not used.

## README and GitHub

The README opens as the brand's Applications page says: the lockup, one sentence, "by Vanilla
Machines", the seal, and the "Deploy to Vanilla Machines" button (a black pill drawn as an SVG,
since GitHub Markdown takes no styles), linking to `vanillamachines.com/deploy/accounting`, the
waitlist until the platform launches.

The social preview is the owner's step, once per repository: GitHub › the repository › Settings ›
General › Social preview › Edit › Upload an image, and pick `docs/social-preview.png` (1280 × 640).

`package.json` has no `homepage`: the brand names no product page for Vanilla Accounting yet, only
the deploy link. Help › Dokumentation in the Mac app appears once one is set.

## Where the brand shows in the app

The brand's page "Vanilla Accounting in the app" decides, and `src/app/brand/` implements it:

| Where | What | In the code |
|---|---|---|
| Start screen | The blue lockup (on dark the on-dark file), "by Vanilla Machines", the muted seal at the bottom edge | `StartScreen.tsx`, `Lockup`, `Endorsement`, `Seal` |
| Loading | The app icon, gently pulsing; still under reduced motion | `Splash` |
| Workspace | Nothing: no logo in the top bar, the dock or the lists | `tests/brand.test.ts` |
| Empty list | The wave alone in faint ink, as a watermark | `.empty::before` in `shell.css` |
| About | Icon, name, version, subtitle, endorsement, licence, seal | `About`, Firma › Über Vanilla Accounting (`/company/about`); the Mac app menu opens it |
| Customer documents | Nothing; the PDF's Producer is "Vanilla Accounting <version>" | `finishPdf`, `setProducer` in `src/invoices/pdf.ts` |

Names are proper names and never translated (`src/app/brand/names.ts`): "Vanilla Accounting" in full,
"Accounting" where a launcher shortens (iPhone home screen, macOS menu bar), and window titles
`Page · Vanilla Accounting`.
