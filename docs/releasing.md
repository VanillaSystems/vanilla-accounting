# Releasing

How a version of Vanilla Accounting is numbered, what a release must prove, and how to cut one.
For the people who maintain the app. If you only use it, `npm run update` is all you need, and
[`CHANGELOG.md`](../CHANGELOG.md) tells you what changed.

## Version numbers

The app follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. The person a
version number speaks to is the adopter: someone who keeps their own books with the app and
updates it with `npm run update`. The question for each change is what that person must do.

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

`books.json` and `belege.workspace.yaml` carry `schema`. `src/workspace/schema.ts` lists both
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
4. Bump the version. This edits `package.json` and `package-lock.json` and does not commit:

   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```

5. Commit both changes as `Release X.Y.Z`, then tag that commit:

   ```sh
   git tag -a vX.Y.Z -m "Vanilla Accounting X.Y.Z"
   ```

6. Push the commit and the tag (`git push --follow-tags`). A release on GitHub, if you write
   one, repeats the changelog section.

`npm run update` follows the branch an adopter's copy tracks, so a pushed commit on `main` is
what they get. Tags mark the versions that the changelog describes.
