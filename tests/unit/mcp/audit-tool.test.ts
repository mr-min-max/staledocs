import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMCPServer,
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

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staledocs-mcp-audit-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "staledocs test");
  git(root, "config", "user.email", "staledocs-test@example.invalid");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"name":"lib","scripts":{"build":"tsc"}}\n',
  );
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(
    path.join(root, "README.md"),
    "# Lib\n\n## Usage\n\nRun `npm run bulid` and read `src/old.ts`.\n",
  );
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n\nRun `npm test`.\n");
  git(root, "add", ".");
  git(root, "-c", "commit.gpgSign=false", "commit", "-qm", "fixture");
  return root;
}

type Report = {
  schema_version: string;
  summary: { findings: number; files: number };
  findings: { file: string; kind: string; value: string }[];
};

function rows(report: Report): string[][] {
  return report.findings.map(({ file, kind, value }) => [file, kind, value]);
}

describe("audit_documentation MCP tool", () => {
  let root: string;
  beforeEach(() => {
    root = fixture();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is advertised as a read-only tool with an optional paths list", () => {
    const tool = TOOLS.find((candidate) => candidate.name === "audit_documentation");
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    });
    expect(tool?.inputSchema.required).toBeUndefined();
  });

  it("audits the repository where the server started", async () => {
    const report = (await handleToolCall("audit_documentation", {}, root)) as Report;
    expect(report.schema_version).toBe("aidoc.audit.v1");
    expect(rows(report)).toEqual([
      ["AGENTS.md", "script-missing", "npm test"],
      ["README.md", "path-missing", "src/old.ts"],
      ["README.md", "script-missing", "npm run bulid"],
    ]);
  });

  it("limits the audit to named paths after the scope accepts them", async () => {
    const report = (await handleToolCall(
      "audit_documentation",
      { paths: ["./AGENTS.md"] },
      root,
    )) as Report;
    expect(rows(report)).toEqual([["AGENTS.md", "script-missing", "npm test"]]);
    expect(report.summary.files).toBe(1);
  });

  it.each([
    ["a parent traversal", { paths: ["../outside.md"] }],
    ["an absolute path outside the repository", { paths: ["/etc/outside.md"] }],
    ["a non-Markdown file", { paths: ["src/index.ts"] }],
    ["a string instead of a list", { paths: "README.md" }],
    ["an empty list", { paths: [] }],
    ["a non-string entry", { paths: [42] }],
    ["too many entries", { paths: Array.from({ length: 65 }, () => "README.md") }],
    ["an unknown argument", { directory: "." }],
  ])("rejects %s with MCP_INVALID_PATH_INPUT", async (_label, args) => {
    await expect(handleToolCall("audit_documentation", args, root)).rejects.toMatchObject({
      code: "MCP_INVALID_PATH_INPUT",
    });
  });

  it("returns the same report as text and structuredContent", async () => {
    const server = await createMCPServer(root);
    const client = new Client({ name: "audit-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const result = await client.callTool({ name: "audit_documentation", arguments: {} });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      expect(result.structuredContent).toEqual(JSON.parse(content[0]!.text));
      expect(rows(result.structuredContent as Report)).toHaveLength(3);
      expect(content[0]!.text).not.toContain(fs.realpathSync(root));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
