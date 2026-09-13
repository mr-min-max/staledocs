# StaleDocs with local Codex

This guide covers the published `0.4.0-beta.1` StaleDocs CLI with the official local Codex host and StaleDocs's provider-free MCP tools. It is not a ChatGPT web integration or a marketplace installation guide.

For the complete command catalogue and beta boundaries, see [CLI.md](../CLI.md)
and [Public Beta](../PUBLIC_BETA.md). The [GitHub Action reference](../GITHUB_ACTION.md)
covers the separate CI generate and check path.

## What is authenticated

Sign in to the official local Codex client using its supported ChatGPT
authentication flow. A ChatGPT Plus/Pro subscription authorizes the host's
model access; it is not an OpenAI API key and it is not a general StaleDocs API
credential. StaleDocs receives no ChatGPT OAuth token. ChatGPT web does not read
local Codex configuration or local STDIO MCP servers.

Consumer subscription access and OpenAI API billing are separate products. If
you choose direct StaleDocs provider mode instead, configure `openai` with
`OPENAI_API_KEY` and pay the OpenAI API account separately.

Official references: [Codex authentication](https://developers.openai.com/codex/auth)
and [Codex MCP](https://developers.openai.com/codex/mcp).

## Setup

Install the published prerelease:

```bash
npm install -g staledocs@beta
staledocs --version
```

For development from an StaleDocs checkout:

```bash
npm install
npm run build
npm link
staledocs --version
```

The repository-owned plugin root is `integrations/codex/staledocs`. Its local MCP
configuration invokes exactly `staledocs --mcp`. This release does not create a
marketplace entry or install a plugin into a personal marketplace. Use the
host's local plugin-development workflow to load the repository-owned source
integration when testing it.

For a copyable MCP setup after the npm install or `npm link`:

```bash
codex mcp add staledocs -- staledocs --mcp
codex mcp list
```

You can verify the connection with `/mcp` in Codex. Remove it with
`codex mcp remove staledocs`. Marketplace installation/distribution is a later
step; no marketplace entry is created here.

To reverse the global source-checkout link:

```bash
npm unlink -g staledocs
```

## Pinned MCP repository scope

Each `staledocs --mcp` server is pinned to the canonical Git worktree containing
its startup cwd. One server serves one startup worktree; start another server
from another repository when you change repositories. The root and real
subdirectories are allowed, and both absolute in-worktree paths and
repository-relative directory paths work.

External paths, parent traversal, `.git` or other Git metadata, missing or
non-directory paths, and every symlink or junction fail closed before project
reads. Successful MCP paths are repository-relative POSIX paths.

MCP reads only bounded declarative JSON/YAML/no-extension configuration,
`package.json#staledocs`, and the pinned-root `.env` allowlist. It rejects
malformed or symlinked selected configuration, executable JavaScript,
TypeScript, CJS, or MJS configuration, and the legacy `apiKey` project field.
Direct CLI cosmiconfig and dotenv behavior is unchanged. This is a repository
path/read boundary, not an operating-system sandbox: privileged same-host
races and hard-link identity are outside this API-level guarantee, and network
access remains controlled by the provider transport and Trust Gate.

## Safe documentation workflow

When the user asks to update documentation, the bundled skill requires this
sequence:

1. Call `prepare_documentation_update`.
2. Ask the user to choose when multiple safe relative targets are returned;
   never guess.
3. Generate one complete Markdown candidate using only
   `generation.system_prompt` and `generation.prompt`.
4. Call `validate_documentation_draft` with the unchanged
   `preparation_digest`, selected relative `target`, and exact
   `candidate_markdown`.
5. Stop or reprepare if validation is invalid, stale, blocked, or asks for a
   fresh preparation.
6. Show the approved diff metadata, request Codex's normal write permission,
   apply only `approved_markdown` to the exact approved target, and call
   `check_docs_freshness` afterward.

The preparation/validation path is provider-free and does not write the
repository. It uses the host's model for the bounded candidate, not a legacy
provider-backed MCP generation call and not a subscription-to-API bridge.

A live fix-path check on 2026-09-12 with Codex CLI 0.149.0-alpha.4.1 produced a correct README candidate for a changed public TypeScript API. The first validation using the exact signed output of its preparation accepted that candidate with no warnings, and no repository file was written without permission. Two preliminary manual-transcription attempts failed closed and are tracked in issue #49.

## Trust boundary

StaleDocs Trust Gate inspects StaleDocs's prepared input and validated output for
secret findings. Configured `strict` blocks findings; configured `warn` or
`redact` redacts detected sensitive values before host generation or return.
An `allowed` result means no findings were detected. Trust Gate does not
control Codex's context window, model, sandbox, isolation, or permission
system. Keep Codex's official permissions in force; do not read, create,
paste, or forward an API key or OAuth token for this host-managed path.

For direct provider mode, the supported profiles are `openai`, `anthropic`,
`deepseek`, `qwen`, `openai-compatible`, and `ollama`; see [Public Beta](../PUBLIC_BETA.md)
for exact credentials and billing boundaries.
