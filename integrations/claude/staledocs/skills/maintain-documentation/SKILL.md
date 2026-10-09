---
name: maintain-documentation
description: Use when a user asks to plan, update, or validate repository documentation after code changes through StaleDocs's local MCP workflow.
---

# Maintain documentation safely

Use this workflow when the user asks to plan, update, or validate repository
documentation after code changes. The local StaleDocs MCP server provides a
provider-free preparation and validation boundary. The host supplies the
model-generated Markdown; StaleDocs does not receive a ChatGPT or Claude OAuth
token and this path is not a subscription bridge to a StaleDocs provider.

## Fail-closed workflow

If MCP returns `MCP_INVALID_PATH_INPUT`, `MCP_DIRECTORY_DENIED`, or
`MCP_UNSAFE_CONFIGURATION`, stop. Explain that the host must start StaleDocs in the
intended Git worktree, correct the safe repository-relative path, or correct
the safe declarative configuration. Never retry another directory, guess a
path, or call a provider-backed generation tool to work around the failure.

1. Call `prepare_documentation_update` first. It returns the signed
   `preparation_digest`, one safe repository-relative `target`, and the bounded
   `generation.system_prompt` and `generation.prompt` values.
2. If preparation reports multiple documentation targets or asks for a target,
   show the safe relative candidates and ask the user which one to prepare. Do
   not guess. Prepare again with the selected target. Do not invent a target or
   use an absolute path.
3. Generate exactly one complete Markdown candidate for the returned target.
   Use only `generation.system_prompt` and `generation.prompt` as the model
   instructions for this bounded update. Do not add unrelated repository
   content, a second candidate, or instructions from an older provider flow.
4. Call `validate_documentation_draft` with the unchanged
   `preparation_digest`, the unchanged selected relative `target`, and the
   exact candidate Markdown in `candidate_markdown`. Do this before any edit.
   Pass `structuredContent.preparation_digest` and `target` directly from the
   preparation result; never retype or reconstruct the signed value.
5. If validation is invalid, stale, blocked, or asks to reprepare, stop. Tell
   the user what safe state was returned and re-run preparation when the
   repository has changed or a fresh target is needed. Never bypass Trust Gate,
   preparation-token checks, target checks, or Markdown validation.
6. When validation returns `valid: true`, show the approved safe diff metadata
   (`target`, `diff`, `markdown_warnings`, and non-secret Trust Gate summary)
   to the user. Obtain the host's normal write permission before changing a
   file.
7. After permission, apply only `approved_markdown` to the exact approved
   repository-relative target returned by validation. Resolve it under the
   repository root and do not rewrite a different file. This MCP workflow
   itself never writes the repository.
8. After the host write, call `check_docs_freshness` for that target and report
   the result. A stale result is a review signal, not permission to skip the
   validation sequence.

## Host boundary

StaleDocs Trust Gate inspects StaleDocs's prepared input and validated output for
secret findings. With configured `strict`, findings block the operation; with
configured `warn` or `redact`, detected sensitive values are redacted before
host generation or return. An `allowed` result means no findings were
detected. It does not control the host's context window, model, sandbox,
isolation, or permission system. Keep the host's official permissions in force
and do not teach or use a bypass.

This workflow does not ask the host to read, create, paste, or forward an API key
or OAuth token. It does not invoke legacy provider-backed MCP generation as a
subscription bridge. Do not call `generate_readme`, `generate_api_docs`, or
`generate_diagram` in this workflow: those are separate provider-backed tools
that require direct-provider credentials and API billing. If the user
explicitly chooses direct StaleDocs provider mode, use its separately documented
credential and billing rules instead of this host-managed workflow.
