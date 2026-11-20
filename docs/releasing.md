# Releasing

How a version of Vanilla Accounting is numbered, what a release must prove, how to cut one and
how to build and publish the Mac app. For the people who maintain the app. If you only use it,
`npm run update` (or the new `.dmg` of the Mac app) is all you need, and
[`CHANGELOG.md`](../CHANGELOG.md) tells you what changed.

## Branches

- `next`: where the work comes together. Every pull request goes here.
- `release/X.Y.Z`: cut from `next` for a release, merged into `main` when it is published.
- `main`: released versions only. `npm run update` of an adopter's copy follows it.

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

The full suite runs once per release and the Mac app is built and smoke-tested once, both on the
head of the release branch. Two rules make the rest reuse them:

- **Same tree hash, same result.** A green full `npm test` on a clean tree records the tree's hash
  (tools/test/runs.mjs, in the clone's git folder). `npm test` on a recorded tree says so and runs
  nothing; `npm test -- --force` runs it anyway. Main's merge commit of the release branch has the
  release head's tree when main holds nothing the branch lacks, so its gates pass from the record.
  When main has a commit of its own, the tree differs and the suite runs, as it must.
- **A cut release names its build.** From the commit `Release X.Y.Z` on (CHANGELOG.md dates X.Y.Z)
  until the tag vX.Y.Z exists, a clean build is named `X.Y.Z` (src/version.ts `isCut`), so the dmg
  built on the release branch already carries the final name. Other builds keep their rc names
  ([versioning.md](versioning.md)).

1. Cut `release/X.Y.Z` from `next` with a clean tree.
2. Move the entries under a new heading in `CHANGELOG.md`: `## [X.Y.Z] - YYYY-MM-DD`, with
   **⚠ figures** and **⚠ action** where they apply. Optionally, write a `### Highlights`
   subsection first under the heading: three to six short bullets for a person who downloads the
   app, such as `- **Simpler setup:** only the questions the books need.` The GitHub release shows
   them under «What's new in X.Y.Z» and leaves the subsection out of the full changelog. Without
   it, the release lists the titles of the «Added» and «Changed» entries (each entry's first
   sentence up to its colon), at most six.
3. Check the version. `package.json` already holds X.Y.Z while the work on it runs
   ([versioning.md](versioning.md)); only if it does not, set it. This edits `package.json` and
   `package-lock.json` and does not commit:

   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```

4. Commit both changes as `Release X.Y.Z`. A fix found later goes onto the release branch too;
   everything below runs on the branch's head after the last one.
5. Run the gates once on that head. Each must pass:

   ```sh
   npm test                 # types, demo golden master, every test; records the tree
   npm run test:books       # your own books: no filed figure moved
   npm run check-processes  # 0 errors
   npm run check-public     # 0 findings
   npm run build
   ```

6. Build the Mac app once (`npm run desktop:build`, [Building the Mac app](#building-the-mac-app)):
   `release/Vanilla Accounting-X.Y.Z-arm64.dmg` and `-x64.dmg`. Smoke-test each once.
7. The walks by hand, scoped to the release's threat zone as `npm run test:changed` scopes the
   unit tests. On the release branch's head:

   ```sh
   npx tsx tools/release/zones.ts           # against the newest release tag; or name it: … v0.6.0
   ```

   It prints the zones the diff touches, each with its files, then «VM: these scenarios» and
   «Personas: these walks» (and the feature recipes of the web sandbox), each with the zones that
   chose it, or «none». The release runs exactly those: each VM scenario on a fresh Mac
   (`.claude/skills/verify/vm.sh scenario <id>` prints its steps; `install` and `update` are
   `npm run desktop:e2e -- --fresh` and `npm run desktop:e2e`), each persona walk as its file says
   (.claude/skills/verify/personas/README.md). Docs, specs, tests, tooling and a version bump
   select nothing; app code no zone names falls back to `install`; a file the map does not place
   selects everything until it gets a zone. The full set runs only on request: `… --all`. The map
   is tools/release/zones.json (tests/release-zones.test.ts holds it to the repository); a new
   area, scenario or persona gets its place there.

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
| `VANILLA_SHARE_SERVICE` | The share service the app offers for «Teilen» by link (`https://share.<domain>`, src/share/service.ts), written into the packed app's package.json as `share.service`. Without it the person names a service herself, or shares the books as a file. |

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
2. Run `npm test` on `main`: with the release head's tree it says «same tree, same result» and
   runs nothing; with another tree it runs the suite, and the other gates of
   [Cutting a release](#cutting-a-release) run again too.
3. Tag `main`'s commit and push it with the tag:

   ```sh
   git tag -a vX.Y.Z -m "Vanilla Accounting X.Y.Z"
   git push --follow-tags
   ```

4. Get an Apple Developer ID (Apple Developer Program), create a Developer ID Application
   certificate, export it as `.p12`, and set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Set `VANILLA_RELEASES=owner/repo`. Set
   them before step 6 of [Cutting a release](#cutting-a-release), so the one build there is signed;
   there is no second build after tagging.
5. Make the repository public. Add `homepage` to `package.json` for Help › Dokumentation.
6. Publish the GitHub release with the downloads: check out the tagged commit and run

   ```sh
   npm run release:github              # shows the release it would create, changes nothing
   npm run release:github -- --publish # creates it on GitHub
   ```

   It takes the version from `package.json` and attaches `release/Vanilla Accounting-X.Y.Z-arm64.dmg`
   and `-x64.dmg` (plus the `.zip` files and `latest-mac.yml` when a feed was built). The text is,
   in this order: one bold line saying what the app is; «Download», a table with each `.dmg` as a
   link to its asset, its Mac and its SHA-256, and for an unsigned build how to open it the first
   time; «What's new in X.Y.Z», the highlights (step 3 of [Cutting a release](#cutting-a-release));
   and that version's section of `CHANGELOG.md` folded under «Full changelog». When the text
   would pass GitHub's limit of 125,000 characters, it links to `CHANGELOG.md` at the tag instead. It refuses to publish when
   the tree is not clean, the tag is missing, not pushed, not the checked-out commit or not on
   `origin/main`, a `.dmg` is missing, the `.dmg` files were built from another tree than the checked-out commit's
   (`tree` in `out/desktop/build.json`), or the release exists already. It needs the `gh` CLI,
   logged in with write access to the repository (`VANILLA_RELEASES=owner/repo` overrides the
   repository taken from `origin`). While the repository is private, only its members see the
   release.
7. Turn on updates: set `"desktop": { "autoUpdate": true }` in `package.json` and release that in
   the next version; apps from then on update themselves from the GitHub releases.

## Before the public release

Open items that must be done before `1.0.0` ships. Remove an item when it is done.

- [ ] **The iPhone app's download link and name.** Publish the receipt app (`ios/`, shown as
  «Vanilla Scanner» until its name is chosen: `PHONE_APP_NAME` in src/platform/phone-app.ts) in
  the App Store, or on TestFlight for a start, and set `PHONE_APP_STORE_URL` there: «Belege vom
  Handy» then shows a QR code plus the written link as its first step, with «Ich habe die App
  schon» to skip to the pairing code. Until then it shows only the pairing code. The mockup
  (`docs/0.4.0/mockups/receipt-inflow/prototype.html`) shows an example link that does not work.
