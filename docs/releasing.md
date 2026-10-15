# Releasing

How a version of Vanilla Accounting is numbered, what a release must prove, how to cut one and
how to build and publish the Mac app. For the people who maintain the app. If you only use it,
`npm run update` (or the new `.dmg` of the Mac app) is all you need, and
[`CHANGELOG.md`](../CHANGELOG.md) tells you what changed.

## Version numbers

The app follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. The person a
version number speaks to is the adopter: someone who keeps their own books with the app and
updates it with `npm run update` or a new `.dmg`. The Mac app carries the same version, from
`package.json`. The question for each change is what that person must do.

| Part | When | Examples |
|---|---|---|
| MAJOR | The adopter must act by hand before or after the update. | A migration that `npm run update` cannot do by itself. A command, an npm script, a setting in `belege.workspace.yaml` or `.env`, or a folder of the workspace renamed or removed. |
| MINOR | New behavior that needs nothing from the adopter. | A feature, a command, a booking rule, a casebook case, a supported bank. A schema step that `npm run update` applies by itself. |
| PATCH | A fix that changes no intended behavior. | A bug fix, the docs, a fact about a supplier or an authority. |

Rules on top of the table:

- The app is at `0.x` until its public release, which is `1.0.0`. While at `0.x`, a change of
  the MAJOR kind bumps MINOR, and its changelog entry carries **⚠ action**.
- A change that alters a computed figure of an open period (a VAT Ziffer, a balance, a return)
  is at least MINOR, and its changelog entry carries **⚠ figures** and says why. A change that
  alters a figure of a filed quarter is a bug: it does not ship.
- A bump of `BOOKS_SCHEMA` or `WORKSPACE_SCHEMA` (`src/workspace/schema.ts`) is MINOR when its
  migration step runs by itself, MAJOR when the adopter must do something.

## Changing the data format

The books (`ledger.json`) and `belege.workspace.yaml` carry `schema`. `src/workspace/schema.ts` lists both
versions and their migration ladders. To change a format:

1. Raise the version by one and add the step from the old version to the new one to its ladder.
   A step is a pure function of the old file. It runs on every load of an older file, so it
   must not depend on anything outside the file.
2. A books step never changes a record dated on or before `config.closedThrough`. The seals of
   the filed quarters (`src/books/seal.ts`) are checked after the step and refuse books it
   changed. A format change that must touch filed records is MAJOR and needs its own plan.
3. Add a test: a file of the old version in, the expected file out, and a second run that
   changes nothing (`tests/schema.test.ts` shows the shape).
4. Write the changelog entry. `npm run update` writes the new format to the adopter's
   workspace, with a backup in `data/backups/`. That holds while one person writes the
   workspace. Once a contributor or a cloud instance writes it too, the app does not migrate on
   update: the migration is the owner's event on `main`, and every app checks the formats it
   can read and write on each write ([ADR 0004](adr/0004-versions-and-record-envelope.md)).

## Cutting a release

1. Work on `main` with a clean tree.
2. Run the gates. Each must pass:

   ```sh
   npm test                 # types, demo golden master, every test
   npm run test:books       # your own books: no filed figure moved
   npm run check-processes  # 0 errors
   npm run check-public     # 0 findings
   npm run build
   ```

3. Move the entries under a new heading in `CHANGELOG.md`: `## [X.Y.Z] - YYYY-MM-DD`, with
   **⚠ figures** and **⚠ action** where they apply.
4. Check the version. `package.json` already holds X.Y.Z while the work on it runs
   ([versioning.md](versioning.md)); only if it does not, set it. This edits `package.json` and
   `package-lock.json` and does not commit:

   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```

5. Commit both changes as `Release X.Y.Z`, then tag that commit:

   ```sh
   git tag -a vX.Y.Z -m "Vanilla Accounting X.Y.Z"
   ```

6. Push the commit and the tag (`git push --follow-tags`).
7. Build the Mac app at this version (`npm run desktop:build`, [Building the Mac app](#building-the-mac-app))
   and publish the GitHub release with its downloads: `npm run release:github -- --publish`
   (step 6 of [What the owner does to publish](#what-the-owner-does-to-publish)).

`npm run update` follows the branch an adopter's copy tracks, so a pushed commit on `main` is
what they get. Tags mark the versions that the changelog describes.

## Building the Mac app

```sh
npm run desktop:build    # release/Vanilla Accounting-X.Y.Z-arm64.dmg and -x64.dmg
```

It runs `npm run build`, bundles `src/desktop` (`tools/desktop/build.mjs`, which fails when the
bundle imports a package that is not packed) and packs one `.dmg` each for Apple silicon and
Intel with electron-builder (`desktop/electron-builder.config.cjs`). The version is the one in
`package.json`. [docs/desktop.md](desktop.md) explains the parts.

Prove each `.dmg` before it is published. Mount it, then run the smoke test with a PATH that
holds no Homebrew, so the app finds nothing a person's Mac may lack:

```sh
hdiutil attach "release/Vanilla Accounting-X.Y.Z-arm64.dmg"
PATH=/usr/bin:/bin "$(command -v node)" tools/desktop/smoke.mjs \
  "/Volumes/Vanilla Accounting X.Y.Z-arm64/Vanilla Accounting.app" .verify/evidence/release/X.Y.Z-arm64
hdiutil detach "/Volumes/Vanilla Accounting X.Y.Z-arm64"
```

The smoke test opens a copy of the demo in a fresh user data folder and drives every area, an
invoice with its PDF and e-mail, a dropped PDF, PNG and HEIC, a statement, new books and a
restart; every check must pass. Run the `x64` one too (under Rosetta on Apple silicon).

### Signing, notarization and updates

`npm run desktop:build` reads these variables. Without them the app is built unsigned and has no
update feed.

| Variable | Effect |
|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD` | The Developer ID Application certificate (a `.p12` file or its base64) and its password: the app is signed. Without `CSC_LINK` it is not signed, even when the keychain holds an identity. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | With a certificate: the app is notarized by Apple, so it opens with a double-click on any Mac. |
| `VANILLA_RELEASES` | `owner/repo` of the GitHub repository whose releases are the update feed. The build then also writes the `.zip` files and `latest-mac.yml` that the updater reads. |

The app looks for updates only when `package.json` has `"desktop": { "autoUpdate": true }`, and
only as a packaged app (`VANILLA_AUTO_UPDATE=1` turns it on for a test). macOS installs an update
only into a signed app. Help › Dokumentation appears once `package.json` has a `homepage`.

### Fuses

The release build is fused (`electronFuses` in the builder config): the app's binary cannot run
as Node (`ELECTRON_RUN_AS_NODE`), ignores `NODE_OPTIONS` and `--inspect`, loads its code only
from `app.asar` and checks that archive's hash at start, and encrypts its cookies. The smoke test
therefore drives the page through Chromium's `--remote-debugging-port` and the menu through
`--vanilla-smoke`; both are switches that a start from the Finder never has. One build is tested
and released; there is no test build.

### The keychain prompt of unsigned builds

The SMTP password and the cookies are sealed with the key of the keychain item
"vanilla-accounting Safe Storage". macOS grants that item to the app that made it. An unsigned
build is signed ad hoc, and every rebuild has another ad hoc signature, so macOS asks once
whether the new build may read the item, before the first window opens. Answer **Always
Allow**, or delete the item in Keychain Access when it holds only test data. Signed releases
share the Developer ID and are not asked. The smoke test names this prompt when the app opens no
window.

## What the owner does to publish

The release run prepares everything up to these steps; each one is the owner's.

1. Merge the release branch into `main` and check out `main` with a clean tree.
2. Run the gates of [Cutting a release](#cutting-a-release) once more on `main`.
3. Tag the release commit and push it with the tag:

   ```sh
   git tag -a vX.Y.Z -m "Vanilla Accounting X.Y.Z"
   git push --follow-tags
   ```

4. Get an Apple Developer ID (Apple Developer Program), create a Developer ID Application
   certificate, export it as `.p12`, and set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Set `VANILLA_RELEASES=owner/repo`. Build
   with `npm run desktop:build` and prove both `.dmg` files with the smoke test.
5. Make the repository public. Add `homepage` to `package.json` for Help › Dokumentation.
6. Publish the GitHub release with the downloads: check out the tagged commit and run

   ```sh
   npm run release:github              # shows the release it would create, changes nothing
   npm run release:github -- --publish # creates it on GitHub
   ```

   It takes the version from `package.json`, the text from that version's section of
   `CHANGELOG.md`, and attaches `release/Vanilla Accounting-X.Y.Z-arm64.dmg` and `-x64.dmg` (plus
   the `.zip` files and `latest-mac.yml` when a feed was built), with each file's SHA-256 in the
   text and, for an unsigned build, how to open it the first time. It refuses to publish when
   the tree is not clean, the tag is missing, not pushed, not the checked-out commit or not on
   `origin/main`, a `.dmg` is missing, or the release exists already. It needs the `gh` CLI,
   logged in with write access to the repository (`VANILLA_RELEASES=owner/repo` overrides the
   repository taken from `origin`). While the repository is private, only its members see the
   release.
7. Turn on updates: set `"desktop": { "autoUpdate": true }` in `package.json` and release that in
   the next version; apps from then on update themselves from the GitHub releases.
