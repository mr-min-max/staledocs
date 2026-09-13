# StaleDocs Public Beta

`0.4.0-beta.1` is the published StaleDocs beta. It uses the unscoped `staledocs` package and executable; install it through the npm `beta` channel.

StaleDocs checks documentation drift in pull requests through deterministic AST analysis for TypeScript, JavaScript, and Python. It reports changed public symbols, before and after signatures, sections that mention them, and optional `docs-stale` and `breaking-change` labels.

For caveats about prose correctness, syntax coverage, documentation discovery, Git history, Python, Trust Gate, MCP scope, and fork permissions, see [LIMITATIONS.md](./LIMITATIONS.md).

## Install

```bash
npm install -g staledocs@beta
staledocs --version
```

## Provider table

Direct generation uses a provider credential or a local Ollama model. A consumer subscription is not an API key.

| Profile | Credential or requirement | Billing |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | OpenAI API |
| `anthropic` | `ANTHROPIC_API_KEY` | Anthropic API |
| `deepseek` | `DEEPSEEK_API_KEY` | DeepSeek API |
| `qwen` | `DASHSCOPE_API_KEY` | Qwen Model Studio |
| `openai-compatible` | `STALEDOCS_COMPAT_API_KEY` and approved endpoint | Remote API |
| `ollama` | Installed local model | Local |

## MCP tools

The provider-free host sequence is `plan_documentation_impact`, `prepare_documentation_update`, `validate_documentation_draft`, and `check_docs_freshness`. Legacy generation tools remain available for explicit provider-backed use.

## Release record

See the [0.4.0-beta.1 publication record](./releases/v0.4.0-beta.1.md) and the [0.3.0-beta.1 publication record](./releases/v0.3.0-beta.1.md).
