import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  collectToolCalls,
  deriveRunResult,
  firstModel,
  parseJsonLines,
  readFixture,
  renderSummaryTable,
  summarizeRuns,
} from "../../../scripts/codex-fix-path/analysis.cjs";

const samples = resolve("tests/fixtures/codex-fix-path");
const fixtures = resolve("scripts/codex-fix-path/fixtures");

function sample(name: string): string {
  return readFileSync(join(samples, `${name}.jsonl`), "utf8");
}

function finalAnswer(): string {
  return JSON.stringify({
    target: "README.md",
    valid: true,
    markdown_warnings: [],
    approved_markdown:
      "# Lib\n\n## Usage\n\nCall `greet(name, loud)` with a name and whether to shout.\n",
  });
}

const expected = { staleDocument: "README.md", contains: "loud" };

describe("Codex fix-path harness analysis", () => {
  it("parses JSONL and counts malformed lines without failing", () => {
    const parsed = parseJsonLines(sample("retyped-digest"));

    expect(parsed.events).toHaveLength(8);
    expect(parsed.malformedLines).toBe(1);
  });

  it("collects completed MCP tool calls in order", () => {
    const { events } = parseJsonLines(sample("retyped-digest"));

    expect(
      collectToolCalls(events).map((call: { tool: string; status: string }) => [
        call.tool,
        call.status,
      ]),
    ).toEqual([
      ["prepare_documentation_update", "completed"],
      ["validate_documentation_draft", "failed"],
      ["prepare_documentation_update", "completed"],
      ["validate_documentation_draft", "completed"],
    ]);
  });

  it("scores a first-attempt validation by target", () => {
    const { events } = parseJsonLines(sample("validate-by-target"));

    const result = deriveRunResult({
      events,
      finalMessage: finalAnswer(),
      expected,
      writes: [],
    });

    expect(result).toMatchObject({
      first_validate_ok: true,
      digest_relayed: false,
      correct: true,
      writes: [],
      validate_calls: 1,
      invalid_preparation_errors: 0,
      final_answer_matches_validation: true,
    });
    expect(result.tool_calls).toEqual([
      {
        server: "staledocs",
        tool: "prepare_documentation_update",
        status: "completed",
        arguments: {},
      },
      {
        server: "staledocs",
        tool: "validate_documentation_draft",
        status: "completed",
        arguments: {
          target: "README.md",
          candidate_markdown:
            "# Lib\n\n## Usage\n\nCall `greet(name, loud)` with a name and whether to shout.\n",
        },
        valid: true,
      },
    ]);
  });

  it("does not score a run whose first validation failed on a retyped digest", () => {
    const { events } = parseJsonLines(sample("retyped-digest"));

    const result = deriveRunResult({
      events,
      finalMessage: finalAnswer(),
      expected,
      writes: [],
    });

    expect(result).toMatchObject({
      first_validate_ok: false,
      digest_relayed: true,
      correct: true,
      validate_calls: 2,
      invalid_preparation_errors: 1,
    });
    expect(result.tool_calls[1]).toMatchObject({
      tool: "validate_documentation_draft",
      status: "failed",
      error: "MCP_INVALID_PREPARATION: The MCP preparation is invalid.",
    });
  });

  it("marks a run incorrect when no validated Markdown has the expected text", () => {
    const { events } = parseJsonLines(sample("validate-by-target"));

    const result = deriveRunResult({
      events,
      finalMessage: "not json",
      expected: { staleDocument: "README.md", contains: "verbose" },
      writes: [" M README.md"],
    });

    expect(result).toMatchObject({
      first_validate_ok: true,
      correct: false,
      writes: [" M README.md"],
      final_answer: null,
      final_answer_matches_validation: false,
    });
  });

  it("scores a recorded stream whose MCP calls the host blocked", () => {
    const { events } = parseJsonLines(sample("approval-blocked"));

    const result = deriveRunResult({
      events,
      finalMessage: null,
      expected,
      writes: [],
    });

    expect(result).toMatchObject({
      first_validate_ok: false,
      correct: false,
      validate_calls: 0,
      invalid_preparation_errors: 0,
    });
    expect(result.tool_calls).toEqual([
      {
        server: "staledocs",
        tool: "prepare_documentation_update",
        status: "failed",
        arguments: {},
        error: "MCP tool call requires approval, but approval policy is never",
      },
      {
        server: "staledocs",
        tool: "prepare_documentation_update",
        status: "failed",
        arguments: {},
        error: "MCP tool call requires approval, but approval policy is never",
      },
    ]);
    expect(firstModel(events)).toBeNull();
  });

  it("reports no first-attempt success when validation never ran", () => {
    const result = deriveRunResult({
      events: [],
      finalMessage: null,
      expected,
      writes: [],
    });

    expect(result).toMatchObject({
      first_validate_ok: false,
      digest_relayed: false,
      correct: false,
      validate_calls: 0,
    });
  });

  it("finds the first event that names a model", () => {
    expect(
      firstModel([
        { type: "thread.started" },
        { type: "turn.started", model: "model-a" },
        { type: "turn.completed", model: "model-b" },
      ]),
    ).toBe("model-a");
    expect(firstModel([{ type: "thread.started" }])).toBeNull();
  });

  it("summarizes runs per fixture and renders the table", () => {
    const run = (
      fixture: string,
      durationSeconds: number,
      overrides: Record<string, unknown> = {},
    ) => ({
      fixture,
      durationSeconds,
      first_validate_ok: true,
      correct: true,
      digest_relayed: false,
      writes: [] as string[],
      ...overrides,
    });

    const rows = summarizeRuns([
      run("ts-method", 40),
      run("ts-function", 90),
      run("ts-function", 30, {
        first_validate_ok: false,
        digest_relayed: true,
      }),
      run("ts-function", 60, { correct: false, writes: [" M README.md"] }),
      run("ts-method", 51),
    ]);

    expect(rows).toEqual([
      {
        fixture: "ts-function",
        runs: 3,
        first_validate_ok: 2,
        correct: 2,
        writes: 1,
        digest_relayed: 1,
        median_seconds: 60,
      },
      {
        fixture: "ts-method",
        runs: 2,
        first_validate_ok: 2,
        correct: 2,
        writes: 0,
        digest_relayed: 0,
        median_seconds: 45.5,
      },
    ]);
    expect(renderSummaryTable(rows)).toBe(
      [
        "| Fixture | Runs | first_validate_ok | correct | writes | median seconds |",
        "| --- | --- | --- | --- | --- | --- |",
        "| ts-function | 3 | 2/3 | 2/3 | 1/3 | 60.0 |",
        "| ts-method | 2 | 2/2 | 2/2 | 0/2 | 45.5 |",
      ].join("\n"),
    );
  });

  it.each(["ts-function", "ts-method"])(
    "reads the shipped %s fixture",
    (name) => {
      const fixture = readFixture(
        JSON.parse(readFileSync(join(fixtures, `${name}.json`), "utf8")),
      );

      expect(fixture.name).toBe(name);
      expect(fixture.expect.staleDocument).toBe("README.md");
      expect(fixture.base[fixture.expect.staleDocument]).toContain("##");
      expect(fixture.base[fixture.expect.staleDocument]).not.toContain(
        fixture.expect.contains,
      );
    },
  );

  it.each([
    { label: "parent traversal", path: "../outside.md" },
    { label: "absolute path", path: "/tmp/outside.md" },
    { label: "Git metadata", path: ".git/config" },
  ])("rejects a fixture with a $label", ({ path }) => {
    expect(() =>
      readFixture({
        name: "unsafe",
        description: "unsafe",
        base: { [path]: "x" },
        head: {},
        expect: { staleDocument: "README.md", contains: "x" },
      }),
    ).toThrow("Invalid fixture");
  });
});
