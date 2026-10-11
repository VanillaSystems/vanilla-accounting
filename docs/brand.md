# The brand in the app

Vanilla Accounting is a product of Vanilla Machines. The brand is defined in the Vanilla Machines
brand repository (`brand.json` and the pages under `guidelines/`), which is the source of truth. This
page says how the app follows it and how to bring its files up to date.

## Colour

The product colour is Tram blue `#005B8C` (on dark `#4AA3DF`). In the UI it is `--accent`, with
`--accent-soft` its 10 % tint (`src/app/styles/tokens.css`). Dark mode is grayscale: its accent is
`#ededed`. Red never marks anything in the UI but an error.

## Files rendered from the brand repository

```sh
node tools/brand/make.mjs ../path/to/the-brand-repo
```

It needs the installed Google Chrome (or `CHROME_PATH`), `iconutil` (macOS) and ImageMagick
(`magick`). It copies or renders, from the brand's own SVGs:

| File | From the brand repo | Use |
|---|---|---|
| `desktop/icon.icns` | `vanilla-accounting-icon-macos.svg`, at 16 and 32 px `vanilla-accounting-favicon.svg` | Mac app icon (Finder, Dock) |
| `desktop/icon.ico` | `vanilla-accounting-favicon.svg`, 16 to 256 px | Windows app icon |
| `desktop/icon.png` | `vanilla-accounting-icon-macos.svg`, 512 px | About panel, Dock when unpacked |
| `public/favicon.svg`, `public/favicon.ico` | `vanilla-accounting-favicon.svg` | Browser tab |
| `public/apple-touch-icon.png` | `vanilla-accounting-icon.svg`, 180 px | Home-screen bookmark |
| `ios/…/AppIcon.appiconset` | `vanilla-accounting-icon.svg`, `-icon-dark.svg`, `-icon-tinted.svg`, 1024 px, no alpha | iPhone app icon (light, dark, tinted) |
| `src/app/brand/assets/` | the blue lockup, the on-dark lockup, the macOS icon, the muted seals, the black and white wave | Start screen, About, loading, empty states |
| `docs/logo.svg`, `docs/swiss-engineering.svg` | the blue lockup, the seal | README header |
| `docs/social-preview.png` | the blue lockup on white, 1280 × 640 | GitHub social preview |

Run it again when the brand changes, look at the result, and commit the files.
