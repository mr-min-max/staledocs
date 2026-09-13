# StaleDocs CLI reference

This is the complete command catalogue for the published `0.4.0-beta.1` beta.
The executable is `staledocs`. For provider credentials, subscription and API
billing boundaries, repository safety details, and current caveats, see the
[Public Beta guide](./PUBLIC_BETA.md), [Limitations](./LIMITATIONS.md), and
[SECURITY.md](../SECURITY.md).

## Invocation and provider boundary

Install the beta from npm with the explicit channel:

```bash
npm install -g staledocs@beta
staledocs --version
```

The global options are:

| Option      | Behavior                                                                             |
| ----------- | ------------------------------------------------------------------------------------ |
| `--version` | Print the installed CLI version.                                                     |
| `--verbose` | Enable verbose debug logging.                                                        |
| `--mcp`     | Start the local Model Context Protocol server instead of the CLI command dispatcher. |

Real generation commands use a configured direct provider or an explicit local
Ollama model. The `--mock` option is the credential-free test path. Planning,
checking, scoring without `--output`, and the MCP prepare/validate workflow are
provider-free. The MCP workflow prepares and validates Markdown but never writes
the repository; the host decides whether to apply the approved Markdown under
its normal permission boundary.

All document writes use the repository-contained safety checks described in the
[Public Beta guide](./PUBLIC_BETA.md). A dry run previews output without
writing. `--yes` applies a generated diff without the normal interactive
confirmation where that option is available.

## Default `staledocs` workflow

Run `staledocs` in an interactive terminal to plan the current repository first.
The plan is deterministic and provider-free. If supported source changes affect
a safe Markdown target, StaleDocs asks whether to prepare an update and then enters
the normal provider-backed update flow. It does not write documentation merely
because the command was run.

In a changed repository, the bare command is a convenient plan-first entry
point. In a clean repository there is no change impact to demonstrate; use the
seeded provider-free storefront fixture instead:

```bash
npm run demo:storefront
```

In a non-interactive terminal, bare `staledocs` prints its short command help. Use
`staledocs plan` or another explicit command for automation.

## Create project documentation

The `readme`, `api`, `diagram`, and `annotate` commands analyze supported source
files through the AST before a real provider generation request. `changelog`
instead uses normalized Git commit metadata. They accept `--mock` for local
tests and demos.

### `staledocs readme`

Generates `README.md` from code analysis.

```bash
staledocs readme
staledocs readme --output docs/README.md
staledocs readme --dry-run
staledocs readme --yes --strict-output
staledocs readme --no-badges
staledocs readme --mock
```

Options:

- `-o, --output <path>` changes the output file. The default is `./README.md`.
- `--dry-run` previews the generated document without writing.
- `--yes` applies the generated changes without an interactive prompt.
- `--strict-output` fails instead of writing malformed Markdown.
- `--no-badges` disables badge generation in the generated README.
- `--mock` uses the mock generator and does not require a provider credential.

### `staledocs api`

Generates API documentation from the analyzed modules. The default output is
`./docs/API.md`.

```bash
staledocs api
staledocs api --output docs/API.md
staledocs api --dry-run --strict-output
staledocs api --yes
staledocs api --mock
```

The options are `-o, --output <path>`, `--dry-run`, `--yes`,
`--strict-output`, and `--mock` with the same meanings as `readme`.

### `staledocs changelog`

Generates a changelog entry from Git history and prepends it to the changelog
file. If the file already begins with the standard `# Changelog` header, that
header is retained while the new entry is inserted after it.

```bash
staledocs changelog
staledocs changelog --from v0.3.0-beta.1 --to HEAD
staledocs changelog --version 0.4.0-beta.1
staledocs changelog --output docs/CHANGELOG.md
staledocs changelog --dry-run --yes --strict-output
staledocs changelog --mock
```

Options:

- `--from <ref>` selects the starting tag, commit, or branch. The default is
  the latest tag, or `HEAD~20` when no tag is available.
- `--to <ref>` selects the ending ref. The default is `HEAD`.
- `--version <ver>` names the entry. The default is `Unreleased`.
- `-o, --output <path>` changes the output file. The default is
  `./CHANGELOG.md`.
- `--dry-run`, `--yes`, `--strict-output`, and `--mock` behave as described
  above.

### `staledocs diagram`

Generates a Mermaid architecture diagram from code analysis and wraps it in an
`# Architecture` Markdown document.

```bash
staledocs diagram
staledocs diagram --output docs/architecture.md
staledocs diagram --dry-run --strict-output
staledocs diagram --yes
staledocs diagram --mock
```

The default output is `./docs/architecture.md`. The options are
`-o, --output <path>`, `--dry-run`, `--yes`, `--strict-output`, and `--mock`.

### `staledocs annotate`

Generates JSDoc or TSDoc comments for undocumented functions and shows each
proposed source diff. Without `--dry-run`, the command asks before applying
each proposed annotation. `--dry-run` previews proposals and skips writes.

```bash
staledocs annotate --all
staledocs annotate --file src/index.ts
staledocs annotate --all --dry-run
staledocs annotate --all --mock
```

Options:

- `--file <path>` limits analysis to one source file.
- `--all` considers all configured source files.
- `--dry-run` previews annotations without writing or prompting for approval.
- `--mock` uses the mock generator without a provider credential.

## Keep documentation current

### `staledocs plan`

Creates a deterministic AST-backed documentation-impact plan from Git changes.
It does not construct a provider, call a model, or write a file. Human output
is intended for review. TypeScript and JavaScript symbols are public when they
are reachable from a discovered or configured package entry. JSON output is a
versioned `aidoc.impact-plan.v1` success or error envelope with optional
`boundary`, `visibility`, `summary.internalChanges`, and
`ignored.documentationLimitReached` fields.

```bash
staledocs plan
staledocs plan --json
staledocs plan --base origin/main
staledocs plan --base v1.2.0 --head release-candidate
staledocs plan --max-context-bytes 24000
```

Options:

- `--base <ref>` selects the comparison base. Without it, StaleDocs uses
  `STALEDOCS_BASE_REF` when configured; otherwise it checks the remote default
  branch, `origin/main`, `main`, `origin/master`, `master`, and then `HEAD~1`.
- `--head <ref>` compares two immutable commits. Without it, the selected base
  is compared with the current working tree.
- `--json` emits only the versioned JSON result.
- `--max-context-bytes <count>` overrides the deterministic provider-context
  byte ceiling. It does not permit raw source or raw diffs into that context.
  For `staledocs plan --json`, each `changes[]` record includes `before` and `after`
  AST-rendered signatures when the symbol is added, removed, moved, or
  contract-changed. Callable records also include `arity` with `required` and
  `total` parameter counts for the head signature, or the base signature when the
  symbol was removed. A contract change is marked `potentially-breaking` when
  required arity increases or total arity decreases; otherwise it remains
  `review-required`. Set `entry` to an array of repository-relative package entry
  files to override `package.json` discovery. Set `docs` to an array of additional
  repository-relative Markdown files or directories to include in documentation
  discovery. Neither field accepts an absolute path or `..` traversal.

The first commit is compared with Git's empty tree. A shallow repository must
contain the selected base. A supported source file that cannot be parsed stops
the plan before provider construction or a document write.

Limitations: Python module-level constants and CommonJS `module.exports` are not
enumerated. Static relative `export ... from` declarations are followed within
the bounded public boundary described in [LIMITATIONS.md](./LIMITATIONS.md).

### `staledocs update`

Runs the plan first, resolves affected Markdown targets, selects targets, and
then generates updates. It never guesses through an ambiguous target. With no
explicit target, one safe affected Markdown target is selected automatically;
multiple targets require `--target` or `--all`.

```bash
staledocs update
staledocs update --target README.md
staledocs update --target README.md --target docs/API.md
staledocs update --all
staledocs update --base origin/main --dry-run
staledocs update --since HEAD~5 --provider openai --model gpt-5.6-luna
```

Options:

- `--base <ref>` selects the comparison base.
- `--since <ref>` is a compatibility alias for `--base`. If both are supplied,
  they must match.
- `--target <file>` selects an existing Markdown target. It can be repeated.
- `--all` updates every automatically affected document. It cannot be combined
  with `--target`.
- `--provider <name>` selects a direct provider profile.
- `--model <model>` overrides the provider model.
- `--provider-base-url <url>` sets an advanced compatible-provider base URL.
- `--allow-local-http` allows confirmed loopback HTTP for a compatible provider.
- `--yes` applies every generated diff without prompting.
- `--dry-run` previews the update without writing.
- `--mock` uses the mock response for tests.

Target selection and repository checks happen before provider construction. If
there is no documentation impact, the command prints the plan and exits without
provider setup. If the user cancels selection or provider setup, no model
request is sent. For multiple selected targets, progress and partial-failure
messages identify how many targets were processed.

### `staledocs watch`

Watches configured source globs and regenerates one document when a relevant
source change is detected. The process stays alive until interrupted.

```bash
staledocs watch
staledocs watch --target docs/README.md
staledocs watch --target docs/README.md --auto
staledocs watch --mock
```

Options:

- `--target <file>` selects the document. The default is `./README.md`.
- `--auto` writes without prompting. Without it, the normal write confirmation
  remains in place.
- `--mock` uses the mock generator without an API key.

Live generation uses a configured direct provider or explicit local Ollama
model. Watch mode uses the same repository-contained write and Trust Gate
boundaries as other real CLI generation.

### `staledocs check`

Runs the deterministic, plan-driven documentation freshness guard. A target is
`stale` only when a Markdown section directly mentions a changed public symbol
and the target was not modified in the selected Git range. It does not compare
generated prose, so a co-change does not prove content correctness.

Recommendations (such as an API or changelog suggestion) are not direct
evidence. Unmapped symbols do not fail the check, and implementation-only
changes fail only when the changed symbol is directly mentioned in the target.

```bash
staledocs check
staledocs check --target docs/API.md --since origin/main
staledocs check --base origin/main --to HEAD --json
```

With no `--target`, StaleDocs discovers the repository's root `README.md` without
assuming capitalization, including `readme.md` and `Readme.md`. The default
base is `HEAD~1`; `--base` is an alias for `--since`, and `--to` defaults to the
working tree. Use `--json` for a report containing `status`, `target`,
`targetChanged`, `referencedSymbols`, `sections`, `unmappedSymbols`,
`sourceFiles`, and `message`.

Statuses and exit codes are:

- `clean` (0): no changed public symbol is mentioned in the target, including
  an unrelated internal change or a recommendation-only mapping.
- `co-changed` (0): directly referenced symbols and the target changed together;
  content correctness was not verified.
- `stale` (1): directly referenced symbols changed but the target did not; the
  text output lists each affected section and symbol.
- `missing` (1): the selected target does not exist.
- `unknown` (2): an operational or planning failure prevented evaluation.

For example, `README.md: 1 sections mention changed public symbols and were not
updated (API: createUser)` is stale; `README.md changed with the 1 public symbol
it mentions; content correctness was not verified` is co-changed; and `No
changed public symbol is mentioned in README.md` is clean. A missing target emits
`Documentation target is missing: docs/API.md` and exits 1; an operational
failure emits `Could not evaluate documentation freshness: ...` and exits 2.

### `staledocs review`

Reviews the current pull request range with deterministic AST analysis. Review mode
reports only the drift this pull request introduces; pre-existing stale documentation is not reported.
It does not use a model, API key, or repository write. With no explicit `--head`,
the working tree is compared with the selected base.

```bash
staledocs review
staledocs review --base origin/main --head HEAD
staledocs review --format markdown
staledocs review --format json
staledocs review --base origin/main --fail-on stale
```

Options:

- `--base <ref>` selects the comparison base. The default uses planner discovery.
- `--head <ref>` selects an immutable comparison head. The default is the working tree.
- `--format <text|markdown|json>` selects terminal, comment, or machine output. The default is `text`.
- `--fail-on <none|stale|breaking>` controls the exit status. The default is `none`; `stale` fails for stale or breaking findings, and `breaking` fails only for breaking findings.
- `--max-symbols <n>` limits the text or Markdown change list, defaulting to 30. JSON is never truncated.

Markdown output starts with `<!-- staledocs-review -->`, followed by before and after
signatures, affected documentation sections, and co-changed documents. When no public
API change is found but files could not be analyzed, the zero message names up to five
of those files and says that no public API changes were found in the analyzed files.
JSON keeps schema `aidoc.review.v1` and adds the optional `notAnalyzed` array. Each
entry contains a repository-relative `path` and a bounded reason. Text and Markdown
outputs include the same not-analyzed information.

Review categories are `added`, `now exported`, `removed`, `no longer exported`, `moved`, and changed contract facets. `members` alone is rendered as `members changed`. `no longer exported` is potentially breaking; `now exported` is informational.

### `.staledocsignore`

Add deliberate suppressions at the repository root, one per line. Blank lines and
`#` comments are ignored. An exact symbol or `*` pattern suppresses a symbol; a
line containing `/` suppresses a source path; a `.md` path suppresses a documentation
file. For example:

```text
# symbol
UserService.*
# source path
src/internal/**
# documentation path
docs/legacy/*.md
```

Suppression is not a baseline mode: review mode reports only the drift this pull request introduces; pre-existing stale documentation is not reported. Add entries only for known debt or a confirmed false positive.

### Pre-commit

StaleDocs also provides a pre-commit hook for the Python pre-commit ecosystem:

```yaml
repos:
  - repo: https://github.com/mr-min-max/staledocs
    rev: v0.4.0-beta.1
    hooks:
      - id: staledocs-check
```

The immutable hook pin and moving `v0` tag both resolve to the published `0.4.0-beta.1` release.

The hook runs `staledocs check --since HEAD` on `pre-push`. It does not pass filenames.
Install Node.js and `staledocs` before enabling it.

### `staledocs score`

Calculates AST-derived documentation coverage for exported symbols. The score
is a coverage measure, not a judgment of prose quality. It performs no provider
request. Constants are enumerated but do not count toward the score.

```bash
staledocs score
staledocs score --json
staledocs score --min 80
staledocs score --dir src --output docs/score.md
staledocs score --output docs/score.md --dry-run
```

Options:

- `--dir <path>` selects the directory to analyze. The default is the current
  working directory.
- `-o, --output <path>` writes a Markdown report to the path.
- `--json` emits the score result as JSON instead of the human report.
- `--min <n>` exits non-zero when the score is below the threshold.
- `--dry-run` previews an output report without writing it.

Without `--output`, score is non-mutating. With an output path, normal
repository write safety applies.

## Related setup

- [Public Beta boundaries](./PUBLIC_BETA.md) covers provider profiles, API
  billing, Qwen PAYG, Ollama discovery, Trust Gate, and MCP scope.
- [GitHub Action reference](./GITHUB_ACTION.md) covers the composite Action's
  inputs, outputs, modes, and auto-commit boundary.
- [Codex local MCP setup](./integrations/codex.md) and [Claude local MCP setup](./integrations/claude.md)
  cover host-managed preparation and validation.
- [Security policy](../SECURITY.md) is the private reporting path for security
  issues.
