---
name: release
description: 'Use when publishing a RaptHooker release or a beta (pre-release, like 0.9.0-beta.1 or 0.9.0-tilt.1): bumping the version, the CHANGELOG section, tagging and pushing, the release workflow, and the checks that must pass first so people can switch to it from any release and back without losing data.'
---

# Publishing a release or a beta

A release, or a beta, ends up on people's hubs. They can switch to it from any earlier release and back again, so
before anything is published it has to pass the compatibility checks. The background:
[docs/development.md](../../../docs/development.md#releasing) and
[docs/data-compatibility.md](../../../docs/data-compatibility.md).

## Pick the version

- A release: `x.y.z`, newer than every release so far.
- A beta of the next release: `x.y.z-beta.N`, where `x.y.z` is the release it leads up to.
- A beta that tries one thing out: `x.y.z-<name>.N` (`0.9.0-tilt.1`). Hubs on it hear about later betas of the same
  name (`0.9.0-tilt.2`).

## Before tagging

1. **A beta's migrations are released the moment it's published.** If it adds to `MIGRATIONS`, those migrations must
   already be on `main` exactly as they'll stay, and every later version (betas included) has to have them in the same
   place. Two betas must never each add a different migration with the same number: cut schema-changing betas from
   `main`. Betas that don't change the schema can come from any branch.

2. Set the version, and the changelog to go with it:

   ```bash
   npm version <version> --workspaces --include-workspace-root --no-git-tag-version
   ```

   - A release needs a `## [x.y.z] - YYYY-MM-DD` section: move what's under `[Unreleased]` into it.
   - A beta can have its own `## [x.y.z-beta.N] - YYYY-MM-DD` section saying what to try. Without one, its notes are
     the `[Unreleased]` section. Owners read these in Settings → Updates → Beta versions.

3. Fetch the tags (`git fetch --tags`), then run every check **after** the version change (a test checks the changelog
   has what this version needs):

   ```bash
   npm run format:check && npm run lint && npm run i18n:check && npm run typecheck && npm test
   npm run build && npm run test:e2e && npm run test:compat
   ```

   `npm test` includes `compatibility.test.ts` (no released migration changed); `test:compat` runs every published
   release on this build's data and back. Both must pass. Don't skip or loosen them to get a release out.

## Publish

```bash
git commit -am "Release <version>"
git tag v<version>
git push origin HEAD v<version>
```

The [release workflow](../../../.github/workflows/release.yml) checks the tag matches `package.json`, runs the checks
and `npm run test:compat` again, packages the archive and publishes it. A version with a `-` becomes a GitHub
pre-release (no Raspberry Pi image), and hubs list it under **Beta versions** without installing it. A plain `x.y.z`
becomes the latest release, and hubs offer it within a day.

If the workflow fails before **Publish the release**, nothing was published and no hub has it: delete the tag
(`git push origin :refs/tags/v<version>` and `git tag -d v<version>`), fix the problem, and tag again. `npm run
test:compat` skips a tag without a published release (no hub can run it), but `npm test` still holds every later version
to its migrations while the tag is there.

## After

- Check the release on GitHub has `rapthooker-<version>.tar.gz`, `SHA256SUMS` and `install.sh`: hubs only list a beta
  that has its archive.
- Never move, delete or re-use a **published** tag. Hubs may be running it, and its migrations count as released.
- To get people to try a beta, give them its version: they pick it under Settings → Updates → **Beta versions**, and go
  back with **Go back to release x.y.z**.
