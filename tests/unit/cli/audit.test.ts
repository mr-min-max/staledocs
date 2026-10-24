import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAuditCommand } from "../../../src/cli/commands/audit";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "staledocs-audit-cli-"));
  git(root, "init", "-q", "--initial-branch", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  write(
    root,
    "package.json",
    '{"name":"lib","scripts":{"build":"tsc","test":"jest"}}\n',
  );
  write(root, "src/index.ts", "export const value = 1;\n");
  write(
    root,
    "README.md",
    "# Lib\n\n## Usage\n\nRun `npm run bulid`, then see [the guide](./docs/guide.md).\n",
  );
  write(root, "AGENTS.md", "# Agents\n\n```bash\nnpm run lint:ci\n```\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return root;
}

function io() {
  return { stdout: jest.fn(), stderr: jest.fn() };
}

function findingsOf(output: ReturnType<typeof io>): string[][] {
  const report = JSON.parse(output.stdout.mock.calls[0][0]) as {
    findings: { file: string; kind: string; value: string }[];
  };
  return report.findings.map(({ file, kind, value }) => [file, kind, value]);
}

describe("audit command", () => {
  let root: string;
  beforeEach(() => {
    root = fixture();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prints one line per finding and exits 0 by default", async () => {
    const output = io();
    expect(await executeAuditCommand({}, output, root)).toBe(0);
    expect(output.stdout.mock.calls[0][0]).toBe(
      [
        'AGENTS.md > Agents: script-missing "npm run lint:ci"',
        "",
        'README.md > Usage: path-missing "docs/guide.md"',
        'README.md > Usage: script-missing "npm run bulid" (closest: build)',
        "",
        "3 findings across 2 Markdown files: script-missing 2, path-missing 1, member-missing 0.",
        "",
      ].join("\n"),
    );
    expect(output.stderr).not.toHaveBeenCalled();
  });

  it("exits 1 with fail-on findings and 0 when the repository is clean", async () => {
    const failing = io();
    expect(
      await executeAuditCommand({ failOn: "findings" }, failing, root),
    ).toBe(1);

    write(root, "README.md", "# Lib\n\nRun `npm run build`.\n");
    write(root, "AGENTS.md", "# Agents\n\nRun `npm test`.\n");
    const clean = io();
    expect(await executeAuditCommand({ failOn: "findings" }, clean, root)).toBe(
      0,
    );
    expect(clean.stdout.mock.calls[0][0]).toBe(
      "No findings across 2 Markdown files.\n",
    );
  });

  it("prints identical canonical JSON on repeated runs", async () => {
    const first = io();
    const second = io();
    await executeAuditCommand({ json: true }, first, root);
    await executeAuditCommand({ json: true }, second, root);
    expect(second.stdout.mock.calls[0][0]).toBe(first.stdout.mock.calls[0][0]);
    const report = JSON.parse(first.stdout.mock.calls[0][0]);
    expect(report.schema_version).toBe("aidoc.audit.v1");
    expect(report.revision).toBe("working-tree");
    expect(findingsOf(first)).toEqual([
      ["AGENTS.md", "script-missing", "npm run lint:ci"],
      ["README.md", "path-missing", "docs/guide.md"],
      ["README.md", "script-missing", "npm run bulid"],
    ]);
  });

  it("reads the working tree, including untracked documents and files", async () => {
    write(root, "docs/guide.md", "# Guide\n\nSee `src/index.ts`.\n");
    const output = io();
    await executeAuditCommand({ json: true }, output, root);
    expect(findingsOf(output)).toEqual([
      ["AGENTS.md", "script-missing", "npm run lint:ci"],
      ["README.md", "script-missing", "npm run bulid"],
    ]);
  });

  it("audits agent instruction files outside discovered directories", async () => {
    write(root, ".github/copilot-instructions.md", "# Copilot\n\nRun `npm run fmt`.\n");
    write(root, "CLAUDE.md", "# Claude\n\nRead `src/old.ts`.\n");
    const output = io();
    await executeAuditCommand({ json: true }, output, root);
    expect(findingsOf(output)).toEqual([
      [".github/copilot-instructions.md", "script-missing", "npm run fmt"],
      ["AGENTS.md", "script-missing", "npm run lint:ci"],
      ["CLAUDE.md", "path-missing", "src/old.ts"],
      ["README.md", "path-missing", "docs/guide.md"],
      ["README.md", "script-missing", "npm run bulid"],
    ]);
  });

  it("applies planning excludes and .staledocsignore to discovered documents", async () => {
    write(root, ".staledocsrc.json", '{"exclude":["AGENTS.md"]}\n');
    write(root, ".staledocsignore", "README.md\n");
    const output = io();
    await executeAuditCommand({ json: true }, output, root);
    expect(findingsOf(output)).toEqual([]);
  });

  it("checks package documents against the nearest package scripts", async () => {
    write(
      root,
      "packages/web/package.json",
      '{"name":"web","scripts":{"dev":"vite"}}\n',
    );
    write(
      root,
      "packages/web/README.md",
      "# Web\n\nRun `npm run dev`, `npm run build`, and `npm run serve`.\n",
    );
    const output = io();
    await executeAuditCommand(
      { json: true, path: ["packages/web/README.md"] },
      output,
      root,
    );
    expect(findingsOf(output)).toEqual([
      ["packages/web/README.md", "script-missing", "npm run serve"],
    ]);
  });

  it("reports only members that a closed public TypeScript type does not declare", async () => {
    write(
      root,
      "package.json",
      '{"name":"lib","main":"src/index.ts","scripts":{"build":"tsc","test":"jest"}}\n',
    );
    write(
      root,
      "src/index.ts",
      [
        'export { Client, Child, Indexed, Merged } from "./client";',
        'export { Legacy } from "./legacy.js";',
        "",
      ].join("\n"),
    );
    write(
      root,
      "src/client.ts",
      [
        "class Base { inherited(): void {} }",
        "export class Client {",
        "  static create(): Client { return new Client(1); }",
        "  baseUrl = '';",
        "  private secret(): void {}",
        "  get size(): number { return 0; }",
        "  set size(value: number) {}",
        "  constructor(public readonly timeout: number) {}",
        "  fetch(url: string): string { return url; }",
        "}",
        "export class Child extends Base {}",
        "export interface Indexed { [key: string]: number }",
        "export interface Merged { first: number }",
        "export interface Merged { second: number }",
        "export class Hidden { run(): void {} }",
        "",
      ].join("\n"),
    );
    write(
      root,
      "src/legacy.js",
      "export class Legacy {\n  constructor() { this.cache = {}; }\n}\n",
    );
    write(
      root,
      "README.md",
      [
        "# Lib",
        "",
        "## API",
        "",
        "`Client.fetchAll` `Client.fetch` `Client.baseUrl` `Client.size`",
        "`Client.timeout` `Client.secret` `Client.create` `Child.inherited`",
        "`Child.missing` `Indexed.anything` `Merged.third` `Legacy.cache`",
        "`Legacy.missing` `Hidden.missing`",
        "",
      ].join("\n"),
    );
    write(root, "AGENTS.md", "# Agents\n\nRun `npm test`.\n");
    const output = io();
    await executeAuditCommand({ json: true }, output, root);
    expect(findingsOf(output)).toEqual([
      ["README.md", "member-missing", "Client.fetchAll"],
    ]);
  });

  it("limits the audit to named documents", async () => {
    const output = io();
    await executeAuditCommand({ json: true, path: ["./AGENTS.md"] }, output, root);
    expect(findingsOf(output)).toEqual([
      ["AGENTS.md", "script-missing", "npm run lint:ci"],
    ]);
    expect(JSON.parse(output.stdout.mock.calls[0][0]).summary.files).toBe(1);
  });

  it.each([["../outside.md"], ["/etc/hosts.md"], ["src/index.ts"]])(
    "exits 2 for the unsafe or non-Markdown path %s",
    async (path) => {
      const output = io();
      expect(await executeAuditCommand({ path: [path] }, output, root)).toBe(2);
      expect(output.stdout).not.toHaveBeenCalled();
      expect(output.stderr.mock.calls[0][0]).toBe(
        "PLAN_UNSAFE_WORKTREE_PATH: The working-tree path is unsafe.\n",
      );
    },
  );

  it("exits 2 when a named document does not exist", async () => {
    const output = io();
    expect(
      await executeAuditCommand({ path: ["docs/missing.md"] }, output, root),
    ).toBe(2);
    expect(output.stderr.mock.calls[0][0]).toBe(
      "PLAN_SOURCE_READ_FAILED: Unable to read repository source.\n",
    );
  });

  it("exits 2 outside a Git repository and for an unknown fail-on value", async () => {
    const outside = mkdtempSync(join(tmpdir(), "staledocs-audit-outside-"));
    try {
      const output = io();
      expect(await executeAuditCommand({}, output, outside)).toBe(2);
      expect(output.stderr.mock.calls[0][0]).toMatch(/^PLAN_NOT_GIT_REPOSITORY:/u);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    const invalid = io();
    expect(
      await executeAuditCommand({ failOn: "stale" }, invalid, root),
    ).toBe(2);
    expect(invalid.stdout).not.toHaveBeenCalled();
  });
});
