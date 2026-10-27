import { canonicalStringify, compareChangeKeys, sha256Hex } from "./canonical";
import type { SnapshotFileStatus } from "../git/snapshot";
import { CONTRACT_CHANGE_CATEGORIES, isContractChange } from "./types";
import type {
  ChangeCategory,
  ContractFacet,
  DocumentationImpact,
  ImpactSummary,
  ImpactPlan,
  ParserModuleSnapshot,
  ParserSymbolSnapshot,
  SnapshotDescriptor,
  SymbolChange,
} from "./types";

export interface ParsedFileSnapshots {
  status: SnapshotFileStatus;
  beforePath?: string;
  afterPath?: string;
  before?: ParserModuleSnapshot;
  after?: ParserModuleSnapshot;
}

const CATEGORY_ORDER: readonly ChangeCategory[] = [
  "removed",
  "hidden",
  "contract-changed",
  "moved",
  "added",
  "exposed",
  "dependency-changed",
  "implementation-changed",
  "documentation-changed",
];

const CATEGORY_PRIORITY = new Map(
  CATEGORY_ORDER.map((category, index) => [category, index]),
);

const ALL_CATEGORIES: readonly ChangeCategory[] = [
  "added",
  "exposed",
  "removed",
  "hidden",
  "moved",
  "contract-changed",
  "implementation-changed",
  "documentation-changed",
  "dependency-changed",
];

const FACETS: readonly ContractFacet[] = [
  "parameters",
  "return",
  "inheritance",
  "members",
  "modifiers",
  "constructor",
];

/**
 * Compares parsed before/after module snapshots and emits deterministic changes.
 *
 * @param files - Git file statuses paired with their parsed module snapshots.
 * @returns Symbol and module changes in stable impact order.
 */
export function compareSnapshots(files: ParsedFileSnapshots[]): SymbolChange[] {
  const changes: SymbolChange[] = [];
  for (const file of files) {
    const before = file.before;
    const after = file.after;
    if (
      file.status === "renamed" &&
      before !== undefined &&
      after !== undefined
    ) {
      const beforeByKey = indexSymbols(before.symbols);
      const afterByKey = indexSymbols(after.symbols);
      for (const previous of before.symbols) {
        const current = afterByKey.get(symbolKey(previous));
        if (current !== undefined && identicalSymbols(previous, current)) {
          changes.push(
            createChange({
              scope: "symbol",
              category: "moved",
              risk: "informational",
              language: previous.language,
              path: file.afterPath ?? file.beforePath ?? "",
              kind: previous.kind,
              qualifiedName: previous.qualifiedName,
              beforeId: symbolId(file.beforePath ?? "", previous),
              afterId: symbolId(file.afterPath ?? "", current),
              before: previous.signature,
              after: current.signature,
              ...(current.arity === undefined ? {} : { arity: current.arity }),
            }),
          );
        } else {
          addOne(changes, previous, file.beforePath, "removed");
        }
      }
      for (const current of after.symbols) {
        const previous = beforeByKey.get(symbolKey(current));
        if (previous === undefined || !identicalSymbols(previous, current)) {
          addOne(changes, current, file.afterPath, "added");
        }
      }
      if (before.dependencyFingerprint !== after.dependencyFingerprint) {
        changes.push(
          createChange({
            scope: "module",
            category: "dependency-changed",
            risk: "informational",
            language: after.language,
            path: file.afterPath ?? file.beforePath ?? "",
            kind: "module",
          }),
        );
      }
      continue;
    }

    if (before === undefined) {
      addAll(changes, after?.symbols ?? [], file.afterPath, "added");
      continue;
    }
    if (after === undefined) {
      addAll(changes, before.symbols, file.beforePath, "removed");
      continue;
    }

    const beforeByKey = indexSymbols(before.symbols);
    const afterByKey = indexSymbols(after.symbols);
    const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
    for (const key of keys) {
      const previous = beforeByKey.get(key);
      const current = afterByKey.get(key);
      if (previous === undefined) {
        addOne(changes, current!, file.afterPath, "added");
      } else if (current === undefined) {
        addOne(changes, previous, file.beforePath, "removed");
      } else {
        compareSymbol(
          changes,
          previous,
          current,
          file.afterPath ?? file.beforePath ?? "",
        );
      }
    }
    if (before.dependencyFingerprint !== after.dependencyFingerprint) {
      changes.push(
        createChange({
          scope: "module",
          category: "dependency-changed",
          risk: "informational",
          language: after.language,
          path: file.afterPath ?? file.beforePath ?? "",
          kind: "module",
        }),
      );
    }
  }
  return foldRedundantMemberChanges(changes).sort(compareImpactChanges);
}

function foldRedundantMemberChanges(changes: SymbolChange[]): SymbolChange[] {
  const rootsWithMethodChanges = new Set(
    changes.flatMap((change) => {
      if (
        change.scope !== "symbol" ||
        change.kind !== "method" ||
        change.qualifiedName === undefined
      ) {
        return [];
      }
      const separator = change.qualifiedName.indexOf(".");
      return separator < 0
        ? []
        : [`${change.path}\0${change.qualifiedName.slice(0, separator)}`];
    }),
  );
  return changes.filter(
    (change) =>
      !(
        change.scope === "symbol" &&
        (change.kind === "class" || change.kind === "interface") &&
        change.category === "contract-changed" &&
        change.changedContractFacets?.length === 1 &&
        change.changedContractFacets[0] === "members" &&
        change.qualifiedName !== undefined &&
        rootsWithMethodChanges.has(`${change.path}\0${change.qualifiedName}`)
      ),
  );
}

/**
 * Aggregates change risks, categories, and documentation mapping gaps.
 *
 * @param changes - Semantic changes included in the impact plan.
 * @param documentation - Documentation mappings for those changes.
 * @returns Counts used by human, JSON, and provider-facing plan output.
 */
export function summarizeImpact(
  changes: SymbolChange[],
  documentation: DocumentationImpact[] = [],
): ImpactSummary {
  const byCategory = Object.fromEntries(
    ALL_CATEGORIES.map((category) => [category, 0]),
  ) as Record<ChangeCategory, number>;
  let potentiallyBreaking = 0;
  let reviewRequired = 0;
  let informational = 0;
  let publicApiChanges = 0;
  let internalChanges = 0;
  let hasVisibility = false;
  const publicChangeIds = new Set<string>();
  for (const change of changes) {
    byCategory[change.category] += 1;
    if (change.visibility !== undefined) hasVisibility = true;
    if (
      change.visibility === "internal" &&
      change.scope === "symbol" &&
      CONTRACT_CHANGE_CATEGORIES.has(change.category)
    ) {
      internalChanges += 1;
    }
    if (isContractChange(change)) publicApiChanges += 1;
    if (change.visibility !== "internal") publicChangeIds.add(change.id);
    if (change.risk === "potentially-breaking") potentiallyBreaking += 1;
    else if (change.risk === "review-required") reviewRequired += 1;
    else informational += 1;
  }
  return {
    totalChanges: changes.length,
    publicApiChanges,
    potentiallyBreaking,
    reviewRequired,
    informational,
    unmapped: documentation.filter(
      (impact) => impact.unmapped && publicChangeIds.has(impact.changeId),
    ).length,
    byCategory,
    ...(hasVisibility ? { internalChanges } : {}),
  };
}

/**
 * Digests the canonical semantic-impact payload shared across plan surfaces.
 *
 * @param input - Snapshot descriptors, impact data, and ignored-file counts.
 * @returns The payload's lowercase SHA-256 digest.
 */
export function digestImpactPayload(input: {
  base: SnapshotDescriptor;
  head: SnapshotDescriptor;
  summary: ImpactSummary;
  changes: SymbolChange[];
  documentation: DocumentationImpact[];
  ignored: ImpactPlan["ignored"];
}): string {
  return sha256Hex(
    canonicalStringify({
      base: input.base,
      head: input.head,
      summary: input.summary,
      changes: input.changes,
      documentation: input.documentation,
      ignored: input.ignored,
    }),
  );
}

function compareSymbol(
  changes: SymbolChange[],
  before: ParserSymbolSnapshot,
  after: ParserSymbolSnapshot,
  path: string,
): void {
  if (before.contractFingerprint !== after.contractFingerprint) {
    const changedContractFacets = FACETS.filter(
      (facet) => before.contractFacets[facet] !== after.contractFacets[facet],
    ).sort();
    changes.push(
      createChange({
        scope: "symbol",
        category: "contract-changed",
        // Conservative arity rule: adding required inputs or removing accepted
        // inputs is potentially breaking; renames and type changes remain review-only.
        risk:
          before.arity !== undefined &&
          after.arity !== undefined &&
          (after.arity.required > before.arity.required ||
            after.arity.total < before.arity.total)
            ? "potentially-breaking"
            : "review-required",
        language: after.language,
        path,
        kind: after.kind,
        qualifiedName: after.qualifiedName,
        changedContractFacets,
        before: before.signature,
        after: after.signature,
        ...(after.arity === undefined ? {} : { arity: after.arity }),
      }),
    );
    return;
  }
  if (before.implementationFingerprint !== after.implementationFingerprint) {
    changes.push(
      createChange({
        scope: "symbol",
        category: "implementation-changed",
        risk: "informational",
        language: after.language,
        path,
        kind: after.kind,
        qualifiedName: after.qualifiedName,
      }),
    );
  } else if (
    before.documentationFingerprint !== after.documentationFingerprint
  ) {
    changes.push(
      createChange({
        scope: "symbol",
        category: "documentation-changed",
        risk: "informational",
        language: after.language,
        path,
        kind: after.kind,
        qualifiedName: after.qualifiedName,
      }),
    );
  }
}

function addAll(
  changes: SymbolChange[],
  symbols: ParserSymbolSnapshot[],
  path: string | undefined,
  category: "added" | "removed",
): void {
  for (const symbol of symbols) addOne(changes, symbol, path, category);
}

function addOne(
  changes: SymbolChange[],
  symbol: ParserSymbolSnapshot,
  path: string | undefined,
  category: "added" | "removed",
): void {
  changes.push(
    createChange({
      scope: "symbol",
      category,
      risk: category === "removed" ? "potentially-breaking" : "informational",
      language: symbol.language,
      path: path ?? "",
      ...(symbol.arity === undefined ? {} : { arity: symbol.arity }),
      kind: symbol.kind,
      qualifiedName: symbol.qualifiedName,
      ...(category === "added"
        ? { after: symbol.signature }
        : { before: symbol.signature }),
    }),
  );
}

export function createChange(
  value: Omit<SymbolChange, "id" | "digest"> & { id?: string },
): SymbolChange {
  const id =
    value.id ??
    (value.scope === "module"
      ? `${value.language}:${value.path}#module`
      : `${value.language}:${value.path}#${value.kind}:${value.qualifiedName ?? ""}`);
  const payload = { ...value, id };
  return { ...payload, digest: sha256Hex(canonicalStringify(payload)) };
}

function symbolId(path: string, symbol: ParserSymbolSnapshot): string {
  return `${symbol.language}:${path}#${symbol.kind}:${symbol.qualifiedName}`;
}

function symbolKey(symbol: ParserSymbolSnapshot): string {
  return `${symbol.kind}:${symbol.qualifiedName}`;
}

function indexSymbols(
  symbols: ParserSymbolSnapshot[],
): Map<string, ParserSymbolSnapshot> {
  return new Map(symbols.map((symbol) => [symbolKey(symbol), symbol]));
}

function identicalSymbols(
  previous: ParserSymbolSnapshot,
  current: ParserSymbolSnapshot,
): boolean {
  return (
    previous.language === current.language &&
    previous.contractFingerprint === current.contractFingerprint &&
    previous.implementationFingerprint === current.implementationFingerprint &&
    previous.documentationFingerprint === current.documentationFingerprint &&
    FACETS.every(
      (facet) =>
        previous.contractFacets[facet] === current.contractFacets[facet],
    )
  );
}

function compareImpactChanges(a: SymbolChange, b: SymbolChange): number {
  return (
    (CATEGORY_PRIORITY.get(a.category) ?? Number.MAX_SAFE_INTEGER) -
      (CATEGORY_PRIORITY.get(b.category) ?? Number.MAX_SAFE_INTEGER) ||
    compareChangeKeys(a, b)
  );
}
