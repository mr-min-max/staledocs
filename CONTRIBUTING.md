# Contributing to staledocs

First off, thanks for taking the time to contribute! 🎉

## Development Setup

Use Node.js `>=22.12.0`.

1. Fork or clone the repository.
2. Install the locked dependency graph: `npm ci`.
3. Build the CLI: `npm run build`
4. Verify the provider-free path: `node dist/cli/index.js plan`.
5. Optionally run `npm link` to use `staledocs` globally while developing.

## Running Tests

We use Jest for testing.

```bash
npm run test              # Run all tests
npm run test:watch        # Run in watch mode
npm run test:coverage     # Run with coverage report
npm run test:provider-contracts
npm run test:hybrid-beta
```

Before opening a pull request, run the same release-integrity gate used by CI:

```bash
npm run verify:release
```

For public-beta preparation changes, also run:

```bash
npm run test:public-beta
```

For Claude Code plugin changes, use Claude Code >=2.1.281:

```bash
claude plugin validate --strict ./integrations/claude/staledocs
claude plugin validate --strict .
```

Then load it from a separate consumer Git worktree with `--plugin-dir`,
confirm `/mcp` connects, and exercise the changed skill. See the
[Claude guide](./docs/integrations/claude.md) for scope and billing boundaries.

Never include API keys, raw provider context, private paths, or personal
contact details in issues, fixtures, logs, or pull requests.

## Architecture

`staledocs` uses a modular architecture with the following principles:

1. **AST First, LLM Second** — We rely on deterministic AST parsing (`ts-morph` for TS, Python's `ast` module for Python) to extract code structure BEFORE sending anything to the LLM. Do not try to parse code using regex.

2. **Provider Agnostic** — When adding LLM features, do not hardcode OpenAI logic. Use the `LLMProvider` interface in `src/providers/types.ts`.

3. **Template Driven** — All prompts must be stored as Handlebars templates in `src/templates/`. Do not inline large prompt strings in the TypeScript code.

4. **Testing** — Write unit tests for all new parsers, providers, and core modules.

### Directory Structure

- `src/cli/` — Commander.js CLI interface
- `src/core/` — Business logic (Analyzer, Generator, Cache, Retry, Logger)
- `src/parsers/` — Language-specific AST parsers
- `src/providers/` — provider profiles, selection, endpoint policy, and adapters
  for OpenAI, Anthropic, DeepSeek, Qwen, explicit OpenAI-compatible endpoints,
  and local Ollama
- `src/mcp/` — Model Context Protocol server
- `src/templates/` — Handlebars prompt templates
- `src/output/` — Markdown output and diff display

## Adding a New Language Parser

1. Create `src/parsers/yourlang.ts` implementing the `LanguageParser` interface
2. Register it in `src/parsers/registry.ts`
3. Create test fixtures in `tests/fixtures/`
4. Write comprehensive tests in `tests/unit/parsers/`

## Adding a New LLM Provider

1. Create `src/providers/yourprovider.ts` implementing `LLMProvider`
2. Register it in `src/providers/registry.ts`
3. Update configuration defaults only if the provider needs new settings
4. Write unit tests

## Good First Contributions

Good starter tasks usually fit one of these areas:

- Add parser fixtures that cover real-world syntax.
- Improve Handlebars templates in `src/templates/`.
- Add focused tests around CLI flags and output validation.
- Improve documentation examples for `score`, `watch`, and MCP usage.

Check issues labeled [`good first issue`](https://github.com/mr-min-max/staledocs/labels/good%20first%20issue)
for tasks with current acceptance criteria.

## Code Style

- We use TypeScript strictly (`strict: true`).
- Follow the existing ESLint and Prettier rules.
- Run `npm run lint:fix` when needed, then run `npm run verify:release` before
  submitting a PR.
- Use `--verbose` flag for debug logging during development.
