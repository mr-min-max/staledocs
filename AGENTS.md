# AGENTS.md

For Codex, Claude Code, Copilot, Cursor and any other agent working in this repository.

## What this is

StaleDocs is a deterministic documentation-drift linter for pull requests. It diffs the
public surface of a package between two Git revisions with ASTs and maps each change to
the Markdown sections that mention it. An optional assistant fix path hands exact targets
to the host's model through MCP; StaleDocs validates the draft and a human applies it.
Node.js >=22.12.0, TypeScript.

## Layout

- `src/parsers`: TypeScript and JavaScript through ts-morph, Python through the embedded `ast` script.
- `src/impact`: public boundary, snapshot comparison, documentation mapping, planner, impact context.
- `src/git`: Git history helpers and the revision snapshot reader.
- `src/core`: freshness checks, scoring, and the legacy generation pipeline.
- `src/output`: review, impact, and Markdown renderers.
- `src/cli`: Commander commands; `src/cli/commands/review.ts` builds the review report.
- `src/mcp`: stdio MCP server (`staledocs --mcp`), repository-scoped config, preparation tokens, update workflow.
- `src/security`: Trust Gate, repository path safety, repository writer.
- `src/config`: configuration loading, schema, planning options, suppressions.
- `src/providers` and `src/templates`: legacy generators (LLM provider adapters, Handlebars prompts).
- `action/` and `action.yml`: the GitHub Action.
- `integrations/claude/staledocs` and `integrations/codex/staledocs`: assistant plugins.
- `scripts/`: release gates, external evaluator, demos.
- `tests/`: `unit/` (Jest), `e2e/` (Node test runner and smoke scripts), `fixtures/`.
- `docs/`: user and maintainer documentation.

## Commands

```bash
npm ci                                                    # install the locked dependencies
npm run build                                             # clean dist/, compile, copy templates
npm test                                                  # Jest unit tests
npx jest tests/unit/impact/compare.test.ts --runInBand    # one test file
npm run lint                                              # ESLint over src/ and tests/
npm run verify:release                                    # the gate every PR must pass; takes several minutes
```

To see what the product does, build first. Then run
`node dist/cli/index.js review --base <ref> --head <ref> --format json` inside a Git
repository, or `npm run demo:impact` for a temporary fixture repository with one public
API change.

## Rules

- AST First, LLM Second. Read code structure with the parsers, never with regex over
  source. `src/impact/documentation.ts` is the only accepted Markdown text scanner.
- Stay provider-agnostic: LLM features go through the `LLMProvider` interface in
  `src/providers/types.ts`.
- Keep prompts as Handlebars templates in `src/templates/`, not as inline strings.
- No model calls in the detector.
- No new security boundaries, Trust Gate features, MCP scope rules, or safety vocabulary
  without a maintainer decision.
- MCP and CI paths never write the repository without a human. The host applies approved
  Markdown.
- Schema identities ending in `.v1` stay `v1`. Add fields only as optional and additive.
- Output is deterministic: sorted collections, no timestamps, no absolute paths, no
  environment-dependent text.
- Every filesystem or Git walk has an explicit count and byte limit, and reports when it
  is exceeded.
- Fixtures before heuristics: ship each heuristic with true-positive and false-positive
  fixtures written first.
- Tests defend behavior, not prose. Delete tests that pin wording; do not re-pin new
  wording.
- Never reach green by changing the measurement. Do not edit an expectation to match
  current output, weaken an assertion (`toBeTruthy`, `toBeDefined`, `not.toThrow`,
  `length > 0`, re-recorded snapshots), add `it.skip` or `.only`, hide an error with
  `as any`, `@ts-ignore`, or eslint-disable, or change the labels and commit SHAs in
  `scripts/evaluations.json`. If a command cannot pass without one of these, stop and
  report the command, its output, and why.
- Public docs: no em dash, no private paths, no secrets, no unverifiable claims
  ("verified", "adopted", "used by").
- Merging, tagging, publishing to npm, and changing repository settings are maintainer
  actions.

## Where things are documented

- `docs/CLI.md`: command catalogue.
- `docs/LIMITATIONS.md`: what StaleDocs does not check.
- `docs/GITHUB_ACTION.md`: Action modes and inputs.
- `docs/integrations/codex.md` and `docs/integrations/claude.md`: assistant setup.
- `docs/RELEASING.md`: release procedure.
- `CONTRIBUTING.md`: contributor workflow, adding a parser or a provider.
- `CHANGELOG.md`: add the entry under `## [Unreleased]`.

## Done means

- `npm run build`, `npm run lint`, `npm test`, and `npm run verify:release` pass.
- `CHANGELOG.md` has a bullet under `[Unreleased]`.
- Docs are updated for any user-visible change.
- The PR description lists added, changed, and deleted tests, with a reason for each.
