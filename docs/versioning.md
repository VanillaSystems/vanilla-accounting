# Versions, release candidates and tags (for agents)

How the app's version is derived and which tags to set. The release procedure itself is in
[releasing.md](releasing.md); the code is `src/version.ts`, its cases `tests/version.test.ts`.

## The rules

- **`package.json` holds the version being worked toward**, not the last release. Raise it at the
  start of the work on the next version (after `v0.3.0` is tagged, the next commit that starts
  0.4.0 work sets `0.4.0`), with `npm version X.Y.Z --no-git-tag-version`. Never lower it.
- **Tags are `vX.Y.Z` (a release) or `vX.Y.Z-rc.N` (a release candidate handed out for trying)**,
  annotated (`git tag -a`), on a commit of the line, pushed with `git push --follow-tags`. Never
  move or delete a pushed tag.
- **Nobody types a build number.** `git describe --tags --long --dirty --always` and `package.json`
  give it; the count is the commits since the last tag.

## What a build calls itself

| `package.json` | Last tag, commits since | Build | Meaning |
|---|---|---|---|
| 0.4.0 | `v0.3.0`, 56 | `0.4.0-rc.56+g36b66d6` | 56 commits on the way to 0.4.0 |
| 0.4.0 | `v0.3.0`, 56, uncommitted changes | `0.4.0-rc.56+g36b66d6.dirty` | never hand out a dirty build |
| 0.4.0 | `v0.4.0-rc.1`, 0 | `0.4.0-rc.1+g1a2b3c4` | the tagged release candidate |
| 0.4.0 | `v0.4.0-rc.1`, 3 | `0.4.0-rc.1.3+g1a2b3c4` | 3 commits after it |
| 0.4.0 | `v0.4.0`, 0 | `0.4.0` | the release |
| 0.3.0 | `v0.3.0`, 56 | `0.3.0+56.g36b66d6` | `package.json` was not raised after the release: raise it |
| any | no tag (shallow clone) | `0.4.0+g36b66d6` | |

`-rc.N` is a SemVer pre-release, everything after `+` is build metadata. File names use `-` for `+`
(the dmg is `Vanilla Accounting-0.4.0-rc.56-g36b66d6-arm64.dmg`). macOS's bundle version is the
total commit count (`git rev-list --count HEAD`), so it always climbs.

## Where it shows

Under Firma's sections in the app, the first line of `npm run doctor`, the dmg name, and a
`Vanilla-Build:` trailer on every commit the app makes in a workspace's books (find which build
wrote an entry with `git log --grep 'Vanilla-Build: 0.4.0-rc.56'`). The packed Mac app has no git:
`tools/desktop/build.mjs` bakes the string in at build time from a clean tree.

## What an agent does

- Handing a build to the owner to try: commit first (no `.dirty`), build, and name the build string
  in the reply. Tag `vX.Y.Z-rc.N` only when the owner wants that build marked; N counts the
  candidates of X.Y.Z (rc.1, rc.2, …), not the commits.
- Releasing: [releasing.md](releasing.md). The tag `vX.Y.Z` goes on the commit `Release X.Y.Z`;
  that build is then plain `X.Y.Z`, and the next commit raises `package.json` to the next version.
- A build string the owner reports names the commit (`g36b66d6`): check that commit out to
  reproduce, not the branch head.
