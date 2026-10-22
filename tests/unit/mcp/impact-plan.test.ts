import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as commandContext from "../../../src/cli/context";
import { executePlanCommand } from "../../../src/cli/commands/plan";
import * as configLoader from "../../../src/config/loader";
import * as planningConfig from "../../../src/config/planning";
import * as templates from "../../../src/core/templates";
import * as impactPlanner from "../../../src/impact/planner";
import type {
  ImpactPlan,
  ImpactProviderContext,
} from "../../../src/impact/types";
import { PlanFailure } from "../../../src/impact/types";
import {
  createMCPServerContext,
  formatMCPError,
  handleToolCall,
  TOOLS,
} from "../../../src/mcp/server";
import { MCPRepositoryReadScope } from "../../../src/mcp/repository-scope";
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

function immutableRepository(): {
  root: string;
  outside: string;
  base: string;
  head: string;
} {
  const root = mkdtempSync(join(tmpdir(), "staledocs-mcp-plan-"));
  const outside = mkdtempSync(join(tmpdir(), "staledocs-mcp-outside-"));
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  git(root, "init", "-q", "--initial-branch", "main");
  git(root, "config", "core.hooksPath", hooks);
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "MCP Test");
  writeFileSync(
    join(root, "api.ts"),
    "export function greet(name: string): string { return name; }\n",
  );
  writeFileSync(join(root, "README.md"), "# API\n\n`greet`\n");
  const base = commit(root, "fixture: base");
  writeFileSync(
    join(root, "api.ts"),
    "export function greet(name: number): number { return name; }\n",
  );
  const head = commit(root, "fixture: head");
  return { root, outside, base, head };
}

describe("MCP impact planning", () => {
  const roots: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Break caught: the MCP contract accepts arbitrary directories or drifts
  // from the approved CLI planning options and byte-budget bounds.
  it("advertises the exact repository-scoped planning schema", () => {
    const tool = TOOLS.find(
      (candidate) => candidate.name === "plan_documentation_impact",
    );

    expect(tool).toEqual({
      name: "plan_documentation_impact",
      description:
        "Plan deterministic documentation impact for the repository where this MCP server started.",
      inputSchema: {
        type: "object",
        properties: {
          base: {
            type: "string",
            description: "Explicit comparison base Git ref",
          },
          head: {
            type: "string",
            description: "Compare two committed Git refs",
          },
          max_context_bytes: {
            type: "integer",
            minimum: 1024,
            maximum: 1048576,
            description: "Provider-context byte ceiling",
          },
        },
        additionalProperties: false,
      },
      outputSchema: expect.objectContaining({ type: "object" }),
    });
    expect(tool?.inputSchema.properties).not.toHaveProperty("directory");
  });

  // Break caught: snake-case MCP options are forwarded under the wrong names,
  // provider-only context escapes, or an injected directory expands scope.
  it("maps options to the shared planner and returns exactly its public plan", async () => {
    const fixture = immutableRepository();
    roots.push(fixture.root, fixture.outside);
    const context = await createMCPServerContext(
      fixture.root,
      Object.create(null),
    );
    const plan = Object.freeze({
      schemaVersion: "aidoc.impact-plan.v1",
      digest: "0".repeat(64),
    }) as unknown as ImpactPlan;
    const planner = jest
      .spyOn(impactPlanner, "createImpactPlan")
      .mockResolvedValue({
        plan,
        providerContext: {} as ImpactProviderContext,
        suppressed: [],
      });

    const result = await handleToolCall(
      "plan_documentation_impact",
      {
        base: fixture.base,
        head: fixture.head,
        max_context_bytes: 4096,
        directory: "/tmp/not-the-server-repository",
      },
      context,
    );

    expect(result).toBe(plan);
    expect(planner).toHaveBeenCalledWith({
      cwd: fixture.root,
      base: fixture.base,
      head: fixture.head,
      maxContextBytes: 4096,
      planningConfig: expect.objectContaining({
        include: expect.any(Array),
        exclude: expect.any(Array),
        outputDir: expect.any(String),
        maxContextBytes: expect.any(Number),
      }),
      suppressions: { symbols: [], sourcePaths: [], docPaths: [] },
    });
  });

  it("loads planning through one pinned server context before planning", async () => {
    const fixture = immutableRepository();
    roots.push(fixture.root, fixture.outside);
    const context = await createMCPServerContext(
      fixture.root,
      Object.create(null),
    );
    const ordinaryLoader = jest.spyOn(planningConfig, "loadPlanningConfig");
    const loadPlanning = jest.spyOn(context.configLoader, "loadPlanning");
    const plan = Object.freeze({
      schemaVersion: "aidoc.impact-plan.v1",
      digest: "1".repeat(64),
    }) as unknown as ImpactPlan;
    const planner = jest
      .spyOn(impactPlanner, "createImpactPlan")
      .mockResolvedValue({
        plan,
        providerContext: {} as ImpactProviderContext,
        suppressed: [],
      });

    const result = await handleToolCall(
      "plan_documentation_impact",
      {
        base: fixture.base,
        head: fixture.head,
        max_context_bytes: 4096,
      },
      context,
    );

    expect(result).toBe(plan);
    expect(context.serverCwd).toBe(fixture.root);
    expect(context.updateWorkflow.serverCwd).toBe(fixture.root);
    expect(context.updateWorkflow.loadPlanningConfig).toEqual(
      expect.any(Function),
    );
    expect(loadPlanning).toHaveBeenCalledTimes(1);
    expect(ordinaryLoader).not.toHaveBeenCalled();
    expect(loadPlanning).toHaveBeenCalledWith(context.scope.rootDirectory());
    expect(planner).toHaveBeenCalledWith({
      cwd: fixture.root,
      base: fixture.base,
      head: fixture.head,
      maxContextBytes: 4096,
      planningConfig: expect.objectContaining({
        include: expect.any(Array),
        exclude: expect.any(Array),
        outputDir: expect.any(String),
        maxContextBytes: expect.any(Number),
      }),
      suppressions: { symbols: [], sourcePaths: [], docPaths: [] },
    });
  });

  it("reads and applies root .staledocsignore through the pinned MCP scope", async () => {
    const fixture = immutableRepository();
    roots.push(fixture.root, fixture.outside);
    writeFileSync(join(fixture.root, ".staledocsignore"), "greet\n");
    writeFileSync(join(fixture.outside, ".staledocsignore"), "Other.*\n");
    const context = await createMCPServerContext(
      fixture.root,
      Object.create(null),
    );
    const readOptionalFile = jest.spyOn(context.scope, "readOptionalFile");

    const result = (await handleToolCall(
      "plan_documentation_impact",
      { base: fixture.base, head: fixture.head },
      context,
    )) as ImpactPlan;

    expect(result.changes).toEqual([]);
    expect(result.documentation).toEqual([]);
    expect(result.ignored.suppressed).toBe(1);
    expect(readOptionalFile).toHaveBeenCalledWith(
      context.scope.rootDirectory(),
      ".staledocsignore",
      { maxBytes: 256 * 1024 },
    );
  });

  it("reuses the context-owned scope and loader across provider-free calls", async () => {
    const fixture = immutableRepository();
    roots.push(fixture.root, fixture.outside);
    const context = await createMCPServerContext(
      fixture.root,
      Object.create(null),
    );
    const openScope = jest.spyOn(MCPRepositoryReadScope, "open");
    const loadPlanning = jest.spyOn(context.configLoader, "loadPlanning");
    const codec = context.updateWorkflow.tokenCodec;

    await handleToolCall(
      "plan_documentation_impact",
      { base: fixture.base, head: fixture.head },
      context,
    );
    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head, target: "README.md" },
      context,
    )) as { preparation_digest: string; target: string };

    expect(openScope).not.toHaveBeenCalled();
    expect(loadPlanning).toHaveBeenCalledTimes(2);
    expect(context.updateWorkflow.tokenCodec).toBe(codec);
    expect(prepared.target).toBe("README.md");
  });

  // Break caught: TypeScript assertions let invalid protocol scalars reach the
  // planner and surface incidental JS/config errors instead of fixed failures.
  it.each([
    {
      label: "non-string base",
      args: { base: 17 },
      error: {
        code: "PLAN_INVALID_REF",
        message: "The Git reference is invalid.",
      },
    },
    {
      label: "non-string head",
      args: { head: false },
      error: {
        code: "PLAN_INVALID_REF",
        message: "The Git reference is invalid.",
      },
    },
    {
      label: "non-integer context budget",
      args: { max_context_bytes: 4096.5 },
      error: {
        code: "PLAN_INVALID_CONTEXT_BUDGET",
        message: "The provider context byte budget is invalid.",
      },
    },
  ])("rejects $label before planning", async ({ args, error }) => {
    const planner = jest.spyOn(impactPlanner, "createImpactPlan");

    const thrown = await handleToolCall(
      "plan_documentation_impact",
      args,
      "/srv/locked-repository",
    ).catch((value: unknown) => value);

    expect(PlanFailure.read(thrown)).toEqual(error);
    expect(formatMCPError(thrown)).toBe(`${error.code}: ${error.message}`);
    expect(planner).not.toHaveBeenCalled();
  });

  // Break caught: direct property access invokes hostile accessors before the
  // MCP boundary can create an authentic, safely formatted PlanFailure.
  it.each([
    {
      key: "base",
      error: {
        code: "PLAN_INVALID_REF",
        message: "The Git reference is invalid.",
      },
    },
    {
      key: "head",
      error: {
        code: "PLAN_INVALID_REF",
        message: "The Git reference is invalid.",
      },
    },
    {
      key: "max_context_bytes",
      error: {
        code: "PLAN_INVALID_CONTEXT_BUDGET",
        message: "The provider context byte budget is invalid.",
      },
    },
  ])("fails closed for a hostile $key getter", async ({ key, error }) => {
    const args = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(args, key, {
      enumerable: true,
      get: () => {
        throw new Error("hostile MCP argument getter sentinel");
      },
    });
    const planner = jest.spyOn(impactPlanner, "createImpactPlan");

    const thrown = await handleToolCall(
      "plan_documentation_impact",
      args,
      "/srv/locked-repository",
    ).catch((value: unknown) => value);

    expect(PlanFailure.read(thrown)).toEqual(error);
    expect(formatMCPError(thrown)).toBe(`${error.code}: ${error.message}`);
    expect(formatMCPError(thrown)).not.toContain("sentinel");
    expect(planner).not.toHaveBeenCalled();
  });

  // Break caught: CLI and MCP grow separate comparison logic, planning loads
  // provider state, or MCP honors an extra directory supplied by a caller.
  it("matches CLI JSON for immutable snapshots without provider bootstrap", async () => {
    const fixture = immutableRepository();
    roots.push(fixture.root, fixture.outside);
    const loadConfig = jest.spyOn(configLoader, "loadConfig");
    const loadProviderConfig = jest.spyOn(configLoader, "loadProviderConfig");
    const loadContext = jest.spyOn(commandContext, "loadCommandContext");
    const resolveTemplates = jest.spyOn(templates, "resolveTemplatesDir");
    const createProvider = jest.spyOn(providerRegistry, "createProvider");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executePlanCommand(
      { base: fixture.base, head: fixture.head, json: true },
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
      fixture.root,
    );
    const mcpPlan = await handleToolCall(
      "plan_documentation_impact",
      {
        base: fixture.base,
        head: fixture.head,
        directory: fixture.outside,
      },
      fixture.root,
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(mcpPlan).toEqual(JSON.parse(stdout[0]).plan);
    expect((mcpPlan as ImpactPlan).base).toEqual(
      expect.objectContaining({ commit: fixture.base }),
    );
    expect(loadConfig).not.toHaveBeenCalled();
    expect(loadProviderConfig).not.toHaveBeenCalled();
    expect(loadContext).not.toHaveBeenCalled();
    expect(resolveTemplates).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
  });

  // Break caught: stable planning failures lose their allowlisted code or
  // include raw source/path details in the protocol diagnostic.
  it("formats parse failures with a fixed allowlisted diagnostic", async () => {
    const fixture = immutableRepository();
    roots.push(fixture.root, fixture.outside);
    writeFileSync(join(fixture.root, "broken.py"), "def broken(:\n");
    const brokenHead = commit(fixture.root, "fixture: broken source");

    let thrown: unknown;
    try {
      await handleToolCall(
        "plan_documentation_impact",
        { base: fixture.head, head: brokenHead },
        fixture.root,
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(formatMCPError(thrown)).toBe(
      "PLAN_PARSE_FAILED: Unable to parse changed source.",
    );
    expect(formatMCPError(thrown)).not.toContain(fixture.root);
    expect(formatMCPError(thrown)).not.toContain("def broken");
  });

  // Break caught: a mutated or forged allowlisted plan error can substitute an
  // attacker-controlled message at the MCP protocol boundary.
  it("uses only the original fixed payload from authentic plan failures", () => {
    const failure = new PlanFailure(
      "PLAN_PARSE_FAILED",
      "Unable to parse changed source.",
    );
    failure.message = "raw source sentinel from a mutated error";

    expect(formatMCPError(failure)).toBe(
      "PLAN_PARSE_FAILED: Unable to parse changed source.",
    );
    expect(
      formatMCPError({
        code: "PLAN_PARSE_FAILED",
        message: "forged raw source sentinel",
      }),
    ).toBe("Unknown MCP error.");
  });

  // Break caught: protocol error handling touches hostile getters and leaks
  // their values instead of failing closed.
  it("fails closed for hostile error getters", () => {
    const hostile = Object.create(null, {
      message: {
        get: () => {
          throw new Error("secret message getter");
        },
      },
      code: {
        get: () => {
          throw new Error("secret code getter");
        },
      },
    });

    expect(formatMCPError(hostile)).toBe("Unknown MCP error.");
  });
});
