import { PythonParser } from "../../../src/parsers/python";
import { TypeScriptParser } from "../../../src/parsers/typescript";
import {
  compareSnapshots,
  digestImpactPayload,
  summarizeImpact,
  type ParsedFileSnapshots,
} from "../../../src/impact/compare";
import type {
  DocumentationImpact,
  ParserModuleSnapshot,
  ParserSymbolSnapshot,
  SnapshotDescriptor,
} from "../../../src/impact/types";

const hash = (char: string): string => char.repeat(64);

function symbol(
  qualifiedName: string,
  overrides: Partial<ParserSymbolSnapshot> = {},
): ParserSymbolSnapshot {
  return {
    language: "typescript",
    kind: "function",
    qualifiedName,
    signature: `${qualifiedName}(): void`,
    contractFacets: { parameters: hash("a"), return: hash("b") },
    contractFingerprint: hash("c"),
    implementationFingerprint: hash("d"),
    documentationFingerprint: hash("e"),
    ...overrides,
  };
}

function module(
  _path: string,
  symbols: ParserSymbolSnapshot[],
  dependencyFingerprint = hash("f"),
): ParserModuleSnapshot {
  return { language: "typescript", dependencyFingerprint, symbols };
}

function file(
  status: ParsedFileSnapshots["status"],
  before: ParserModuleSnapshot | undefined,
  after: ParserModuleSnapshot | undefined,
  beforePath?: string,
  afterPath?: string,
): ParsedFileSnapshots {
  return { status, before, after, beforePath, afterPath };
}

describe("impact snapshot comparison", () => {
  it("classifies symbol and module changes with risk and facet labels", () => {
    const before = module("src/before.ts", [
      symbol("removed"),
      symbol("contract", {
        contractFingerprint: hash("1"),
        contractFacets: { return: hash("2"), parameters: hash("3") },
        implementationFingerprint: hash("4"),
      }),
      symbol("implementation", { implementationFingerprint: hash("5") }),
      symbol("documentation", { documentationFingerprint: hash("6") }),
      symbol("same"),
    ]);
    const after = module(
      "src/after.ts",
      [
        symbol("added"),
        symbol("contract", {
          contractFingerprint: hash("7"),
          contractFacets: { return: hash("8"), parameters: hash("9") },
          implementationFingerprint: hash("4"),
        }),
        symbol("implementation", { implementationFingerprint: hash("8") }),
        symbol("documentation", { documentationFingerprint: hash("9") }),
        symbol("same"),
      ],
      hash("0"),
    );

    const changes = compareSnapshots([
      file("modified", before, after, "src/before.ts", "src/after.ts"),
    ]);
    expect(
      changes.map(({ category, qualifiedName }) => [category, qualifiedName]),
    ).toEqual([
      ["removed", "removed"],
      ["contract-changed", "contract"],
      ["added", "added"],
      ["dependency-changed", undefined],
      ["implementation-changed", "implementation"],
      ["documentation-changed", "documentation"],
    ]);
    const byCategory = new Map(
      changes.map((change) => [change.category, change]),
    );
    expect(byCategory.get("removed")).toMatchObject({
      risk: "potentially-breaking",
    });
    expect(byCategory.get("contract-changed")).toMatchObject({
      risk: "review-required",
      changedContractFacets: ["parameters", "return"],
    });
    expect(byCategory.get("implementation-changed")).toMatchObject({
      risk: "informational",
    });
    expect(byCategory.get("documentation-changed")).toMatchObject({
      risk: "informational",
    });
    expect(byCategory.get("dependency-changed")).toMatchObject({
      scope: "module",
      id: "typescript:src/after.ts#module",
      risk: "informational",
    });
    expect(changes.every(({ digest }) => digest.match(/^[0-9a-f]{64}$/u))).toBe(
      true,
    );
  });

  it("reports honest moves only for explicit renames with identical fingerprints", () => {
    const before = module("src/old.ts", [symbol("thing")]);
    const after = module("src/new.ts", [symbol("thing")]);
    const moved = compareSnapshots([
      file("renamed", before, after, "src/old.ts", "src/new.ts"),
    ]);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      category: "moved",
      beforeId: "typescript:src/old.ts#function:thing",
      afterId: "typescript:src/new.ts#function:thing",
    });

    const changed = compareSnapshots([
      file(
        "renamed",
        before,
        module("src/new.ts", [symbol("other")]),
        "src/old.ts",
        "src/new.ts",
      ),
    ]);
    expect(changed.map(({ category }) => category)).toEqual([
      "removed",
      "added",
    ]);
  });

  it("classifies unchanged symbols as moved independently within a changed rename", () => {
    const before = module("src/old.ts", [
      symbol("stable"),
      symbol("changed", { implementationFingerprint: hash("1") }),
    ]);
    const after = module("src/new.ts", [
      symbol("stable"),
      symbol("changed", { implementationFingerprint: hash("2") }),
    ]);

    const changes = compareSnapshots([
      file("renamed", before, after, "src/old.ts", "src/new.ts"),
    ]);

    expect(
      changes.map(({ category, qualifiedName }) => [category, qualifiedName]),
    ).toEqual([
      ["removed", "changed"],
      ["moved", "stable"],
      ["added", "changed"],
    ]);
  });

  it("reports dependency changes alongside content-changing renames", () => {
    const before = module("src/old.ts", [symbol("thing")], hash("a"));
    const after = module(
      "src/new.ts",
      [symbol("thing", { implementationFingerprint: hash("1") })],
      hash("b"),
    );

    const changes = compareSnapshots([
      file("renamed", before, after, "src/old.ts", "src/new.ts"),
    ]);

    expect(
      changes.filter(({ category }) => category === "dependency-changed"),
    ).toHaveLength(1);
    expect(changes.filter(({ scope }) => scope === "module")).toEqual([
      expect.objectContaining({
        category: "dependency-changed",
        id: "typescript:src/new.ts#module",
      }),
    ]);
  });

  it("suppresses implementation changes when a contract changes too", () => {
    const before = module("src/a.ts", [symbol("thing")]);
    const after = module("src/a.ts", [
      symbol("thing", {
        contractFingerprint: hash("1"),
        contractFacets: { parameters: hash("2"), return: hash("3") },
        implementationFingerprint: hash("4"),
      }),
    ]);

    const changes = compareSnapshots([
      file("modified", before, after, "src/a.ts", "src/a.ts"),
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      category: "contract-changed",
      qualifiedName: "thing",
      changedContractFacets: ["parameters", "return"],
    });
  });

  it("folds a class members row when a public method changes", async () => {
    const parser = new TypeScriptParser();
    const before = await parser.snapshot(
      "src/client.ts",
      "export class Client { get(url: string): string { return url; } }",
    );
    const after = await parser.snapshot(
      "src/client.ts",
      "export class Client { get(url: string, init: RequestInit): string { return url; } }",
    );

    const changes = compareSnapshots([
      file("modified", before, after, "src/client.ts", "src/client.ts"),
    ]);

    expect(changes.map(({ qualifiedName }) => qualifiedName)).toEqual([
      "Client.get",
    ]);
  });

  it("keeps a class members row when no public method changes", async () => {
    const parser = new TypeScriptParser();
    const before = await parser.snapshot(
      "src/client.ts",
      "export class Client {}",
    );
    const after = await parser.snapshot(
      "src/client.ts",
      "export class Client { value = 1; }",
    );

    const changes = compareSnapshots([
      file("modified", before, after, "src/client.ts", "src/client.ts"),
    ]);

    expect(changes).toEqual([
      expect.objectContaining({
        qualifiedName: "Client",
        kind: "class",
        category: "contract-changed",
        changedContractFacets: ["members"],
      }),
    ]);
  });

  it("reports Python constructor signature changes as class constructor changes", async () => {
    const parser = new PythonParser();
    const compareInit = async (
      beforeParameters: string,
      afterParameters: string,
      afterBody = "self.url = url",
    ) =>
      compareSnapshots([
        file(
          "modified",
          await parser.snapshot(
            "src/client.py",
            `class Client:\n    def __init__(self, ${beforeParameters}):\n        self.url = url\n`,
          ),
          await parser.snapshot(
            "src/client.py",
            `class Client:\n    def __init__(self, ${afterParameters}):\n        ${afterBody}\n`,
          ),
          "src/client.py",
          "src/client.py",
        ),
      ]);

    expect(
      await compareInit("url: str", "url: str, timeout: float = 1.0"),
    ).toEqual([
      expect.objectContaining({
        qualifiedName: "Client",
        kind: "class",
        category: "contract-changed",
        changedContractFacets: ["constructor"],
        risk: "review-required",
      }),
    ]);
    expect(await compareInit("url: str", "url: str, timeout: float")).toEqual([
      expect.objectContaining({
        qualifiedName: "Client",
        kind: "class",
        category: "contract-changed",
        changedContractFacets: ["constructor"],
        risk: "potentially-breaking",
      }),
    ]);
    expect(
      await compareInit("url: str", "url: str", "self.url = str(url)"),
    ).toEqual([
      expect.objectContaining({
        qualifiedName: "Client",
        kind: "class",
        category: "implementation-changed",
      }),
    ]);
  });

  it("propagates signatures and callable arity by change category", () => {
    const beforeContract = symbol("contract", {
      signature: "contract(value?: string): void",
      arity: { required: 0, total: 1 },
      contractFingerprint: hash("1"),
    });
    const afterContract = symbol("contract", {
      signature: "contract(value: string, count: number): void",
      arity: { required: 2, total: 2 },
      contractFingerprint: hash("2"),
    });
    const changes = compareSnapshots([
      file(
        "modified",
        module("src/api.ts", [
          beforeContract,
          symbol("removed", {
            signature: "removed(value: string): void",
            arity: { required: 1, total: 1 },
          }),
        ]),
        module("src/api.ts", [
          afterContract,
          symbol("added", {
            signature: "added(value?: string): void",
            arity: { required: 0, total: 1 },
          }),
        ]),
        "src/api.ts",
        "src/api.ts",
      ),
    ]);

    expect(
      changes.find(({ qualifiedName }) => qualifiedName === "contract"),
    ).toMatchObject({
      category: "contract-changed",
      risk: "potentially-breaking",
      before: "contract(value?: string): void",
      after: "contract(value: string, count: number): void",
      arity: { required: 2, total: 2 },
    });
    expect(
      changes.find(({ qualifiedName }) => qualifiedName === "removed"),
    ).toMatchObject({
      category: "removed",
      before: "removed(value: string): void",
      arity: { required: 1, total: 1 },
    });
    expect(
      changes.find(({ qualifiedName }) => qualifiedName === "added"),
    ).toMatchObject({
      category: "added",
      after: "added(value?: string): void",
      arity: { required: 0, total: 1 },
    });
  });

  it("upgrades arity risk only when required count grows or total count shrinks", () => {
    const cases = [
      [
        { required: 1, total: 2 },
        { required: 2, total: 2 },
        "potentially-breaking",
      ],
      [
        { required: 1, total: 2 },
        { required: 1, total: 1 },
        "potentially-breaking",
      ],
      [{ required: 1, total: 1 }, { required: 1, total: 2 }, "review-required"],
    ] as const;

    const risks = cases.map(
      ([before, after]) =>
        compareSnapshots([
          file(
            "modified",
            module("src/api.ts", [symbol("call", { arity: { ...before } })]),
            module("src/api.ts", [
              symbol("call", {
                arity: { ...after },
                contractFingerprint: hash("1"),
              }),
            ]),
            "src/api.ts",
            "src/api.ts",
          ),
        ])[0].risk,
    );

    expect(risks).toEqual(cases.map(([, , expected]) => expected));
  });

  it("uses stable IDs, ordering, and repeatable digests", () => {
    const files: ParsedFileSnapshots[] = [
      file(
        "added",
        undefined,
        module("src/z.ts", [symbol("z")]),
        undefined,
        "src/z.ts",
      ),
      file(
        "added",
        undefined,
        module("src/a.ts", [symbol("a")]),
        undefined,
        "src/a.ts",
      ),
    ];
    const first = compareSnapshots(files);
    const second = compareSnapshots(files);
    expect(first.map(({ id }) => id)).toEqual([
      "typescript:src/a.ts#function:a",
      "typescript:src/z.ts#function:z",
    ]);
    expect(first.map(({ digest }) => digest)).toEqual(
      second.map(({ digest }) => digest),
    );
  });

  it("summarizes categories, risks, API records, and unmapped documentation", () => {
    const changes = compareSnapshots([
      file(
        "deleted",
        module("src/x.ts", [symbol("x")]),
        undefined,
        "src/x.ts",
        undefined,
      ),
      file(
        "added",
        undefined,
        module("src/y.ts", [symbol("y")]),
        undefined,
        "src/y.ts",
      ),
    ]);
    const documentation: DocumentationImpact[] = [
      {
        changeId: changes[0].id,
        directReferences: [],
        recommendations: [],
        unmapped: true,
      },
    ];
    expect(summarizeImpact(changes, documentation)).toEqual({
      totalChanges: 2,
      publicApiChanges: 2,
      potentiallyBreaking: 1,
      reviewRequired: 0,
      informational: 1,
      unmapped: 1,
      byCategory: {
        added: 1,
        exposed: 0,
        removed: 1,
        hidden: 0,
        moved: 0,
        "contract-changed": 0,
        "implementation-changed": 0,
        "documentation-changed": 0,
        "dependency-changed": 0,
      },
    });
  });

  it("counts internal visibility without changing fallback behavior", () => {
    const changes = compareSnapshots([
      file(
        "added",
        undefined,
        module("src/api.ts", [symbol("publicApi"), symbol("internalApi")]),
        undefined,
        "src/api.ts",
      ),
    ]);
    changes[0].visibility = "internal";
    changes[1].visibility = "public";
    const documentation: DocumentationImpact[] = changes.map((change) => ({
      changeId: change.id,
      directReferences: [],
      recommendations: [],
      unmapped: true,
    }));

    expect(summarizeImpact(changes, documentation)).toMatchObject({
      publicApiChanges: 1,
      internalChanges: 1,
      unmapped: 1,
    });
    for (const change of changes) delete change.visibility;
    expect(summarizeImpact(changes, documentation)).toMatchObject({
      publicApiChanges: 2,
      unmapped: 2,
    });
    expect(
      summarizeImpact(changes, documentation).internalChanges,
    ).toBeUndefined();
  });

  it("does not count informational internal records in the hidden headline", () => {
    const change = compareSnapshots([
      file(
        "modified",
        module("src/api.ts", [symbol("internal")]),
        module("src/api.ts", [
          symbol("internal", { implementationFingerprint: hash("1") }),
        ]),
        "src/api.ts",
        "src/api.ts",
      ),
    ])[0];
    change.visibility = "internal";

    expect(summarizeImpact([change])).toMatchObject({
      publicApiChanges: 0,
      internalChanges: 0,
    });
  });

  it("excludes implementation and documentation changes from public API totals", () => {
    const implementation = compareSnapshots([
      file(
        "modified",
        module("src/api.ts", [symbol("implementation")]),
        module("src/api.ts", [
          symbol("implementation", { implementationFingerprint: hash("1") }),
        ]),
        "src/api.ts",
        "src/api.ts",
      ),
    ])[0];
    const documentation = compareSnapshots([
      file(
        "modified",
        module("src/api.ts", [symbol("documentation")]),
        module("src/api.ts", [
          symbol("documentation", { documentationFingerprint: hash("1") }),
        ]),
        "src/api.ts",
        "src/api.ts",
      ),
    ])[0];

    expect(summarizeImpact([implementation, documentation])).toMatchObject({
      totalChanges: 2,
      publicApiChanges: 0,
      informational: 2,
    });
  });

  it("digests semantic payload without context or outer digest", () => {
    const base: SnapshotDescriptor = {
      type: "git",
      label: "main",
      commit: hash("1"),
    };
    const head: SnapshotDescriptor = { type: "working-tree", label: "HEAD" };
    const changes = compareSnapshots([
      file(
        "added",
        undefined,
        module("src/a.ts", [symbol("a")]),
        undefined,
        "src/a.ts",
      ),
    ]);
    const summary = summarizeImpact(changes);
    const input = {
      base,
      head,
      summary,
      changes,
      documentation: [],
      ignored: { unsupported: 2, excluded: 3, suppressed: 0 },
    };
    const first = digestImpactPayload(input);
    const second = digestImpactPayload({
      ...input,
      context: { ignored: "outer context" },
      digest: hash("0"),
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
  });

  it("reports an aliased export rename from parsed source as removal and addition", async () => {
    const parser = new TypeScriptParser();
    const before = await parser.snapshot(
      "src/modern.ts",
      "const internal = (n: number) => n; export { internal as exposed };",
    );
    const after = await parser.snapshot(
      "src/modern.ts",
      "const internal = (n: number) => n; export { internal as shown };",
    );
    const changes = compareSnapshots([
      file("modified", before, after, "src/modern.ts", "src/modern.ts"),
    ]);

    expect(
      changes.map(({ category, qualifiedName }) => [category, qualifiedName]),
    ).toEqual([
      ["removed", "exposed"],
      ["added", "shown"],
    ]);
  });
});
