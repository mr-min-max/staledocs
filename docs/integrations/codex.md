# StaleDocs with Codex

This guide covers the Codex plugin and manual local MCP setup for the published
`0.4.0-beta.1` StaleDocs CLI. The plugin commands below were checked with Codex CLI
0.163.0-alpha.10.2. It is not a ChatGPT web integration: ChatGPT web does not read
local Codex configuration or local stdio MCP servers.

Codex signs in with your ChatGPT account; that authorizes the host's model access.
StaleDocs receives no ChatGPT OAuth token and needs no API key for drift analysis,
preparation, or draft validation.

## Install

Requires Node.js **>=22.12.0**, npm/npx on `PATH`, a Git worktree, and a signed-in
Codex. Add the repository marketplace and install the plugin:

```bash
codex plugin marketplace add mr-min-max/staledocs
codex plugin add staledocs@staledocs
```

Start a new Codex session in the repository you want to check. `codex plugin list`
shows `staledocs@staledocs` as `installed, enabled`, and `/mcp` in Codex shows the
`staledocs` server. Remove it with `codex plugin remove staledocs@staledocs`.

The plugin launches `npx --yes staledocs@0.4.0-beta.1 --mcp`. The first launch
downloads the npm package; later launches use npm's cache.

Without the plugin, add only the MCP server:

```bash
codex mcp add staledocs -- npx --yes staledocs@0.4.0-beta.1 --mcp
codex mcp list
```

Remove it with `codex mcp remove staledocs`. Do not add this entry if the plugin
already provides the server.

## What you get

Skills, mentioned in Codex with `$` or chosen from `/skills`:

- `staledocs:check`: report stale, missing, and unknown documentation evidence for
  the current worktree. Read-only.
- `staledocs:review`: summarize the deterministic review of public API changes and
  affected documentation. Read-only.
- `staledocs:maintain-documentation`: prepare a bounded update, validate the draft
  Codex writes, and ask permission before applying only the approved Markdown.

MCP tools the skills use:

- `check_docs_freshness`: stale sections that mention changed public symbols.
- `audit_documentation`: whole-repository Markdown references to scripts,
  paths, and class members that no longer exist (releases after `0.4.0-beta.1`).
- `plan_documentation_impact`: affected documentation targets for a base and head.
- `prepare_documentation_update`: bounded context and prompts for one target.
- `validate_documentation_draft`: validate a candidate without writing files.
- `review_documentation_impact`: the full review report (releases after
  `0.4.0-beta.1`; until then the review skill uses `plan_documentation_impact`).

## Safe update workflow

1. `prepare_documentation_update` returns one target and the bounded prompts. When
   several targets are returned, you choose; Codex does not guess.
2. Codex generates one complete Markdown candidate from only those prompts.
3. `validate_documentation_draft` receives the target and the exact candidate
   (releases after `0.4.0-beta.1` keep the preparation on the server). The pinned
   `0.4.0-beta.1` also requires the exact `preparation_digest`, passed as a
   structured argument from preparation. Do not copy it into text or retype it.
4. Codex stops or prepares again if validation is invalid, stale, or blocked.
5. When valid, Codex shows the approved diff and asks for its normal write
   permission, then applies only `approved_markdown` to that target.
6. `check_docs_freshness` runs afterward on the target.

A live fix-path check on 2026-09-12 with Codex CLI 0.149.0-alpha.4.1 produced a correct README candidate for a changed public TypeScript API. The first validation using the exact signed output of its preparation accepted that candidate with no warnings, and no repository file was written without permission. Two preliminary manual-transcription attempts failed closed and are tracked in issue #49.

## Reproducing the fix-path check

From a StaleDocs checkout with a signed-in Codex CLI:

```bash
npm ci && npm run build
node scripts/codex-fix-path.mjs --runs 3 --evidence <evidence directory>
```

Per fixture in `scripts/codex-fix-path/fixtures/` and run, the script builds a
temporary Git repository with a documented API change, confirms that StaleDocs
reports it stale, and runs `codex exec` once in a read-only sandbox against this
checkout's MCP server. Because `codex exec` cannot prompt, it approves only
`prepare_documentation_update` and `validate_documentation_draft`. It uses your
Codex sign-in and ChatGPT plan, needs no API key, and does not run in CI; `--runs`
is 1 to 10, and `--codex <path>` names the CLI when it is not on `PATH`. The table
counts, per fixture, runs whose first validation returned `valid: true`
(`first_validate_ok`), whose validated Markdown names the change (`correct`), and
that changed the fixture (`writes`; the script then exits non-zero).

## Repository scope and troubleshooting

Each server is pinned to the Git worktree that contains the directory where Codex
started it. Start Codex in the repository you want to check; a running server does
not follow later directory changes. See the
[repository scope rules](./claude.md#pinned-mcp-repository-scope).

- `outside the MCP repository scope`: Codex was started outside a Git worktree.
- `EACCES` from npm when the server starts: Codex launches `npx` without your shell's
  npm settings, so the default npm cache must be writable by your user.

## Boundaries

Trust Gate inspects StaleDocs's prepared input and validated output for secret
findings; it does not control Codex's context window, model, sandbox, or permission
system, so keep Codex's permissions in force. Beta limits are in
[Public Beta](../PUBLIC_BETA.md) and [Limitations](../LIMITATIONS.md); the full command
catalogue is in [CLI.md](../CLI.md). The repository marketplace is the distribution
path because OpenAI's plugin directory accepts remote HTTPS MCP servers only, and
StaleDocs runs locally over stdio.

Official references: [Codex authentication](https://developers.openai.com/codex/auth)
and [Codex MCP](https://developers.openai.com/codex/mcp).
