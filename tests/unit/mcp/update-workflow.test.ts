import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as providerRegistry from "../../../src/providers/registry";
import * as configLoader from "../../../src/config/loader";
import * as impactPlanner from "../../../src/impact/planner";
import { GitSnapshotReader } from "../../../src/git/snapshot";
import {
  createMCPServerContext,
  formatMCPError,
  handleToolCall,
  TOOLS,
} from "../../../src/mcp/server";
import {
  createMCPUpdateWorkflowContext,
  PREPARATION_STORE_CAPACITY,
  PreparationStore,
} from "../../../src/mcp/update-workflow";
import {
  MCP_PREPARATION_SCHEMA,
  PreparationTokenCodec,
  type PreparationClaims,
} from "../../../src/mcp/preparation-token";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixtureRepository(multipleTargets = false): {
  root: string;
  base: string;
  head: string;
} {
  const root = mkdtempSync(join(tmpdir(), "staledocs-mcp-update-"));
  mkdirSync(join(root, "src"));
  if (multipleTargets) mkdirSync(join(root, "docs"));
  git(root, "init", "-q", "--initial-branch", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "MCP Test");
  writeFileSync(join(root, "README.md"), "# API\n\nSee `greet`.\n");
  if (multipleTargets) {
    writeFileSync(join(root, "docs", "API.md"), "# API\n\nSee `greet`.\n");
  }
  writeFileSync(
    join(root, "src", "index.ts"),
    "export function greet(name: string): string { return name; }\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(
    join(root, "src", "index.ts"),
    "export function greet(name: number): number { return name; }\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "head");
  return { root, base, head: git(root, "rev-parse", "HEAD") };
}

function syntheticClaims(target: string): PreparationClaims {
  return {
    schemaVersion: MCP_PREPARATION_SCHEMA,
    planDigest: "0".repeat(64),
    maxContextBytes: 12000,
    target,
    targetDigest: "1".repeat(64),
  };
}

describe("preparation store", () => {
  it("evicts the oldest target once capacity is exceeded", () => {
    const store = new PreparationStore();
    const targets = Array.from(
      { length: PREPARATION_STORE_CAPACITY + 1 },
      (_, index) => `docs/${index}.md`,
    );
    for (const target of targets) {
      store.record(target, syntheticClaims(target), `token-${target}`);
    }

    expect(PREPARATION_STORE_CAPACITY).toBe(32);
    expect(store.latest(targets[0])).toBeUndefined();
    expect(store.latest(targets[1])?.token).toBe(`token-${targets[1]}`);
    expect(store.latest(targets[targets.length - 1])?.claims.target).toBe(
      targets[targets.length - 1],
    );
  });

  it("keeps one preparation per target and refreshes its position", () => {
    const store = new PreparationStore();
    store.record("README.md", syntheticClaims("README.md"), "first");
    for (let index = 1; index < PREPARATION_STORE_CAPACITY; index += 1) {
      store.record(
        `docs/${index}.md`,
        syntheticClaims(`docs/${index}.md`),
        "x",
      );
    }
    store.record("README.md", syntheticClaims("README.md"), "second");
    store.record("docs/new.md", syntheticClaims("docs/new.md"), "x");

    expect(store.latest("README.md")?.token).toBe("second");
    expect(store.latest("docs/1.md")).toBeUndefined();
    store.clear();
    expect(store.latest("README.md")).toBeUndefined();
  });
});

describe("validation by target", () => {
  const roots: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  async function serverFixture(multipleTargets = false) {
    const fixture = fixtureRepository(multipleTargets);
    roots.push(fixture.root);
    const context = await createMCPServerContext(
      fixture.root,
      Object.create(null),
    );
    return { ...fixture, context };
  }

  it("validates the latest server-side preparation without a digest", async () => {
    const { base, head, context } = await serverFixture();
    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base, head },
      context,
    )) as { target: string };

    const validated = (await handleToolCall(
      "validate_documentation_draft",
      { target: prepared.target, candidate_markdown: "# API\n\nUpdated.\n" },
      context,
    )) as { valid: boolean; target: string; approved_markdown?: string };

    expect(validated).toMatchObject({
      valid: true,
      target: "README.md",
      approved_markdown: "# API\n\nUpdated.\n",
    });
  });

  it("validates by target on the direct-call compatibility path", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head },
      fixture.root,
    );

    const validated = (await handleToolCall(
      "validate_documentation_draft",
      { target: "README.md", candidate_markdown: "# API\n\nUpdated.\n" },
      fixture.root,
    )) as { valid: boolean };

    expect(validated.valid).toBe(true);
  });

  it("rejects validation by target without a prior preparation", async () => {
    const { context } = await serverFixture();

    const thrown = await handleToolCall(
      "validate_documentation_draft",
      { target: "README.md", candidate_markdown: "# API\n" },
      context,
    ).catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: "MCP_INVALID_PREPARATION" });
  });

  it("keeps separate preparations for separate targets", async () => {
    const { root, base, head, context } = await serverFixture(true);
    writeFileSync(join(root, "docs", "API.md"), "# API\n\nSee `greet` here.\n");
    const readmeBytes = readFileSync(join(root, "README.md")).byteLength;
    const apiBytes = readFileSync(join(root, "docs", "API.md")).byteLength;
    await handleToolCall(
      "prepare_documentation_update",
      { base, head, target: "README.md" },
      context,
    );
    await handleToolCall(
      "prepare_documentation_update",
      { base, head, target: "docs/API.md" },
      context,
    );

    const readme = (await handleToolCall(
      "validate_documentation_draft",
      { target: "README.md", candidate_markdown: "# API\n" },
      context,
    )) as { valid: boolean; target: string; diff: { oldBytes: number } };
    const api = (await handleToolCall(
      "validate_documentation_draft",
      { target: "docs/API.md", candidate_markdown: "# API\n" },
      context,
    )) as { valid: boolean; target: string; diff: { oldBytes: number } };

    expect(readme).toMatchObject({
      valid: true,
      target: "README.md",
      diff: { oldBytes: readmeBytes },
    });
    expect(api).toMatchObject({
      valid: true,
      target: "docs/API.md",
      diff: { oldBytes: apiBytes },
    });
  });

  it("validates against the newest preparation for a target", async () => {
    const { root, base, head, context } = await serverFixture();
    await handleToolCall(
      "prepare_documentation_update",
      { base, head },
      context,
    );
    writeFileSync(join(root, "README.md"), "# API\n\nSee `greet` again.\n");
    await handleToolCall(
      "prepare_documentation_update",
      { base, head },
      context,
    );

    const validated = (await handleToolCall(
      "validate_documentation_draft",
      { target: "README.md", candidate_markdown: "# API\n" },
      context,
    )) as { valid: boolean };

    expect(validated.valid).toBe(true);
  });

  it("fails closed when the target changed after preparation", async () => {
    const { root, base, head, context } = await serverFixture();
    await handleToolCall(
      "prepare_documentation_update",
      { base, head },
      context,
    );
    writeFileSync(join(root, "README.md"), "# Changed\n");

    const thrown = await handleToolCall(
      "validate_documentation_draft",
      { target: "README.md", candidate_markdown: "# API\n" },
      context,
    ).catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: "MCP_INVALID_PREPARATION" });
  });

  it("does not let the store rescue a supplied wrong digest", async () => {
    const { base, head, context } = await serverFixture();
    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base, head },
      context,
    )) as { preparation_digest: string; target: string };

    const thrown = await handleToolCall(
      "validate_documentation_draft",
      {
        preparation_digest: `${prepared.preparation_digest.slice(0, -1)}x`,
        target: prepared.target,
        candidate_markdown: "# API\n",
      },
      context,
    ).catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: "MCP_INVALID_PREPARATION" });
  });

  it("rejects an empty supplied digest", async () => {
    const { base, head, context } = await serverFixture();
    await handleToolCall(
      "prepare_documentation_update",
      { base, head },
      context,
    );

    const thrown = await handleToolCall(
      "validate_documentation_draft",
      {
        preparation_digest: "",
        target: "README.md",
        candidate_markdown: "# API\n",
      },
      context,
    ).catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: "MCP_INVALID_PREPARATION" });
  });

  it("still accepts the exact digest returned by preparation", async () => {
    const { base, head, context } = await serverFixture();
    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base, head },
      context,
    )) as { preparation_digest: string; target: string };

    const validated = (await handleToolCall(
      "validate_documentation_draft",
      {
        preparation_digest: prepared.preparation_digest,
        target: prepared.target,
        candidate_markdown: "# API\n",
      },
      context,
    )) as { valid: boolean };

    expect(validated.valid).toBe(true);
  });

  it.each([
    { others: PREPARATION_STORE_CAPACITY - 1, valid: true },
    { others: PREPARATION_STORE_CAPACITY, valid: false },
  ])(
    "evicts a prepared target after $others newer targets: valid=$valid",
    async ({ others, valid }) => {
      const { base, head, context } = await serverFixture();
      await handleToolCall(
        "prepare_documentation_update",
        { base, head },
        context,
      );
      for (let index = 0; index < others; index += 1) {
        const target = `docs/${index}.md`;
        context.updateWorkflow.preparations.record(
          target,
          syntheticClaims(target),
          "unused",
        );
      }

      const result = await handleToolCall(
        "validate_documentation_draft",
        { target: "README.md", candidate_markdown: "# API\n" },
        context,
      ).catch((error: unknown) => error);

      if (valid) {
        expect(result).toMatchObject({ valid: true });
      } else {
        expect(result).toMatchObject({ code: "MCP_INVALID_PREPARATION" });
      }
    },
  );
});

describe("provider-free MCP update workflow", () => {
  const roots: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  it("advertises the exact non-mutating prepare and validate schemas", () => {
    const prepare = TOOLS.find(
      (tool) => tool.name === "prepare_documentation_update",
    );
    const validate = TOOLS.find(
      (tool) => tool.name === "validate_documentation_draft",
    );

    expect(prepare?.inputSchema).toEqual({
      type: "object",
      properties: {
        base: { type: "string" },
        head: { type: "string" },
        max_context_bytes: {
          type: "integer",
          minimum: 1024,
          maximum: 1048576,
        },
        target: { type: "string" },
      },
      additionalProperties: false,
    });
    expect(validate?.inputSchema).toEqual({
      type: "object",
      properties: {
        preparation_digest: { type: "string" },
        target: { type: "string" },
        candidate_markdown: { type: "string" },
      },
      required: ["target", "candidate_markdown"],
      additionalProperties: false,
    });
    expect(prepare?.inputSchema.properties).not.toHaveProperty("directory");
    expect(validate?.inputSchema.properties).not.toHaveProperty("output");
  });

  it("prepares and validates one target without providers or writes", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    const before = readFileSync(join(fixture.root, "README.md"));
    const createProvider = jest.spyOn(providerRegistry, "createProvider");
    const loadProviderConfig = jest.spyOn(configLoader, "loadProviderConfig");

    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head },
      fixture.root,
    )) as {
      schema_version: string;
      preparation_digest: string;
      target: string;
      generation: { system_prompt: string; prompt: string };
      context: { maxBytes: number };
      trust: { policy: string; action: string; findings: unknown[] };
    };

    expect(prepared.schema_version).toBe("aidoc.mcp-update-preparation.v1");
    expect(prepared.target).toBe("README.md");
    expect(prepared.preparation_digest).toMatch(/^v1\./u);
    expect(prepared.generation.prompt).toContain("# API");
    expect(prepared.generation.prompt).not.toContain(fixture.root);
    expect(prepared.context.maxBytes).toBeGreaterThanOrEqual(1024);
    expect(prepared.trust).toEqual({
      policy: "redact",
      action: "allowed",
      findings: [],
    });

    const validated = (await handleToolCall(
      "validate_documentation_draft",
      {
        preparation_digest: prepared.preparation_digest,
        target: prepared.target,
        candidate_markdown: "# API\n\nUpdated.\n",
      },
      fixture.root,
    )) as {
      schema_version: string;
      valid: boolean;
      target: string;
      approved_markdown?: string;
      markdown_warnings: string[];
      diff: { changed: boolean; addedLines: number; removedLines: number };
    };

    expect(validated).toEqual({
      schema_version: "aidoc.mcp-draft-validation.v1",
      valid: true,
      target: "README.md",
      approved_markdown: "# API\n\nUpdated.\n",
      markdown_warnings: [],
      diff: {
        changed: true,
        addedLines: 1,
        removedLines: 1,
        oldBytes: before.byteLength,
        newBytes: Buffer.byteLength("# API\n\nUpdated.\n"),
      },
      trust: {
        policy: "redact",
        action: "allowed",
        findings: [],
      },
    });
    expect(readFileSync(join(fixture.root, "README.md"))).toEqual(before);
    expect(createProvider).not.toHaveBeenCalled();
    expect(loadProviderConfig).not.toHaveBeenCalled();
  });

  it("refreshes safe planning configuration for validation", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    writeFileSync(
      join(fixture.root, ".staledocsrc.json"),
      JSON.stringify({ include: ["**/*.ts"] }),
    );
    const context = await createMCPServerContext(
      fixture.root,
      Object.create(null),
    );
    const loadPlanning = jest.spyOn(context.configLoader, "loadPlanning");

    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head, target: "README.md" },
      context,
    )) as { preparation_digest: string; target: string };

    writeFileSync(
      join(fixture.root, ".staledocsrc.json"),
      JSON.stringify({ include: ["**/*.tsx"] }),
    );

    const thrown = await handleToolCall(
      "validate_documentation_draft",
      {
        preparation_digest: prepared.preparation_digest,
        target: prepared.target,
        candidate_markdown: "# API\n",
      },
      context,
    ).catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: "MCP_INVALID_PREPARATION" });
    expect(loadPlanning).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe configuration before Git or AST planning", async () => {
    const fixture = fixtureRepository();
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
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head, target: "README.md" },
      context,
    ).catch((error: unknown) => error);

    expect(formatMCPError(thrown)).toBe(
      "MCP_UNSAFE_CONFIGURATION: The MCP project configuration cannot be loaded safely.",
    );
    expect(formatMCPError(thrown)).not.toContain(fixture.root);
    expect(gitRead).not.toHaveBeenCalled();
  });

  it("rejects a symlinked configuration before Git or AST planning", async () => {
    const fixture = fixtureRepository();
    const outside = mkdtempSync(join(tmpdir(), "staledocs-mcp-unsafe-config-"));
    roots.push(fixture.root, outside);
    writeFileSync(
      join(outside, "config.json"),
      JSON.stringify({ include: ["**/*.ts"] }),
    );
    symlinkSync(
      join(outside, "config.json"),
      join(fixture.root, ".staledocsrc.json"),
    );
    const context = await createMCPServerContext(
      fixture.root,
      Object.create(null),
    );
    const gitRead = jest.spyOn(GitSnapshotReader.prototype, "read");

    const thrown = await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head, target: "README.md" },
      context,
    ).catch((error: unknown) => error);

    expect(formatMCPError(thrown)).toBe(
      "MCP_UNSAFE_CONFIGURATION: The MCP project configuration cannot be loaded safely.",
    );
    expect(gitRead).not.toHaveBeenCalled();
  });

  it("rejects a modified preparation with a fixed safe error", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head },
      fixture.root,
    )) as { preparation_digest: string; target: string };

    await expect(
      handleToolCall(
        "validate_documentation_draft",
        {
          preparation_digest: `${prepared.preparation_digest.slice(0, -1)}x`,
          target: prepared.target,
          candidate_markdown: "# API\n",
        },
        fixture.root,
      ),
    ).rejects.toMatchObject({ code: "MCP_INVALID_PREPARATION" });
    expect(formatMCPError({ code: "MCP_INVALID_PREPARATION" })).toBe(
      "Unknown MCP error.",
    );
  });

  it("requires an explicit target when multiple safe candidates exist", async () => {
    const fixture = fixtureRepository(true);
    roots.push(fixture.root);

    const thrown = await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head },
      fixture.root,
    ).catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      code: "MCP_TARGET_REQUIRED",
      candidates: ["README.md", "docs/API.md"],
    });
    expect(formatMCPError(thrown)).toBe(
      "MCP_TARGET_REQUIRED: Select one existing Markdown target: README.md, docs/API.md.",
    );
    expect(formatMCPError(thrown)).not.toContain(fixture.root);
  });

  it("rejects extra fields and hostile accessors before planning", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    const planner = jest.spyOn(impactPlanner, "createImpactPlan");
    const extra = await handleToolCall(
      "prepare_documentation_update",
      { directory: "/tmp/not-the-repository" },
      fixture.root,
    ).catch((error: unknown) => error);
    expect(extra).toMatchObject({ code: "MCP_INVALID_PREPARATION" });

    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "target", {
      enumerable: true,
      get: () => {
        throw new Error("hostile target sentinel");
      },
    });
    const hostileResult = await handleToolCall(
      "prepare_documentation_update",
      hostile,
      fixture.root,
    ).catch((error: unknown) => error);
    expect(hostileResult).toMatchObject({ code: "MCP_INVALID_PREPARATION" });
    expect(formatMCPError(hostileResult)).not.toContain("sentinel");
    expect(planner).not.toHaveBeenCalled();
  });

  it("redacts existing and candidate secrets without provider access", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    const secret = ["sk", "proj", "R".repeat(32)].join("-");
    writeFileSync(join(fixture.root, "README.md"), `# API\n\n${secret}\n`);
    const context = createMCPUpdateWorkflowContext(
      fixture.root,
      new PreparationTokenCodec(new Uint8Array(32).fill(8)),
      "redact",
    );

    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head },
      fixture.root,
      context,
    )) as {
      preparation_digest: string;
      target: string;
      generation: { prompt: string };
      trust: { action: string };
    };
    expect(prepared.generation.prompt).not.toContain(secret);
    expect(prepared.trust.action).toBe("redacted");

    const validated = (await handleToolCall(
      "validate_documentation_draft",
      {
        preparation_digest: prepared.preparation_digest,
        target: prepared.target,
        candidate_markdown: `# API\n\n${secret}\n`,
      },
      fixture.root,
      context,
    )) as {
      valid: boolean;
      approved_markdown?: string;
      trust: { action: string };
    };
    expect(validated.valid).toBe(true);
    expect(validated.approved_markdown).not.toContain(secret);
    expect(validated.trust.action).toBe("redacted");
  });

  it.each(["warn", "redact"] as const)(
    "applies the preparation privacy floor under %s policy to every provider credential assignment",
    async (trustPolicy) => {
      const fixture = fixtureRepository();
      roots.push(fixture.root);
      const values = {
        OPENAI_API_KEY: "arbitrary-openai-value",
        ANTHROPIC_API_KEY: "arbitrary-anthropic-value",
        DEEPSEEK_API_KEY: "arbitrary-deepseek-value",
        DASHSCOPE_API_KEY: "arbitrary-dashscope-value",
        STALEDOCS_COMPAT_API_KEY: "arbitrary-compatible-value",
      };
      const input = Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
      writeFileSync(join(fixture.root, "README.md"), `# API\n\n${input}\n`);
      const context = createMCPUpdateWorkflowContext(
        fixture.root,
        new PreparationTokenCodec(new Uint8Array(32).fill(10)),
        trustPolicy,
      );

      const prepared = (await handleToolCall(
        "prepare_documentation_update",
        { base: fixture.base, head: fixture.head },
        fixture.root,
        context,
      )) as {
        generation: { system_prompt: string; prompt: string };
        trust: { policy: string; action: string; findings: unknown[] };
      };

      const returned = `${prepared.generation.system_prompt}\n${prepared.generation.prompt}`;
      for (const value of Object.values(values)) {
        expect(returned).not.toContain(value);
      }
      expect(prepared.trust).toEqual({
        policy: trustPolicy,
        action: "redacted",
        findings: [{ kind: "named_secret", count: 5 }],
      });
    },
  );

  it("keeps the preparation privacy floor while preserving safe path examples", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    const paths = [
      fixture.root,
      "/Users/alice/private/project/README.md",
      "/home/alice/private/project/README.md",
      "C:\\Users\\alice\\private\\project\\README.md",
    ];
    writeFileSync(
      join(fixture.root, "README.md"),
      ["# API", ...paths, "https://example.com/api/v1", "docs/API.md", ""].join(
        "\n",
      ),
    );
    const context = createMCPUpdateWorkflowContext(
      fixture.root,
      new PreparationTokenCodec(new Uint8Array(32).fill(11)),
      "warn",
    );

    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head },
      fixture.root,
      context,
    )) as {
      generation: { system_prompt: string; prompt: string };
      trust: { policy: string; action: string; findings: unknown[] };
    };
    const returned = `${prepared.generation.system_prompt}\n${prepared.generation.prompt}`;

    for (const path of paths) {
      expect(returned).not.toContain(path);
    }
    expect(returned).toContain("https://example.com/api/v1");
    expect(returned).toContain("docs/API.md");
    expect(prepared.trust).toEqual({
      policy: "warn",
      action: "redacted",
      findings: [{ kind: "sensitive_path", count: 4 }],
    });
  });

  it("blocks a secret in an existing target under strict policy", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    const secret = ["sk", "proj", "S".repeat(32)].join("-");
    writeFileSync(join(fixture.root, "README.md"), `# API\n\n${secret}\n`);
    const context = createMCPUpdateWorkflowContext(
      fixture.root,
      new PreparationTokenCodec(new Uint8Array(32).fill(9)),
      "strict",
    );

    await expect(
      handleToolCall(
        "prepare_documentation_update",
        { base: fixture.base, head: fixture.head },
        fixture.root,
        context,
      ),
    ).rejects.toMatchObject({ code: "TRUST_SECRET_BLOCKED" });
  });

  it("blocks every provider credential assignment under strict policy", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    writeFileSync(
      join(fixture.root, "README.md"),
      [
        "# API",
        "OPENAI_API_KEY=arbitrary-openai-value",
        "ANTHROPIC_API_KEY=arbitrary-anthropic-value",
        "DEEPSEEK_API_KEY=arbitrary-deepseek-value",
        "DASHSCOPE_API_KEY=arbitrary-dashscope-value",
        "STALEDOCS_COMPAT_API_KEY=arbitrary-compatible-value",
        "",
      ].join("\n"),
    );
    const context = createMCPUpdateWorkflowContext(
      fixture.root,
      new PreparationTokenCodec(new Uint8Array(32).fill(12)),
      "strict",
    );

    await expect(
      handleToolCall(
        "prepare_documentation_update",
        { base: fixture.base, head: fixture.head },
        fixture.root,
        context,
      ),
    ).rejects.toMatchObject({ code: "TRUST_SECRET_BLOCKED" });
  });

  it("returns warnings without approved content for invalid Markdown", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head },
      fixture.root,
    )) as { preparation_digest: string; target: string };

    const result = (await handleToolCall(
      "validate_documentation_draft",
      {
        preparation_digest: prepared.preparation_digest,
        target: prepared.target,
        candidate_markdown: "plain text without a heading",
      },
      fixture.root,
    )) as {
      valid: boolean;
      approved_markdown?: string;
      markdown_warnings: string[];
    };
    expect(result.valid).toBe(false);
    expect(result.approved_markdown).toBeUndefined();
    expect(result.markdown_warnings).toEqual([
      "Markdown does not start with a heading",
    ]);
  });

  it("rejects changed target snapshots and symlink swaps", async () => {
    const fixture = fixtureRepository();
    roots.push(fixture.root);
    const prepared = (await handleToolCall(
      "prepare_documentation_update",
      { base: fixture.base, head: fixture.head },
      fixture.root,
    )) as { preparation_digest: string; target: string };
    writeFileSync(join(fixture.root, "README.md"), "# Changed\n");
    await expect(
      handleToolCall(
        "validate_documentation_draft",
        {
          preparation_digest: prepared.preparation_digest,
          target: prepared.target,
          candidate_markdown: "# API\n",
        },
        fixture.root,
      ),
    ).rejects.toMatchObject({ code: "MCP_INVALID_PREPARATION" });

    writeFileSync(join(fixture.root, "README.md"), "# API\n");
    rmSync(join(fixture.root, "README.md"));
    symlinkSync(
      join(fixture.root, "src", "index.ts"),
      join(fixture.root, "README.md"),
    );
    await expect(
      handleToolCall(
        "validate_documentation_draft",
        {
          preparation_digest: prepared.preparation_digest,
          target: prepared.target,
          candidate_markdown: "# API\n",
        },
        fixture.root,
      ),
    ).rejects.toMatchObject({ code: "MCP_INVALID_PREPARATION" });
  });
});
