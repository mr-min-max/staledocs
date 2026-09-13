# StaleDocs

Formerly aidoc.

StaleDocs reads your code, finds public API changes in a pull request, and tells you which documentation sections now describe the old behavior.

## Add to a repository in one file

```yaml
name: StaleDocs review
on: {pull_request: {types: [opened, synchronize, reopened]}}
permissions: {contents: read, pull-requests: write}
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with: {fetch-depth: 0}
      - uses: mr-min-max/staledocs@v0.4.0-beta.1
        with:
          mode: review
```

## What the comment contains

- Changed symbols with before and after signatures.
- Sections that mention them and were not updated.
- `breaking-change` and `docs-stale` labels when applicable.

No model, no API key, no writes. It is deterministic AST analysis.

## From the terminal

Install the command:

```bash
npm install -g staledocs@beta
```

`staledocs review` reports documentation impact for a pull request.

`staledocs plan` prints the affected documentation targets.

`staledocs check` exits with code 1 when a section mentioning a changed public symbol was not updated, and exits 0 otherwise.

## Fix the docs with your assistant

```bash
codex mcp add staledocs -- staledocs --mcp
```

`prepare_documentation_update` gives the assistant the exact sections and before and after signatures.

StaleDocs validates the candidate, and the assistant applies the approved Markdown.

See the [Codex guide](./docs/integrations/codex.md) and [Claude guide](./docs/integrations/claude.md).

## Languages

TypeScript, JavaScript, and Python are supported. A public symbol is one reachable from the package entry; see [LIMITATIONS.md](./docs/LIMITATIONS.md).

See [LIMITATIONS.md](./docs/LIMITATIONS.md) for syntax and discovery caveats.

## Legacy generators

`readme`, `api`, `changelog`, `diagram`, and `annotate` remain available for initial documentation. They need a provider key or Ollama and are not the focus of StaleDocs. See the [CLI catalogue](./docs/CLI.md).

## Status and links

StaleDocs `0.4.0-beta.1` is published. The `beta` channel and GitHub Action `v0` tag use this release; npm `latest` follows after the owner completes npm authentication.

[![npm](https://img.shields.io/npm/v/staledocs/beta?label=npm%20beta)](https://www.npmjs.com/package/staledocs)
[![CI](https://github.com/mr-min-max/staledocs/actions/workflows/ci.yml/badge.svg)](https://github.com/mr-min-max/staledocs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-3FB950.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-58A6FF.svg)](https://nodejs.org/)

- [Contributing](./CONTRIBUTING.md)
- [Security](./SECURITY.md)
- [Limitations](./docs/LIMITATIONS.md)
- [Changelog](./CHANGELOG.md)
- [Evaluations](./docs/EVALUATIONS.md)
