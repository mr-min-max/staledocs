import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeReviewCommand } from "../../../src/cli/commands/review";
import * as configLoader from "../../../src/config/loader";
import { GitSnapshotReader } from "../../../src/git/snapshot";
import * as impactPlanner from "../../../src/impact/planner";
import {
  createMCPServerContext,
  formatMCPError,
  handleToolCall,
  TOOLS,
} from "../../../src/mcp/server";
import * as providerRegistry from "../../../src/providers/registry";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(root: string, message: string): string {
  git(root, "add", "--", ".");
  git(root, "-c", "commit.gpgSign=false", "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

function reviewRepository(): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "staledocs-mcp-review-"));
  mkdirSync(join(root, "src"));
  git(root, "init", "-q", "--initial-branch", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "MCP Test");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "lib", main: "src/index.ts" }),
  );
  writeFileSync(
    join(root, "README.md"),
    "# Lib\n\n## Usage\n\nCall `greet` with a name.\n",
  );
  writeFileSync(
    join(root, "src", "index.ts"),
    'export function greet(name: string): string {\n  return "Hello " + name;\n}\n',
  );
  const base = commit(root, "base");
  git(root, "checkout", "-q", "-b", "feature");
  writeFileSync(
    join(root, "src", "index.ts"),
    'export function greet(name: string, loud: boolean): string {\n  return "Hello " + name;\n}\n',
  );
  return { root, base, head: commit(root, "contract") };
}

async function cliReview(
  root: string,
  options: { base?: string; head?: string },
): Promise<unknown> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await executeReviewCommand(
    { ...options, format: "json" },
    {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    root,
  );
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: [] });
  return JSON.parse(stdout.join(""));
}

describe("review_documentation_impact MCP tool", () => {
  const roots: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  it("advertises an optional base and head and no directory", () => {
    const tool = TOOLS.find(
      (candidate) => candidate.name === "review_documentation_impact",
    );

    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: {
        base: { type: "string", description: expect.any(String) },
        head: { type: "string", description: expect.any(String) },
      },
      additionalProperties: false,
    });
  });

  it("returns the review command's JSON report for explicit refs", async () => {
    const fixture = reviewRepository();
    roots.push(fixture.root);
    const context = await createMCPServerContext(
      fixture.root,
      Object.create(null),
    );
    const loadPlanning = jest.spyOn(context.configLoader, "loadPlanning");
    const loadSuppressions = jest.spyOn(
      context.configLoader,
      "loadSuppressions",
    );

    const report = await handleToolCall(
      "review_documentation_impact",
      { base: fixture.base, head: fixture.head },
      context,
    );

    expect(report).toEqual(
      await cliReview(fixture.root, { base: fixture.base, head: fixture.head }),
    );
    expect(report).toMatchObject({
      schemaVersion: "aidoc.review.v1",
      verdict: "stale",
      summary: { publicApiChanges: 1, staleDocuments: 1 },
      documents: [{ path: "README.md", status: "stale" }],
    });
    expect(loadPlanning).toHaveBeenCalledTimes(1);
    expect(loadSuppressions).toHaveBeenCalledTimes(1);
  });

  it("uses the review command's default comparison without refs", async () => {
    const fixture = reviewRepository();
    roots.push(fixture.root);

    const report = await handleToolCall(
      "review_documentation_impact",
      {},
      fixture.root,
    );

    expect(report).toEqual(await cliReview(fixture.root, {}));
    expect(report).toMatchObject({
      base: { commit: fixture.base },
      verdict: "stale",
    });
  });

  it("applies repository suppressions like the review command", async () => {
    const fixture = reviewRepository();
    roots.push(fixture.root);
    writeFileSync(join(fixture.root, ".staledocsignore"), "greet\n");

    const report = await handleToolCall(
      "review_documentation_impact",
      { base: fixture.base, head: fixture.head },
      fixture.root,
    );

    expect(report).toEqual(
      await cliReview(fixture.root, { base: fixture.base, head: fixture.head }),
    );
    expect(report).toMatchObject({
      summary: { publicApiChanges: 0, suppressed: 1 },
      verdict: "clean",
    });
  });

  it("never writes files, loads providers, or honors a directory argument", async () => {
    const fixture = reviewRepository();
    const outside = mkdtempSync(join(tmpdir(), "staledocs-mcp-review-outside-"));
    roots.push(fixture.root, outside);
    const readme = readFileSync(join(fixture.root, "README.md"));
    const status = git(fixture.root, "status", "--porcelain");
    const createProvider = jest.spyOn(providerRegistry, "createProvider");
    const loadProviderConfig = jest.spyOn(configLoader, "loadProviderConfig");

    const report = await handleToolCall(
      "review_documentation_impact",
      { base: fixture.base, head: fixture.head, directory: outside },
      fixture.root,
    );

    expect(report).toEqual(
      await cliReview(fixture.root, { base: fixture.base, head: fixture.head }),
    );
    expect(readFileSync(join(fixture.root, "README.md"))).toEqual(readme);
    expect(git(fixture.root, "status", "--porcelain")).toBe(status);
    expect(createProvider).not.toHaveBeenCalled();
    expect(loadProviderConfig).not.toHaveBeenCalled();
  });

  it.each([
    { label: "non-string base", args: { base: 17 } },
    { label: "non-string head", args: { head: false } },
  ])("rejects a $label before planning", async ({ args }) => {
    const planner = jest.spyOn(impactPlanner, "createImpactPlan");

    const thrown = await handleToolCall(
      "review_documentation_impact",
      args,
      "/srv/locked-repository",
    ).catch((error: unknown) => error);

    expect(formatMCPError(thrown)).toBe(
      "PLAN_INVALID_REF: The Git reference is invalid.",
    );
    expect(planner).not.toHaveBeenCalled();
  });

  it("reports an unknown ref with the planner's fixed failure", async () => {
    const fixture = reviewRepository();
    roots.push(fixture.root);

    const thrown = await handleToolCall(
      "review_documentation_impact",
      { base: "does-not-exist" },
      fixture.root,
    ).catch((error: unknown) => error);

    expect(formatMCPError(thrown)).toMatch(/^PLAN_BASE_NOT_FOUND: /u);
    expect(formatMCPError(thrown)).not.toContain(fixture.root);
  });

  it("rejects unsafe configuration before Git or AST planning", async () => {
    const fixture = reviewRepository();
    roots.push(fixture.root);
    writeFileSync(
      join(fixture.root, ".staledocsrc.js"),
      `throw new Error(${JSON.stringify(`${fixture.root}/unsafe-config`)})`,
    );
    const context = await createMCPServerContext(
      fixture.root,
      Object.create(null),
    );
    const gitRead = jest.spyOn(GitSnapshotReader.prototype, "read");

    const thrown = await handleToolCall(
      "review_documentation_impact",
      { base: fixture.base, head: fixture.head },
      context,
    ).catch((error: unknown) => error);

    expect(formatMCPError(thrown)).toBe(
      "MCP_UNSAFE_CONFIGURATION: The MCP project configuration cannot be loaded safely.",
    );
    expect(formatMCPError(thrown)).not.toContain(fixture.root);
    expect(gitRead).not.toHaveBeenCalled();
  });
});
