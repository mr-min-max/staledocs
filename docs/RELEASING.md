# Releasing StaleDocs

This is the maintainer procedure for publishing StaleDocs. It separates repository preparation from irreversible external release actions.

## Release Boundary

Merging a release-readiness pull request does not publish a package. The release workflow runs only after a matching `v*` tag is pushed. Do not create or push a release tag without a separate explicit publication decision made after every pre-release check below passes.

## 0.4.0-beta.1 record

Released on 2026-09-13 through the existing OIDC workflow with no reusable npm credential or name claim.

- PR A was merged and the exact merged main commit passed `npm run verify:release`, `npm run test:public-beta`, and the release-candidate verifier before tagging.
- Annotated tag `v0.4.0-beta.1` points to `29f8aed249d88ddbbb60daaea2bf9d9b8c3d88bc`.
- The workflow verified Node.js 22 and 24, published `staledocs@0.4.0-beta.1` with provenance, and created the GitHub prerelease.
- The npm and GitHub tarballs are byte-identical with SHA-256 `83afe2106fd97e8fa5efba24de483f9cfda852688a8a56a409ebb53d77afe062`.
- npm `beta` and the moving GitHub Action `v0` tag point to `0.4.0-beta.1`. npm `latest` remains on `0.3.0-beta.1` until the owner completes npm authentication.
- PR B runs the published package against the approved corpus and records the comparison in `docs/EVALUATIONS.md`.

The reusable procedure remains: merge a verified release-readiness PR, pin clean main, repeat the release gates, confirm private vulnerability reporting, make a separate publication decision, push an annotated matching version tag, verify the OIDC workflow and matching artifacts, promote release channels, then record published-package evidence in a follow-up PR.

The evaluation manifest holds the ten owner-approved labels. Run the old
package with an evidence directory outside the public checkout:

```bash
node scripts/evaluate-external.mjs scripts/evaluations.json \
  --package staledocs@0.3.0-beta.1 --evidence "$PRIVATE_OLD_EVIDENCE" --out /tmp/old.md
```

Only after publication, PR B runs:

```bash
node scripts/evaluate-external.mjs scripts/evaluations.json \
  --evidence "$PRIVATE_NEW_EVIDENCE" --compare "$PRIVATE_OLD_EVIDENCE" \
  --out docs/EVALUATIONS.md
```

The public output is deterministic; raw timings and command records stay in
private evidence. Any per-label expectation regression stops the comparison
without changing labels or replacing corpus rows.

## 0.3.0-beta.1 procedure

Use the same OIDC workflow and tag `v0.3.0-beta.1`. Before publication, fetch `origin/main`, confirm the release candidate is based on that commit, run the local release gates, and confirm the tree is clean. The owner then publishes the tag through the existing OIDC workflow. After npm accepts the package, run `npm dist-tag add staledocs@0.3.0-beta.1 latest` so a pre-1.0 project whose only versions are betas makes the bare install work; the `beta` tag remains for explicitness.

The old package `@mr-min-max/aidoc-gen` is not changed by this branch. After StaleDocs is published, the owner runs `npm deprecate @mr-min-max/aidoc-gen "Renamed to staledocs: npm i -g staledocs"`.

The owner also renames the GitHub repository to `staledocs` before the release tag, updates the npm Trusted Publisher to `mr-min-max/staledocs` and `release.yml`, and creates the moving major tag with `git tag -f v0 v0.3.0-beta.1 && git push -f origin v0` after publication. These are owner-only external actions.

### Claiming the new npm name before the release tag

npm cannot configure a Trusted Publisher for a package that does not exist, so the
first version under a new name cannot be published by OIDC. `staledocs` is unpublished,
which makes this a required owner step and not a defect. The recorded procedure is:

1. Rename the GitHub repository first, so the trusted publisher can name the final
   repository.
2. Publish a throwaway `0.0.1` placeholder from a trusted terminal with a one-day
   granular token restricted to publishing. Nothing from this repository is published:
   pack the placeholder from an empty temporary directory whose `package.json` declares
   only `staledocs` and `0.0.1`.
3. Configure the trusted publisher on npmjs.com: organization `mr-min-max`, repository
   `staledocs`, workflow `release.yml`, no environment.
4. Revoke the granular token and confirm `npm token list` reports none.
5. Push the release tag. The workflow publishes `0.3.0-beta.1` through OIDC with
   provenance, exactly like the previous releases.
6. After the real version exists, run `npm unpublish staledocs@0.0.1`. npm allows
   this within 72 hours. Removing every version of a name blocks republishing that
   name for 24 hours, so the placeholder must remain until the real version is
   published.
7. Move npm `latest` to `0.3.0-beta.1` and deprecate the old package with the rename
   command recorded below.

`0.0.1` is burned permanently: npm never allows a name and version pair to be reused.
That is acceptable for a placeholder outside the published range.

### Repository metadata

Description: Finds documentation that no longer matches your code. Deterministic AST check for pull requests; no API key. TypeScript, JavaScript, Python.

Topics: `documentation`, `documentation-drift`, `stale-docs`, `api-docs`, `github-action`, `pull-request`, `code-review`, `linter`, `ci`, `ast`, `typescript`, `javascript`, `python`, `developer-tools`, `mcp`, `codex`, `claude-code`.

The Action Marketplace listing is also owner-only. Publish from the release page in the categories **Code review** and **Continuous integration**. Marketplace rejects an `action.yml` description of 125 characters or more, so that field stays shorter than the repository description above.

### Awesome-list drafts

- `sindresorhus/awesome-actions` (Utilities): StaleDocs checks documentation drift in pull requests with deterministic AST analysis. https://github.com/mr-min-max/staledocs
- `punkpeye/awesome-mcp-servers` (Developer Tools): StaleDocs prepares and validates focused documentation updates through MCP. https://github.com/mr-min-max/staledocs
- `dzharii/awesome-typescript` (Tools): StaleDocs maps changed TypeScript symbols to stale documentation sections. https://github.com/mr-min-max/staledocs

## Historical beta.4 Verification Record

beta.4 was published successfully on 2026-08-14. The commands below preserve
the exact procedure that produced the immutable version and tag; do not rerun
them for beta.4. For a later release, first update every pinned version and tag
in a reviewed release-readiness change, then repeat the equivalent gates.

Run the verification and publication commands in the same trusted shell session
and keep that session open through tag creation. The `release_sha` variable is
readonly by design; if the session closes or `origin/main` changes, restart this
section and repeat every gate.

1. Fetch the remote default branch, capture its exact commit once, and prove the
   checked-out candidate is that commit:

   ```bash
   git fetch origin main &&
   release_sha="$(git rev-parse origin/main)" &&
   readonly release_sha &&
   node scripts/verify-release-candidate.mjs --main-ref origin/main --candidate-ref HEAD --tag v0.2.0-beta.4 --expected-sha "$release_sha" &&
   test -z "$(git status --porcelain=v1)"
   ```

   The worktree and index must be clean. Hosted CI on Node 22 and 24 must be
   green at that exact commit.

2. Confirm `package.json` and `package-lock.json` both identify
   `0.2.0-beta.4`, and confirm the intended tag will be
   `v0.2.0-beta.4`.

3. Before the first publication, verify both registry invariants:

   - the rejected `aidoc-gen@0.2.0-beta.3` version remains unpublished;
   - `@mr-min-max/aidoc-gen@0.2.0-beta.4` remains available.

   The checker is pinned to `https://registry.npmjs.org`, accepts only an exact
   `404` for each version, and fails closed on an existing version, redirect,
   authentication/rate/server response, or transport failure:

   ```bash
   node scripts/verify-npm-unpublished.mjs
   ```

4. Install from the lockfile and run every release gate:

   ```bash
   node scripts/verify-release-candidate.mjs --main-ref origin/main --candidate-ref HEAD --tag v0.2.0-beta.4 --expected-sha "$release_sha" &&
   test -z "$(git status --porcelain=v1)" &&
   npm ci &&
   npm run verify:release &&
   npm run build &&
   node dist/cli/index.js score --min 80 &&
   npm run test:public-beta &&
   node scripts/public-beta-preflight.mjs --json --candidate-ref "$release_sha" &&
   node scripts/verify-release-candidate.mjs --main-ref origin/main --candidate-ref HEAD --tag v0.2.0-beta.4 --expected-sha "$release_sha" &&
   node scripts/verify-npm-unpublished.mjs &&
   test -z "$(git status --porcelain=v1)" &&
   release_verified_sha="$release_sha" &&
   readonly release_verified_sha
   ```

   The block checks the exact commit and clean tree both before and after the
   gates. The final variable is created only if the whole chain succeeds. Do
   not assign it manually or continue after any command in the chain fails.

5. Review candidate commit identities, changed paths, and workflow permissions.
   Stop if a personal email, secret candidate, user-specific absolute path,
   unexpected file, or broader permission appears.

## Historical First-publication Bootstrap

Trusted Publishing is configured on an existing npm package, so the first
version required a temporary bootstrap credential. The following steps are a
historical record, not instructions to mint another token for beta.4.

1. Sign in to npm and enable strong account 2FA.
2. Create the shortest-lived granular automation token that can publish the
   new public package. Grant only the required package read/write permission
   and the CI-specific 2FA bypass required for unattended publishing. Restrict
   it to `@mr-min-max/aidoc-gen` if npm permits selecting the unpublished name.
3. From a trusted terminal, store it through the hidden GitHub CLI prompt:

   ```bash
   gh secret set NPM_TOKEN --repo mr-min-max/aidoc
   ```

Never paste the token into chat, a command argument, an environment dump, an
issue, a tracked `.npmrc`, or another repository file. Do not print the secret
after GitHub accepts it.

## Historical beta.4 Publication

Continue only in the same trusted shell session, after the maintainer explicitly
authorizes publication. Re-fetch `main` and prove both the remote tip and local
checkout still equal the one SHA that passed every gate. If either comparison
fails, do not tag; restart pre-release verification at the new commit.

1. Revalidate and create an annotated tag at that exact verified commit:

   ```bash
   test "${release_verified_sha:-}" = "$release_sha" &&
   git fetch origin main &&
   node scripts/verify-release-candidate.mjs --main-ref origin/main --candidate-ref HEAD --tag v0.2.0-beta.4 --expected-sha "$release_sha" &&
   node scripts/verify-npm-unpublished.mjs &&
   test -z "$(git status --porcelain=v1)" &&
   git tag -a v0.2.0-beta.4 "$release_sha" -m "v0.2.0-beta.4" &&
   git show --no-patch --format=fuller v0.2.0-beta.4
   ```

2. Inspect the tag target and identity. Then push only that tag:

   ```bash
   git push origin v0.2.0-beta.4
   ```

3. Watch the `Release` workflow. It verifies Node 22/24, packs once, checksums
   and smokes that exact tarball, then publishes the downloaded verified file
   with `--ignore-scripts --access public --tag beta --provenance`.
4. The GitHub prerelease is created only after npm accepts the package. It
   attaches the same tarball and checksum without rebuilding.

## Post-publication Proof

The completed beta.4 publication was verified across every external surface:

```bash
npm view @mr-min-max/aidoc-gen@0.2.0-beta.4 version --json
npm dist-tag ls @mr-min-max/aidoc-gen
node scripts/verify-npm-published.mjs
gh release view v0.2.0-beta.4 --repo mr-min-max/aidoc
```

The `beta` dist-tag must point to `0.2.0-beta.4`. npm also reports the required
`latest` tag at `0.2.0-beta.4` because this is the package's only published
version; that registry invariant is not a release-channel decision. Confirm npm
displays provenance from `mr-min-max/aidoc`, download the release tarball and
checksum, verify the checksum, and repeat the packed CLI/MCP smoke against
those exact bytes.

Only after this proof may public documentation claim that npm installation or
a GitHub prerelease exists.

npm maintainer metadata is public. Confirm that the `mr-min-max` entry uses an
approved privacy alias and never a personal or private email address. Review it
without copying the full address into logs, issues, or test fixtures; change the
"email address added to package metadata" in npm profile settings before the
next publication if the approved alias changes.

## OIDC-only beta.5 Publication Record and Account Cleanup

The npm Trusted Publisher was configured on 2026-08-14 with provider GitHub
Actions, owner `mr-min-max`, repository `aidoc`, workflow filename
`release.yml`, and allowed action `npm publish`. npm does not validate that
relationship when it is saved; only a real publish can prove that the OIDC
claims match.

`0.2.0-beta.5` is the completed OIDC verification release. Its reviewed change
removed the last `NODE_AUTH_TOKEN` wiring from the workflow. The GitHub
bootstrap secret was deleted on 2026-08-14 after this Trusted Publisher was
configured; `gh secret list --repo mr-min-max/aidoc` returned no Actions
secrets. Do not recreate it during ordinary release recovery.

The completed migration record is:

1. The GitHub bootstrap secret was absent before the OIDC verification run:

   ```bash
   gh secret list --repo mr-min-max/aidoc
   ```

   The output contained no `NPM_TOKEN`. The command exposes only secret names
   and timestamps, never stored values.

2. Hosted Node 22 and 24 CI passed on the reviewed `main` commit. The protected
   annotated `v0.2.0-beta.5` tag points directly to that commit and uses the
   approved GitHub noreply tagger identity.
3. [Release workflow run 31825128025](https://github.com/mr-min-max/aidoc/actions/runs/31825128025)
   completed successfully. Because both the GitHub secret and workflow wiring
   were absent, the successful npm publication proves the configured Trusted
   Publisher OIDC relationship authenticated the publish job.
4. npm accepted `@mr-min-max/aidoc-gen@0.2.0-beta.5`, moved the supported
   `beta` channel to it, and exposed SLSA provenance for
   `mr-min-max/aidoc/.github/workflows/release.yml`. The
   [GitHub prerelease](https://github.com/mr-min-max/aidoc/releases/tag/v0.2.0-beta.5)
   contains a checksum-matching copy of the exact npm tarball, and a clean
   installation reports `0.2.0-beta.5`.
5. Current-public documentation is promoted from beta.4 to beta.5 in a bounded
   reviewed post-publication change. The registry-managed `latest` tag is not
   the supported prerelease channel and must not be removed merely because it
   still names beta.4.

The account-level cleanup was completed on 2026-08-14 in the authenticated npm
UI and CLI session without recording token identifiers, values, or
authenticator codes in repository logs:

1. Set package publishing access to **Require two-factor authentication and
   disallow bypass tokens**:

   ```bash
   npm access set mfa=publish @mr-min-max/aidoc-gen
   ```

2. Both temporary granular bypass tokens created for the beta.4
   bootstrap/recovery attempts were deleted with **Delete Selected Tokens**.
   A safe authenticated follow-up audit reported zero active npm tokens and
   zero temporary bypass tokens without printing token metadata.
3. The Trusted Publisher entry for `mr-min-max/aidoc` and `release.yml` remains
   configured after cleanup. Ordinary releases must continue to use OIDC; do
   not recreate `NPM_TOKEN` or mint another automation token as a shortcut.

If OIDC fails on a future release, diagnose the trust configuration first.
Restoring the bootstrap secret requires a separate deliberate recovery
decision; do not silently add it back during the failed run.

Trusted Publishing requires a GitHub-hosted runner, `id-token: write`, Node
`>=22.14.0`, and npm `>=11.5.1`. The release workflow checks the npm floor and
grants OIDC only to its publish job.

## OIDC-only beta.6 Publication Record

`0.2.0-beta.6` was published on 2026-08-16 from protected main commit
`fd58309943a161aadce812bda43c60722abbf972`. The annotated tag points directly
to that commit and uses the approved GitHub noreply identity.

The [release workflow run](https://github.com/mr-min-max/aidoc/actions/runs/31914951538)
passed Node 22 and 24 verification, packaged once, and published the verified
tarball through npm Trusted Publishing (OIDC). npm provenance identifies
`https://github.com/mr-min-max/aidoc`, `.github/workflows/release.yml`, and
`refs/tags/v0.2.0-beta.6`. No `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or reusable npm
credential was present in the workflow.

npm `beta` resolves to `0.2.0-beta.6`; npm `latest` remains
`0.2.0-beta.4`. The matching
[GitHub prerelease](https://github.com/mr-min-max/aidoc/releases/tag/v0.2.0-beta.6)
contains the exact npm tarball and its checksum. The registry tarball SHA-256
is `b68ec3a879d5e84837bb98a868de9741d2c8a840c019f8f7a560396e998372c1`.
A clean registry installation reported `0.2.0-beta.6`, and the exact registry
bytes passed the packaged CLI and MCP smoke tests.

The postpublication gate is `npm run test:public-beta`. It verifies the live
published beta and pinned `latest` state; the mocked unpublished tests remain
utility regression coverage and are no longer part of the active public gate.

## Failure Handling

- Before npm accepts the package, stop on any identity, version, name,
  permission, checksum, smoke, authentication, or provenance mismatch. Do not
  push another tag as an experiment.
- An npm version is immutable after successful publication. Never attempt to
  overwrite or silently replace it.
- If npm succeeds but GitHub prerelease creation fails, preserve the workflow
  evidence, verify the registry state, and repair only the missing GitHub
  release in a separately reviewed operation.
- If the beta dist-tag is wrong, inspect registry state before changing it.
  Never try to remove npm's required `latest` tag; prerelease documentation and
  tests must use explicit `@beta` instead of treating `latest` as supported.
- Do not delete logs or artifacts while diagnosing a partial release.

## Primary References

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance statements](https://docs.npmjs.com/generating-provenance-statements/)
- [npm dist-tags](https://docs.npmjs.com/cli/dist-tag/)
- [npm registry package metadata](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)
