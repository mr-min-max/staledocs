# Roadmap

## Now

StaleDocs `0.5.0-beta.1` is published on npm and in the official MCP Registry as
`io.github.mr-min-max/staledocs`. It adds `staledocs audit` with the
`audit_documentation` MCP tool, the read-only `review_documentation_impact` MCP
tool, stale findings only for contract changes, Python constructor checks, and
Codex and Claude Code plugin marketplaces. `validate_documentation_draft` no
longer needs the preparation digest
([issue #49](https://github.com/mr-min-max/staledocs/issues/49) is closed).

## Next

Candidates, not promises:

- Package boundaries in monorepos, so a change in one package maps only to its
  own documentation.
- Matching documentation mentions to class and interface members.
- A second evaluation corpus with new labels.
- `staledocs audit` as a GitHub Action mode.
- Reading Markdown from the head revision instead of the working tree.
- Documentation coverage badge.
- A breaking-change section in `staledocs changelog`.

## Not planned

- New languages until users ask.
- VS Code extension.
- Image generation.
- README beautification.
