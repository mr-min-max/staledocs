The public API in this Git repository changed on the current branch, and a
Markdown document may still describe the old API.

Use the `staledocs` MCP tools to prepare, draft, and validate an update for the
affected document:

1. Call `prepare_documentation_update` without arguments.
2. Write one complete Markdown candidate for the returned `target`, using only
   the returned `generation.system_prompt` and `generation.prompt` as
   instructions.
3. Call `validate_documentation_draft` with the same `target` and the exact
   candidate in `candidate_markdown`. Do not copy `preparation_digest`. Pass
   tool results as structured arguments; never retype them.
4. If validation reports `valid: false`, revise the candidate and validate it
   again.

Never edit, create, or delete files, and do not run shell commands. The
repository must stay unchanged.

Answer only with the JSON object described by the output schema, taken from the
last validation result: `target`, `valid`, `markdown_warnings`, and
`approved_markdown` (null when no validation succeeded).
