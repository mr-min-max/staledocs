import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeReviewCommand,
  createReviewReport,
} from "../../../src/cli/commands/review";
import * as planner from "../../../src/impact/planner";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "staledocs-review-cli-"));
  mkdirSync(join(root, "src"));
  git(root, "init", "-q", "--initial-branch", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "src", "user.ts"), "export function createUser(email: string): string { return email; }\n");
  writeFileSync(join(root, "README.md"), "# API\n\n## API\n\n`createUser`\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return root;
}

describe("review command", () => {
  let root: string;
  beforeEach(() => { root = fixture(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("reports stale by default but fails only when fail-on stale is selected", async () => {
    writeFileSync(join(root, "src", "user.ts"), "export function createUser(email: number): number { return email; }\n");
    const output = { stdout: jest.fn(), stderr: jest.fn() };
    expect(await executeReviewCommand({ base: "HEAD", format: "json" }, output, root)).toBe(0);
    expect(JSON.parse(output.stdout.mock.calls[0][0]).verdict).toBe("stale");
    output.stdout.mockClear();
    expect(await executeReviewCommand({ base: "HEAD", format: "json", failOn: "stale" }, output, root)).toBe(1);
  });

  it("does not fail stale-only reports under the breaking policy", async () => {
    writeFileSync(
      join(root, "src", "user.ts"),
      "export function createUser(email: number): number { return email; }\n",
    );
    const output = { stdout: jest.fn(), stderr: jest.fn() };

    expect(
      await executeReviewCommand(
        { base: "HEAD", format: "json", failOn: "breaking" },
        output,
        root,
      ),
    ).toBe(0);
    expect(JSON.parse(output.stdout.mock.calls[0][0]).verdict).toBe("stale");
  });

  it("fails breaking reports under the breaking policy", async () => {
    writeFileSync(
      join(root, "src", "user.ts"),
      "export function createUser(email: string, role: string): string { return email; }\n",
    );
    const output = { stdout: jest.fn(), stderr: jest.fn() };

    expect(
      await executeReviewCommand(
        { base: "HEAD", format: "json", failOn: "breaking" },
        output,
        root,
      ),
    ).toBe(1);
    expect(JSON.parse(output.stdout.mock.calls[0][0]).verdict).toBe("breaking");
  });

  it.each([
    [{ format: "yaml" }, "format"],
    [{ failOn: "always" }, "fail-on"],
  ])("rejects an invalid %s option before planning", async (invalid, _label) => {
    const createPlan = jest.spyOn(planner, "createImpactPlan");
    const output = { stdout: jest.fn(), stderr: jest.fn() };

    expect(
      await executeReviewCommand(
        invalid as unknown as Parameters<typeof executeReviewCommand>[0],
        output,
        root,
      ),
    ).toBe(2);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(output.stderr).toHaveBeenCalledWith(
      "Invalid review options: format or fail-on is not supported.\n",
    );
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("reports an arity increase as breaking", async () => {
    writeFileSync(join(root, "src", "user.ts"), "export function createUser(email: string, role: string): string { return email; }\n");
    const result = await createReviewReport({ base: "HEAD" }, root);
    expect(result.verdict).toBe("breaking");
    expect(result.summary.breaking).toBe(1);
  });

  it("reports an added symbol as not mentioned when it has only a recommendation", async () => {
    writeFileSync(
      join(root, "src", "user.ts"),
      "export function createUser(email: string): string { return email; }\nexport function helperExport(): void {}\n",
    );

    const result = await createReviewReport({ base: "HEAD" }, root);

    expect(result.changes.map((change) => change.qualifiedName)).toEqual([
      "helperExport",
    ]);
    expect(result.documents).toEqual([]);
    expect(result.unmapped).toEqual(["helperExport"]);
    expect(result.summary.unmappedSymbols).toBe(1);
  });

  it("assesses a directly mentioned implementation-only change without listing it as a report change", async () => {
    writeFileSync(
      join(root, "src", "user.ts"),
      "export function createUser(email: string): string { return email.trim(); }\n",
    );

    const result = await createReviewReport({ base: "HEAD" }, root);

    expect(result.changes).toEqual([]);
    expect(result.summary.publicApiChanges).toBe(0);
    expect(result.documents).toEqual([
      {
        path: "README.md",
        status: "stale",
        sections: [
          { section: "API", slug: "api-1", symbols: ["createUser"] },
        ],
      },
    ]);
    expect(result.verdict).toBe("stale");
  });

  it.each([
    [
      "an implementation-only change",
      "export function createUser(email: string): string { return email.trim(); }\n",
      undefined,
    ],
    [
      "a documentation-only change with an edited document",
      "/** Creates a user. */\nexport function createUser(email: string): string { return email; }\n",
      "# API\n\n## API\n\n`createUser` creates a user.\n",
    ],
  ])("reports no document for %s of a documented symbol", async (_label, source, readme) => {
    writeFileSync(join(root, "src", "user.ts"), source);
    if (readme !== undefined) writeFileSync(join(root, "README.md"), readme);

    const result = await createReviewReport({ base: "HEAD" }, root);

    expect(result.changes).toEqual([]);
    expect(result.documents).toEqual([]);
    expect(result.summary).toMatchObject({
      publicApiChanges: 0,
      staleDocuments: 0,
      coChangedDocuments: 0,
    });
    expect(result.verdict).toBe("clean");
  });

  it.each([
    ["clean", "export function createUser(email: string): string { return email.trim(); }\n"],
    ["stale", "export function createUser(email: number): number { return email; }\n"],
    ["breaking", "export function createUser(email: string, role: string): string { return email; }\n"],
  ])("derives the %s verdict, counts, and documents from the same changes", async (verdict, source) => {
    writeFileSync(join(root, "src", "user.ts"), source);

    const result = await createReviewReport({ base: "HEAD" }, root);

    expect(result.verdict).toBe(verdict);
    expect(result.verdict === "clean").toBe(
      result.summary.breaking === 0 && result.summary.staleDocuments === 0,
    );
    expect(result.summary.publicApiChanges).toBe(result.changes.length);
    expect(result.summary.staleDocuments).toBe(
      result.documents.filter((document) => document.status === "stale").length,
    );
    expect(result.changes.length === 0 && result.documents.length > 0).toBe(false);
  });

  it("hides internal changes from review counts and document findings", async () => {
    writeFileSync(join(root, "package.json"), '{"main":"dist/index.js"}\n');
    writeFileSync(
      join(root, "src", "index.ts"),
      'export { createUser } from "./user";\n',
    );
    git(root, "add", ".");
    git(root, "commit", "-qm", "entry");
    writeFileSync(join(root, "src", "internal.ts"), "export function hidden(value: string): string { return value; }\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "internal base");
    writeFileSync(join(root, "src", "internal.ts"), "export function hidden(value: number): number { return value; }\n");

    const result = await createReviewReport({ base: "HEAD" }, root);

    expect(result.summary).toMatchObject({
      publicApiChanges: 0,
      internalChanges: 1,
      staleDocuments: 0,
    });
    expect(result.changes).toEqual([]);
    expect(result.documents).toEqual([]);
    expect(result.boundary?.typescript).toMatchObject({
      mode: "entry",
      entries: ["src/index.ts"],
    });
  });

  it("folds a class row and maps the class through its changed method", async () => {
    const classRoot = mkdtempSync(join(tmpdir(), "staledocs-review-class-"));
    mkdirSync(join(classRoot, "src"));
    git(classRoot, "init", "-q", "--initial-branch", "main");
    git(classRoot, "config", "user.email", "test@example.invalid");
    git(classRoot, "config", "user.name", "Test");
    writeFileSync(join(classRoot, "package.json"), '{"name":"lib","main":"dist/index.js"}\n');
    writeFileSync(join(classRoot, "src", "index.ts"), "export class Client { get(url: string): Promise<string> { return Promise.resolve(url); } }\n");
    writeFileSync(join(classRoot, "README.md"), "# core\n\n## Usage\n\nCall `Client.get(url)` to fetch.\n");
    git(classRoot, "add", ".");
    git(classRoot, "commit", "-qm", "base");
    writeFileSync(join(classRoot, "src", "index.ts"), "export class Client { get(url: string, init: RequestInit): Promise<string> { return Promise.resolve(url); } }\n");
    try {
      const result = await createReviewReport({ base: "HEAD" }, classRoot);
      expect(result.changes.map(({ qualifiedName }) => qualifiedName)).toEqual(["Client.get"]);
      expect(result.unmapped).toEqual([]);
    } finally {
      rmSync(classRoot, { recursive: true, force: true });
    }
  });

  it("carries CommonJS not-analyzed files into the review report", async () => {
    const commonRoot = mkdtempSync(join(tmpdir(), "staledocs-review-commonjs-"));
    mkdirSync(join(commonRoot, "lib"));
    git(commonRoot, "init", "-q", "--initial-branch", "main");
    git(commonRoot, "config", "user.email", "test@example.invalid");
    git(commonRoot, "config", "user.name", "Test");
    writeFileSync(join(commonRoot, "package.json"), '{"name":"lib","main":"lib/index.js"}\n');
    writeFileSync(join(commonRoot, "lib", "index.js"), "var req = {};\nmodule.exports = req;\n");
    git(commonRoot, "add", ".");
    git(commonRoot, "commit", "-qm", "base");
    writeFileSync(join(commonRoot, "lib", "index.js"), "var req = { fresh: true };\nmodule.exports = req;\n");
    try {
      const result = await createReviewReport({ base: "HEAD" }, commonRoot);
      expect(result.summary.publicApiChanges).toBe(0);
      expect(result.notAnalyzed).toEqual([{ path: "lib/index.js", reason: "commonjs" }]);
    } finally {
      rmSync(commonRoot, { recursive: true, force: true });
    }
  });

  it("does not call an added class unmapped when its added member is referenced", async () => {
    writeFileSync(
      join(root, "src", "user.ts"),
      "export function createUser(email: string): string { return email; }\nexport class Client { get(url: string): string { return url; } }\n",
    );
    writeFileSync(
      join(root, "README.md"),
      "# API\n\n## API\n\n`createUser` and `Client.get(url)`\n",
    );

    const result = await createReviewReport({ base: "HEAD" }, root);

    expect(result.changes.map(({ qualifiedName }) => qualifiedName)).toEqual([
      "Client",
      "Client.get",
    ]);
    expect(result.unmapped).toEqual([]);
  });

  it("prints suppression detail in text while preserving a clean exit", async () => {
    writeFileSync(join(root, ".staledocsignore"), "createUser\n");
    writeFileSync(
      join(root, "src", "user.ts"),
      "export function createUser(email: string, role: string): string { return email; }\n",
    );
    const output = { stdout: jest.fn(), stderr: jest.fn() };

    expect(
      await executeReviewCommand(
        { base: "HEAD", format: "text", failOn: "stale" },
        output,
        root,
      ),
    ).toBe(0);
    expect(output.stdout.mock.calls[0][0]).toContain(
      "1 suppressed change from .staledocsignore.",
    );

    const result = await createReviewReport({ base: "HEAD" }, root);
    expect(result.verdict).toBe("clean");
    expect(result.summary.suppressed).toBe(1);
    expect(result.suppressed).toEqual([
      { symbol: "createUser", reason: "createUser" },
    ]);
  });
});
