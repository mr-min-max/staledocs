import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { registerProvider } from "../../../src/providers/registry";
import {
  createMCPServer,
  createMCPServerContext,
  handleToolCall,
  TOOLS,
} from "../../../src/mcp/server";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function snapshotFixture(root: string): Array<{ file: string; hash: string }> {
  const files: Array<{ file: string; hash: string }> = [];

  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({
        file: path.relative(root, absolutePath),
        hash: createHash("sha256")
          .update(fs.readFileSync(absolutePath))
          .digest("hex"),
      });
    }
  }

  visit(root);
  return files.sort((left, right) => left.file.localeCompare(right.file));
}

describe("MCP provider output serialization", () => {
  it("rejects a registered provider object before MCP can serialize it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "staledocs-mcp-object-"));
    const providerName = `object-mcp-provider-${Date.now()}`;
    const fakeSecret = ["sk", "proj", "S".repeat(32)].join("-");
    let serializationCalls = 0;
    const unsafeOutput = {
      toString: () => "# harmless",
      toJSON: () => {
        serializationCalls += 1;
        return fakeSecret;
      },
    };

    registerProvider({
      name: providerName,
      available: () => true,
      create: () => ({
        name: providerName,
        generate: async () => unsafeOutput as unknown as string,
      }),
    });
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, ".staledocsrc.json"),
      JSON.stringify({ provider: providerName, trustPolicy: "redact" }),
    );
    fs.writeFileSync(
      path.join(root, "src", "index.ts"),
      "export function documented(): string { return 'safe'; }\n",
    );
    git(root, "init", "--quiet");
    git(root, "config", "user.name", "staledocs test");
    git(root, "config", "user.email", "staledocs-test@example.invalid");
    git(root, "add", ".");
    git(root, "-c", "commit.gpgSign=false", "commit", "-m", "fixture");

    try {
      const context = await createMCPServerContext(root, Object.create(null));
      await expect(
        handleToolCall("generate_readme", { directory: root }, context),
      ).rejects.toMatchObject({ code: "TRUST_INVALID_PROVIDER_OUTPUT" });
      expect(serializationCalls).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates content without mutating the fixture tree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "staledocs-mcp-readonly-"));
    const providerName = `readonly-mcp-provider-${Date.now()}`;
    registerProvider({
      name: providerName,
      available: () => true,
      create: () => ({
        name: providerName,
        generate: async () => "# Generated content\n",
      }),
    });
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, ".staledocsrc.json"),
      JSON.stringify({ provider: providerName, trustPolicy: "strict" }),
    );
    fs.writeFileSync(
      path.join(root, "src", "index.ts"),
      "export function documented(): string { return 'safe'; }\n",
    );
    git(root, "init", "--quiet");
    git(root, "config", "user.name", "staledocs test");
    git(root, "config", "user.email", "staledocs-test@example.invalid");
    git(root, "add", ".");
    git(root, "-c", "commit.gpgSign=false", "commit", "-m", "fixture");

    try {
      const context = await createMCPServerContext(root, Object.create(null));
      const before = snapshotFixture(root);
      await expect(
        handleToolCall("generate_readme", { directory: root }, context),
      ).resolves.toEqual({
        content: "# Generated content\n",
        format: "markdown",
      });
      await expect(
        handleToolCall("generate_api_docs", { directory: root }, context),
      ).resolves.toEqual({
        content: "# Generated content\n",
        format: "markdown",
      });
      await expect(
        handleToolCall("generate_diagram", { directory: root }, context),
      ).resolves.toEqual({
        content: "# Generated content\n",
        format: "mermaid",
      });
      expect(snapshotFixture(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("MCP structured results", () => {
  it("declares an output schema for every tool", () => {
    expect(
      TOOLS.filter((tool) => tool.outputSchema === undefined).map(
        (tool) => tool.name,
      ),
    ).toEqual([]);
  });

  it("returns structuredContent equal to the text payload for every tool", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "staledocs-mcp-structured-"),
    );
    const providerName = `structured-mcp-provider-${Date.now()}`;
    registerProvider({
      name: providerName,
      available: () => true,
      create: () => ({
        name: providerName,
        generate: async () => "# Generated content\n",
      }),
    });
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, ".staledocsrc.json"),
      JSON.stringify({ provider: providerName, trustPolicy: "redact" }),
    );
    fs.writeFileSync(
      path.join(root, "README.md"),
      "# API\n\n## Usage\n\nCall `greet` with a name.\n",
    );
    fs.writeFileSync(
      path.join(root, "src", "index.ts"),
      "export function greet(name: string): string { return name; }\n",
    );
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.name", "staledocs test");
    git(root, "config", "user.email", "staledocs-test@example.invalid");
    git(root, "add", ".");
    git(root, "-c", "commit.gpgSign=false", "commit", "-qm", "base");
    const base = git(root, "rev-parse", "HEAD");
    fs.writeFileSync(
      path.join(root, "src", "index.ts"),
      "export function greet(name: string, loud: boolean): string { return name; }\n",
    );
    git(root, "-c", "commit.gpgSign=false", "commit", "-qam", "head");
    const head = git(root, "rev-parse", "HEAD");

    const calls: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["analyze_codebase", { directory: "." }],
      ["generate_readme", { directory: "." }],
      ["generate_api_docs", { directory: "." }],
      ["generate_diagram", { directory: "." }],
      [
        "check_docs_freshness",
        { directory: ".", doc_file: "README.md", since: base },
      ],
      ["plan_documentation_impact", { base, head }],
      ["prepare_documentation_update", { base, head }],
      [
        "validate_documentation_draft",
        { target: "README.md", candidate_markdown: "# API\n\nUpdated.\n" },
      ],
      ["review_documentation_impact", { base, head }],
    ];
    const server = await createMCPServer(root, Object.create(null));
    const client = new Client({ name: "structured-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const validator = new AjvJsonSchemaValidator();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        calls.map(([name]) => name).sort(),
      );

      for (const [name, args] of calls) {
        const tool = tools.find((candidate) => candidate.name === name);
        const result = await client.callTool({ name, arguments: args });
        const content = result.content as Array<{ type: string; text?: string }>;

        expect({ name, isError: result.isError ?? false }).toEqual({
          name,
          isError: false,
        });
        expect(content).toHaveLength(1);
        expect(result.structuredContent).toEqual(JSON.parse(content[0].text ?? ""));
        const verdict = validator.getValidator(
          tool?.outputSchema as Parameters<typeof validator.getValidator>[0],
        )(result.structuredContent);
        expect({ name, error: verdict.errorMessage }).toEqual({
          name,
          error: undefined,
        });
      }
    } finally {
      await client.close();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
