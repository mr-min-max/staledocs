# StaleDocs with Claude Desktop or Claude Code

This guide covers the Claude Code plugin and manual local MCP hosting for
StaleDocs `0.4.0-beta.1`. Neither path gives StaleDocs Claude.ai OAuth access
or turns a host subscription into a direct-provider credential.

For the complete command catalogue and beta boundaries, see [CLI.md](../CLI.md)
and [Public Beta](../PUBLIC_BETA.md). The [GitHub Action reference](../GITHUB_ACTION.md)
covers the separate CI generate and check path.

## Subscription boundary

Claude Desktop and Claude Code authenticate their own host session. Claude Pro
or Max is a consumer/host subscription; Anthropic API billing is separate.
StaleDocs receives no Claude subscription token and no Claude OAuth credential.
For direct StaleDocs Anthropic generation, use the separate `anthropic` profile and
`ANTHROPIC_API_KEY`.

Official references: [Claude Code MCP](https://code.claude.com/docs/en/mcp),
[Claude Code Pro/Max](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan),
and [consumer/API billing separation](https://support.anthropic.com/en/articles/9876003-i-subscribe-to-a-paid-claude-ai-plan-why-do-i-have-to-pay-separately-for-api-usage-on-console).

## Claude Code plugin

Requires Node.js **>=22.12.0**, npm/npx on `PATH`, a Git worktree, and
Claude Code **>=2.1.281** for strict validation of the directory metadata.
Start Claude Code in the repository you want to check, then install:

```text
/plugin marketplace add mr-min-max/staledocs
/plugin install staledocs@staledocs
```

Restart Claude Code if it requests a restart. Use `/mcp` to confirm that the
plugin's StaleDocs server is connected. The repository hosts its own
marketplace; this is **not an approved listing in Anthropic's directory**.

The plugin pins its local MCP command to `npx --yes staledocs@0.4.0-beta.1 --mcp`.
The first launch downloads the npm package and dependencies; subsequent launches
use npm's cache. No StaleDocs provider key is required for drift analysis,
preparation, or draft validation. Claude authenticates and bills its own model
session separately.

Available skills:

- `/staledocs:check [base-ref]`: check documentation freshness through MCP;
  report stale, missing, and unknown evidence without writing files.
- `/staledocs:review [base-ref]`: run the deterministic CLI review report in
  the current worktree, with Claude's normal shell permission.
- `/staledocs:maintain-documentation`: prepare a bounded update, generate a
  draft with the host model, validate it, and ask permission before applying
  only the approved Markdown.

The plugin has no hooks or automatic writes. Start a new Claude Code session
in the intended worktree when switching projects; an already-running MCP
server does not follow later shell directory changes.

### Developing the plugin

From a StaleDocs checkout:

```bash
claude plugin validate --strict ./integrations/claude/staledocs
claude plugin validate --strict .
```

Load the plugin for one session **from a separate consumer worktree**:

```bash
claude --plugin-dir /absolute/path/to/staledocs/integrations/claude/staledocs
```

Inside StaleDocs's own checkout, npm can select the local package instead of
downloading the pinned version. Without an installed `staledocs` executable,
this reports `staledocs: command not found`. For source development, build and
use the manual MCP command below; do not change the pinned plugin to a global
or unversioned package.

## Manual MCP: Claude Code or Claude Desktop

Install the published version:

```bash
npm install -g staledocs@0.4.0-beta.1
staledocs --version
```

For Claude Code, run this from the intended worktree:

```bash
claude mcp add --transport stdio staledocs -- staledocs --mcp
```

Do not add this manual entry if the plugin already provides the server.
For source development, run `npm ci` and `npm run build` in the StaleDocs
checkout, then substitute `node /absolute/path/to/staledocs/dist/cli/index.js`
for `staledocs` in the MCP command.

For Claude Desktop, configure a local stdio server whose **startup working
directory is the intended Git worktree**:

```json
{
  "mcpServers": {
    "staledocs": {
      "command": "staledocs",
      "args": ["--mcp"]
    }
  }
}
```

This JSON alone does not set a working directory. Desktop hosts may launch
stdio servers outside your repository; arrange the working directory in
your host's supported launcher before using this entry. It is not a remote
connector for claude.ai, and a `directory` tool argument cannot rebind the server.

## Pinned MCP repository scope

Each `staledocs --mcp` server is pinned to the canonical Git worktree containing
its startup cwd. One server serves one repository; start another server from
another repository when you change repositories. The root and real
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

## Safe update sequence

Use the provider-free MCP boundary in this order:

1. Call `prepare_documentation_update`.
2. Ask the user to choose a target if preparation reports multiple targets;
   never guess.
3. Generate one Markdown candidate from only the returned
   `generation.system_prompt` and `generation.prompt`.
4. Validate it with `validate_documentation_draft`, passing
   `structuredContent.preparation_digest` and the selected relative target
   unchanged from preparation. Never retype or reconstruct the signed value.
5. Stop or reprepare on invalid, stale, blocked, or reprepare-required output.
6. Show the approved diff metadata, request Claude's normal permission, apply
   only `approved_markdown` to the exact target, and call
   `check_docs_freshness`.

StaleDocs Trust Gate inspects StaleDocs input/output for secret findings. Configured
`strict` blocks findings; configured `warn` or `redact` redacts detected
sensitive values before host generation or return. An `allowed` result means
no findings were detected. Trust Gate does not control Claude's context
window, model, sandbox, isolation, or permission system. StaleDocs does not read
Claude authentication files or receive a Claude subscription token.

Known host-integration limitation: [issue #49](https://github.com/mr-min-max/staledocs/issues/49)
records a live Codex attempt that transcribed the signed digest incorrectly.
An altered digest is rejected; prompting a host to preserve it is not a
programmatic relay guarantee. Reprepare if needed, never bypass validation.

Direct provider mode supports `openai`, `anthropic`, `deepseek`, `qwen`,
`openai-compatible`, and `ollama` separately; it never silently falls back.
See [Public Beta](../PUBLIC_BETA.md) for exact API credential variables,
including `ANTHROPIC_API_KEY`.
