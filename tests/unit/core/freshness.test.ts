jest.mock("../../../src/git/history", () => ({
  getChangedFiles: jest.fn(),
  getGitRoot: jest.fn(),
}));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getChangedFiles, getGitRoot } from "../../../src/git/history";
import { mapDocumentationImpact } from "../../../src/impact/documentation";
import { PlanFailure, type ImpactPlan, type SymbolChange } from "../../../src/impact/types";
import * as planner from "../../../src/impact/planner";
import {
  assessDocumentationFreshness,
  checkDocumentationFreshness,
} from "../../../src/core/freshness";

const change = (overrides: Partial<SymbolChange> = {}): SymbolChange => ({
  scope: "symbol",
  id: "change-create-user",
  category: "contract-changed",
  risk: "review-required",
  language: "typescript",
  path: "src/user.ts",
  kind: "function",
  qualifiedName: "createUser",
  digest: "a".repeat(64),
  ...overrides,
});

function planFor(changes: SymbolChange[], documentation: ImpactPlan["documentation"]): ImpactPlan {
  return {
    schemaVersion: "aidoc.impact-plan.v1",
    base: { type: "git", label: "base", commit: "a".repeat(40) },
    head: { type: "working-tree", label: "working-tree" },
    summary: {
      totalChanges: changes.length,
      publicApiChanges: changes.length,
      potentiallyBreaking: 0,
      reviewRequired: changes.length,
      informational: 0,
      unmapped: documentation.filter((item) => item.unmapped).length,
      byCategory: {
        added: 0,
        exposed: 0,
        removed: 0,
        hidden: 0,
        moved: 0,
        "contract-changed": changes.length,
        "implementation-changed": 0,
        "documentation-changed": 0,
        "dependency-changed": 0,
      },
    },
    changes,
    documentation,
    context: {
      maxBytes: 12000,
      usedBytes: 1,
      totalRecords: changes.length,
      includedRecords: changes.length,
      omittedRecords: 0,
      impactDigest: "b".repeat(64),
    },
    ignored: { unsupported: 0, excluded: 0, suppressed: 0 },
    digest: "c".repeat(64),
  };
}

function mappedPlan(changes: SymbolChange[], markdown: string): ImpactPlan {
  return planFor(changes, mapDocumentationImpact(changes, [{ path: "README.md", content: markdown }]));
}

describe("checkDocumentationFreshness integration boundaries", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    (getChangedFiles as jest.Mock).mockReset();
    (getGitRoot as jest.Mock).mockReset();
  });

  it("uses the working-tree changed-file list when --to is omitted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "staledocs-freshness-worktree-"));
    try {
      const plan = mappedPlan([change()], "# Demo\n\n## API\n\n`createUser`.\n");
      (getGitRoot as jest.Mock).mockResolvedValue(root);
      (getChangedFiles as jest.Mock).mockResolvedValue(["src/user.ts", "README.md"]);
      jest.spyOn(planner, "createImpactPlan").mockResolvedValue({
        plan,
        providerContext: {} as never,
        suppressed: [],
      });
      jest.spyOn(planner, "discoverReadme").mockResolvedValue("README.md");
      fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\n## API\n\n`createUser`.\n");

      const report = await checkDocumentationFreshness(root, undefined, "base");

      expect(report.status).toBe("co-changed");
      expect(getChangedFiles).toHaveBeenCalledWith("base", undefined, root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a discovered README against the repository root from a subdirectory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "staledocs-freshness-root-"));
    const cwd = path.join(root, "packages", "app");
    try {
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
      const plan = planFor([], []);
      (getGitRoot as jest.Mock).mockResolvedValue(root);
      (getChangedFiles as jest.Mock).mockResolvedValue([]);
      jest.spyOn(planner, "createImpactPlan").mockResolvedValue({
        plan,
        providerContext: {} as never,
        suppressed: [],
      });
      jest.spyOn(planner, "discoverReadme").mockResolvedValue("README.md");

      const report = await checkDocumentationFreshness(cwd, undefined, "base");

      expect(report.status).toBe("clean");
      expect(report.target).toBe("README.md");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assessDocumentationFreshness", () => {
  it("marks a changed symbol mentioned in an unchanged README section stale", () => {
    const report = assessDocumentationFreshness({
      plan: mappedPlan([change()], "# Demo\n\n## API\n\n`createUser(email)` creates a user.\n"),
      changedFiles: ["src/user.ts"],
      target: "README.md",
      targetExists: true,
    });

    expect(report.status).toBe("stale");
    expect(report.sections).toEqual([
      { section: "API", slug: "api", symbols: ["createUser"] },
    ]);
    expect(report.referencedSymbols).toEqual(["createUser"]);
  });

  it("marks a referenced README co-changed with its source co-changed", () => {
    const report = assessDocumentationFreshness({
      plan: mappedPlan([change()], "# Demo\n\n## API\n\n`createUser(email)` creates a user.\n"),
      changedFiles: ["src/user.ts", "./README.md"],
      target: "README.md",
      targetExists: true,
    });

    expect(report.status).toBe("co-changed");
    expect(report.targetChanged).toBe(true);
  });

  it.each([
    ["implementation-changed", ["src/user.ts"]],
    ["documentation-changed", ["src/user.ts", "README.md"]],
  ] as const)("keeps a mentioned %s symbol clean", (category, changedFiles) => {
    const report = assessDocumentationFreshness({
      plan: mappedPlan(
        [change({ category })],
        "# Demo\n\n## API\n\n`createUser` creates a user.\n",
      ),
      changedFiles,
      target: "README.md",
      targetExists: true,
    });

    expect(report).toMatchObject({
      status: "clean",
      referencedSymbols: [],
      sections: [],
      unmappedSymbols: [],
      sourceFiles: [],
    });
  });

  it("reports an unmapped contract change but not an unmapped implementation-only change", () => {
    const report = assessDocumentationFreshness({
      plan: mappedPlan(
        [
          change({ id: "contract", qualifiedName: "renamed" }),
          change({ id: "body", qualifiedName: "rewritten", category: "implementation-changed" }),
        ],
        "# Demo\n\n## API\n\nNo symbols here.\n",
      ),
      changedFiles: ["src/user.ts"],
      target: "README.md",
      targetExists: true,
    });

    expect(report.status).toBe("clean");
    expect(report.unmappedSymbols).toEqual(["renamed"]);
  });

  it("does not count recommendation-only mappings for a README target", () => {
    const report = assessDocumentationFreshness({
      plan: planFor(
        [change({ category: "added" })],
        mapDocumentationImpact([change({ category: "added" })], [
          { path: "README.md", content: "# Demo\n" },
          { path: "docs/API.md", content: "# API\n" },
        ]),
      ),
      changedFiles: ["src/user.ts"],
      target: "README.md",
      targetExists: true,
    });

    expect(report.status).toBe("clean");
  });

  it("maps a class through its directly referenced changed member only", () => {
    const classChange = change({ id: "class-change", kind: "class", qualifiedName: "Client" });
    const methodChange = change({ id: "method-change", kind: "method", qualifiedName: "Client.get" });
    const mapped = assessDocumentationFreshness({
      plan: mappedPlan([classChange, methodChange], "# Demo\n\n## Usage\n\nCall `Client.get(url)`."),
      changedFiles: ["src/user.ts"], target: "README.md", targetExists: true,
    });
    const classOnly = assessDocumentationFreshness({
      plan: mappedPlan([methodChange], "# Demo\n\n## Usage\n\nCreate a `Client`."),
      changedFiles: ["src/user.ts"], target: "README.md", targetExists: true,
    });
    expect(mapped.unmappedSymbols).toEqual([]);
    expect(classOnly.unmappedSymbols).toEqual(["Client.get"]);
  });

  it("reports a missing target", () => {
    const report = assessDocumentationFreshness({
      plan: mappedPlan([change()], "# Demo\n\n## API\n\n`createUser`.\n"),
      changedFiles: ["src/user.ts"],
      target: "README.md",
      targetExists: false,
    });

    expect(report.status).toBe("missing");
  });

  it("maps a planning failure to unknown without exposing a path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "staledocs-freshness-plan-"));
    try {
      (getGitRoot as jest.Mock).mockResolvedValue(root);
      jest
        .spyOn(planner, "createImpactPlan")
        .mockRejectedValue(new PlanFailure("PLAN_PARSE_FAILED", "Unable to parse changed source.", "sensitive/source.ts"));

      const report = await checkDocumentationFreshness(root, undefined, "HEAD~1");

      expect(report.status).toBe("unknown");
      expect(report.message).not.toContain("sensitive/source.ts");
      expect(report.target).toBe("README.md");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      jest.restoreAllMocks();
    }
  });

  afterEach(() => {
    (getChangedFiles as jest.Mock).mockReset();
    (getGitRoot as jest.Mock).mockReset();
  });
});
