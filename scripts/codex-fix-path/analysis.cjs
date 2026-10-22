"use strict";

// Pure helpers for scripts/codex-fix-path.mjs: read fixture definitions, parse
// `codex exec --json` events, score one run, and summarize runs. No I/O here,
// so tests/unit/scripts/codex-fix-path.test.ts can cover it without Codex.

const VALIDATE_TOOL = "validate_documentation_draft";
const INVALID_PREPARATION = "MCP_INVALID_PREPARATION";
const MAX_FIXTURE_FILES = 20;
const MAX_FIXTURE_BYTES = 64 * 1024;
const MODEL_SEARCH_DEPTH = 4;

/** Validates a fixture definition and returns it with only the known fields. */
function readFixture(definition) {
  const invalid = (reason) => new Error(`Invalid fixture: ${reason}`);
  if (!isPlainObject(definition)) throw invalid("not an object");
  const { name, description, base, head, expect } = definition;
  if (typeof name !== "string" || !/^[a-z0-9-]+$/u.test(name)) {
    throw invalid("name");
  }
  if (typeof description !== "string") throw invalid("description");
  const files = { base: readFiles(base, invalid), head: readFiles(head, invalid) };
  if (
    !isPlainObject(expect) ||
    typeof expect.staleDocument !== "string" ||
    !isSafeRelativePath(expect.staleDocument) ||
    typeof expect.contains !== "string" ||
    expect.contains.length === 0
  ) {
    throw invalid("expect");
  }
  if (Object.keys(files.base).length === 0) throw invalid("empty base");
  return {
    name,
    description,
    base: files.base,
    head: files.head,
    expect: { staleDocument: expect.staleDocument, contains: expect.contains },
  };
}

function readFiles(value, invalid) {
  if (!isPlainObject(value)) throw invalid("files");
  const entries = Object.entries(value);
  if (entries.length > MAX_FIXTURE_FILES) throw invalid("too many files");
  const files = {};
  for (const [path, content] of entries) {
    if (!isSafeRelativePath(path)) throw invalid(`path ${JSON.stringify(path)}`);
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FIXTURE_BYTES) {
      throw invalid(`content of ${path}`);
    }
    files[path] = content;
  }
  return files;
}

function isSafeRelativePath(path) {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git",
  );
}

/** Parses JSON Lines, skipping blank lines and counting lines that are not JSON objects. */
function parseJsonLines(text) {
  const events = [];
  let malformedLines = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line);
      if (isPlainObject(value)) events.push(value);
      else malformedLines += 1;
    } catch {
      malformedLines += 1;
    }
  }
  return { events, malformedLines };
}

/** Returns MCP tool calls in completion order; calls that never completed come last. */
function collectToolCalls(events) {
  const completed = [];
  const started = new Map();
  const completedIds = new Set();
  for (const event of events) {
    const item = event.item;
    if (!isPlainObject(item) || item.type !== "mcp_tool_call") continue;
    if (event.type === "item.completed") {
      completed.push(normalizeToolCall(item));
      if (typeof item.id === "string") completedIds.add(item.id);
    } else if (event.type === "item.started" && typeof item.id === "string") {
      started.set(item.id, item);
    }
  }
  const incomplete = [...started.entries()]
    .filter(([id]) => !completedIds.has(id))
    .map(([, item]) => ({ ...normalizeToolCall(item), status: "incomplete" }));
  return [...completed, ...incomplete];
}

function normalizeToolCall(item) {
  const result = isPlainObject(item.result) ? item.result : undefined;
  const structured = result?.structured_content ?? result?.structuredContent;
  const resultText = Array.isArray(result?.content)
    ? result.content
        .filter((block) => isPlainObject(block) && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
    : "";
  const errorText =
    isPlainObject(item.error) && typeof item.error.message === "string"
      ? item.error.message
      : typeof item.error === "string"
        ? item.error
        : "";
  const failed =
    item.status === "failed" ||
    errorText.length > 0 ||
    result?.is_error === true ||
    result?.isError === true;
  return {
    server: typeof item.server === "string" ? item.server : null,
    tool: typeof item.tool === "string" ? item.tool : null,
    status: failed ? "failed" : String(item.status ?? "unknown"),
    arguments: normalizeArguments(item.arguments),
    structuredContent: isPlainObject(structured)
      ? structured
      : parseObject(resultText),
    errorText: [errorText, failed ? resultText : ""].filter(Boolean).join("\n"),
  };
}

function normalizeArguments(value) {
  if (isPlainObject(value)) return value;
  if (typeof value === "string") return parseObject(value) ?? { raw: value };
  return {};
}

/** Scores one run from its events, the final message, the fixture, and fixture writes. */
function deriveRunResult({ events, finalMessage, expected, writes }) {
  const calls = collectToolCalls(events);
  const validateCalls = calls.filter((call) => call.tool === VALIDATE_TOOL);
  const firstValidateIndex = calls.findIndex((call) => call.tool === VALIDATE_TOOL);
  const firstValidate = firstValidateIndex === -1 ? undefined : calls[firstValidateIndex];
  const invalidBefore = calls
    .slice(0, Math.max(firstValidateIndex, 0))
    .some((call) => call.errorText.includes(INVALID_PREPARATION));
  const approved = [...validateCalls]
    .reverse()
    .find(
      (call) =>
        call.status === "completed" &&
        call.structuredContent?.valid === true &&
        typeof call.structuredContent.approved_markdown === "string",
    )?.structuredContent;
  const finalAnswer = readFinalAnswer(finalMessage);

  return {
    first_validate_ok:
      firstValidate !== undefined &&
      firstValidate.status === "completed" &&
      firstValidate.structuredContent?.valid === true &&
      !invalidBefore,
    digest_relayed: validateCalls.some((call) =>
      Object.hasOwn(call.arguments, "preparation_digest"),
    ),
    writes: [...writes],
    correct:
      approved !== undefined &&
      approved.target === expected.staleDocument &&
      approved.approved_markdown.includes(expected.contains),
    validate_calls: validateCalls.length,
    invalid_preparation_errors: calls.filter((call) =>
      call.errorText.includes(INVALID_PREPARATION),
    ).length,
    validated_target: approved?.target ?? null,
    validated_markdown_bytes:
      approved === undefined ? null : Buffer.byteLength(approved.approved_markdown),
    final_answer:
      finalAnswer === null
        ? null
        : {
            target: finalAnswer.target ?? null,
            valid: finalAnswer.valid ?? null,
            markdown_warnings: finalAnswer.markdown_warnings ?? null,
            approved_markdown_bytes:
              typeof finalAnswer.approved_markdown === "string"
                ? Buffer.byteLength(finalAnswer.approved_markdown)
                : null,
          },
    final_answer_matches_validation:
      approved !== undefined &&
      finalAnswer !== null &&
      finalAnswer.target === approved.target &&
      finalAnswer.approved_markdown === approved.approved_markdown,
    tool_calls: calls.map((call) => ({
      server: call.server,
      tool: call.tool,
      status: call.status,
      arguments: call.arguments,
      ...(call.tool === VALIDATE_TOOL && call.structuredContent !== null
        ? { valid: call.structuredContent.valid === true }
        : {}),
      ...(call.errorText.length > 0 ? { error: call.errorText } : {}),
    })),
  };
}

function readFinalAnswer(message) {
  if (typeof message !== "string") return null;
  return parseObject(message.trim());
}

/** Returns the first string `model` field found in the event stream, or null. */
function firstModel(events) {
  for (const event of events) {
    const model = findModel(event, 0);
    if (model !== null) return model;
  }
  return null;
}

function findModel(value, depth) {
  if (!isPlainObject(value) || depth > MODEL_SEARCH_DEPTH) return null;
  if (typeof value.model === "string" && value.model.length > 0) return value.model;
  for (const child of Object.values(value)) {
    const model = findModel(child, depth + 1);
    if (model !== null) return model;
  }
  return null;
}

/** Aggregates scored runs per fixture, sorted by fixture name. */
function summarizeRuns(runs) {
  const byFixture = new Map();
  for (const run of runs) {
    const list = byFixture.get(run.fixture) ?? [];
    list.push(run);
    byFixture.set(run.fixture, list);
  }
  return [...byFixture.keys()].sort().map((fixture) => {
    const list = byFixture.get(fixture);
    const count = (predicate) => list.filter(predicate).length;
    return {
      fixture,
      runs: list.length,
      first_validate_ok: count((run) => run.first_validate_ok),
      correct: count((run) => run.correct),
      writes: count((run) => run.writes.length > 0),
      digest_relayed: count((run) => run.digest_relayed),
      median_seconds: median(list.map((run) => run.durationSeconds)),
    };
  });
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

/** Renders the summary rows as the Markdown table the harness prints. */
function renderSummaryTable(rows) {
  const lines = [
    "| Fixture | Runs | first_validate_ok | correct | writes | median seconds |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.fixture} | ${row.runs} | ${row.first_validate_ok}/${row.runs} | ${row.correct}/${row.runs} | ${row.writes}/${row.runs} | ${row.median_seconds === null ? "n/a" : row.median_seconds.toFixed(1)} |`,
    );
  }
  return lines.join("\n");
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

module.exports = {
  collectToolCalls,
  deriveRunResult,
  firstModel,
  median,
  parseJsonLines,
  readFixture,
  renderSummaryTable,
  summarizeRuns,
};
