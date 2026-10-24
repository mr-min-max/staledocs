import { posix as pathPosix } from "node:path";

export const IMPACT_PLAN_SCHEMA_VERSION = "aidoc.impact-plan.v1" as const;
export const IMPACT_CONTEXT_SCHEMA_VERSION = "aidoc.impact-context.v1" as const;
export const DEFAULT_MAX_CONTEXT_BYTES = 12000;
export const MIN_MAX_CONTEXT_BYTES = 1024;
export const MAX_MAX_CONTEXT_BYTES = 1048576;

export type ImpactLanguage = "typescript" | "python";
export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "variable";
export type ContractFacet =
  | "parameters"
  | "return"
  | "inheritance"
  | "members"
  | "modifiers";
export type ChangeCategory =
  | "added"
  | "exposed"
  | "removed"
  | "hidden"
  | "moved"
  | "contract-changed"
  | "implementation-changed"
  | "documentation-changed"
  | "dependency-changed";
export type ChangeRisk =
  | "potentially-breaking"
  | "review-required"
  | "informational";
export type SymbolVisibility = "public" | "internal";

export interface ReexportEdge {
  /** Module specifier as written, relative specifiers only. */
  specifier: string;
  /** Undefined means `export * from`; otherwise consumer-visible and local names. */
  names?: { exported: string; local: string }[];
}

export interface SnapshotDescriptor {
  type: "git" | "working-tree";
  label: string;
  commit?: string;
}

export interface SymbolChange {
  scope: "symbol" | "module";
  id: string;
  beforeId?: string;
  afterId?: string;
  category: ChangeCategory;
  risk: ChangeRisk;
  language: ImpactLanguage;
  path: string;
  kind: SymbolKind | "module";
  qualifiedName?: string;
  changedContractFacets?: ContractFacet[];
  /** Value-bearing one-line signature rendered from the AST. Never raw source text. */
  before?: string;
  /** Signature at the head revision. */
  after?: string;
  /** Callable arity at the head revision, or at the base revision when removed. */
  arity?: { required: number; total: number };
  /** Reachability through the package boundary, when one was resolved. */
  visibility?: SymbolVisibility;
  digest: string;
}

/** Categories that change a symbol's contract or its public visibility. */
export const CONTRACT_CHANGE_CATEGORIES: ReadonlySet<ChangeCategory> = new Set([
  "added",
  "exposed",
  "removed",
  "hidden",
  "moved",
  "contract-changed",
]);

/** Returns whether a public symbol change can make documentation stale. */
export function isContractChange(
  change: SymbolChange,
): change is SymbolChange & { qualifiedName: string } {
  return (
    change.scope === "symbol" &&
    change.visibility !== "internal" &&
    change.qualifiedName !== undefined &&
    CONTRACT_CHANGE_CATEGORIES.has(change.category)
  );
}

export interface DocumentationReference {
  file: string;
  section: string;
  slug: string;
  reason:
    | "code-span"
    | "source-link"
    | "heading"
    | "api-documentation"
    | "changelog"
    | "entrypoint"
    | "architecture";
}

export interface DocumentationImpact {
  changeId: string;
  directReferences: DocumentationReference[];
  recommendations: DocumentationReference[];
  unmapped: boolean;
}

export interface ImpactSummary {
  totalChanges: number;
  publicApiChanges: number;
  potentiallyBreaking: number;
  reviewRequired: number;
  informational: number;
  unmapped: number;
  byCategory: Record<ChangeCategory, number>;
  /** Changes hidden because they are unreachable from a resolved entry. */
  internalChanges?: number;
}

export interface ContextBudgetReport {
  maxBytes: number;
  usedBytes: number;
  totalRecords: number;
  includedRecords: number;
  omittedRecords: number;
  impactDigest: string;
}
export interface LanguageBoundaryReport {
  mode: "entry" | "fallback";
  entries: string[];
  reason?:
    | "no-manifest"
    | "no-entry-field"
    | "entry-not-found"
    | "unsupported-entry"
    | "limit-exceeded";
  filesRead: number;
}

export interface BoundaryReport {
  typescript?: LanguageBoundaryReport;
  python?: LanguageBoundaryReport;
}

export interface ImpactPlan {
  schemaVersion: typeof IMPACT_PLAN_SCHEMA_VERSION;
  base: SnapshotDescriptor;
  head: SnapshotDescriptor;
  summary: ImpactSummary;
  changes: SymbolChange[];
  documentation: DocumentationImpact[];
  context: ContextBudgetReport;
  ignored: {
    unsupported: number;
    excluded: number;
    suppressed: number;
    notAnalyzed?: {
      path: string;
      reason: "commonjs" | "unsupported";
    }[];
    documentationLimitReached?: boolean;
  };
  boundary?: BoundaryReport;
  digest: string;
}

export interface ImpactProviderContext {
  schemaVersion: typeof IMPACT_CONTEXT_SCHEMA_VERSION;
  impactDigest: string;
  summary: ImpactSummary;
  changes: ImpactProviderChange[];
  documentation: DocumentationImpact[];
  omittedRecords: number;
}

export type ImpactProviderChange =
  | (Pick<
      SymbolChange,
      | "id"
      | "category"
      | "risk"
      | "path"
      | "kind"
      | "qualifiedName"
      | "changedContractFacets"
    > & {
      before?: string;
      after?: string;
      compacted?: false;
    })
  | {
      id: string;
      category: ChangeCategory;
      risk: ChangeRisk;
      kind: SymbolKind | "module";
      compacted: true;
    };

export type PlanErrorCode =
  | "PLAN_NOT_GIT_REPOSITORY"
  | "PLAN_BASE_NOT_FOUND"
  | "PLAN_HEAD_NOT_FOUND"
  | "PLAN_INVALID_REF"
  | "PLAN_SHALLOW_HISTORY"
  | "PLAN_UNSAFE_WORKTREE_PATH"
  | "PLAN_SOURCE_READ_FAILED"
  | "PLAN_PARSE_FAILED"
  | "PLAN_INVALID_CONTEXT_BUDGET";

export const PLAN_ERROR_CODES: ReadonlySet<PlanErrorCode> = new Set([
  "PLAN_NOT_GIT_REPOSITORY",
  "PLAN_BASE_NOT_FOUND",
  "PLAN_HEAD_NOT_FOUND",
  "PLAN_INVALID_REF",
  "PLAN_SHALLOW_HISTORY",
  "PLAN_UNSAFE_WORKTREE_PATH",
  "PLAN_SOURCE_READ_FAILED",
  "PLAN_PARSE_FAILED",
  "PLAN_INVALID_CONTEXT_BUDGET",
]);

export interface PlanError {
  code: PlanErrorCode;
  message: string;
  path?: string;
}

export type PlanCommandResult =
  | { ok: true; plan: ImpactPlan }
  | { ok: false; error: PlanError };

export interface ImpactPlanningResult {
  plan: ImpactPlan;
  providerContext: ImpactProviderContext;
  suppressed: { symbol: string; reason?: string }[];
}

export interface ParserModuleSnapshot {
  language: ImpactLanguage;
  dependencyFingerprint: string;
  symbols: ParserSymbolSnapshot[];
  /** Static relative re-exports. */
  reexports?: ReexportEdge[];
  /** Static Python `__all__`, when it is a literal string list or tuple. */
  dunderAll?: string[];
  /** Consumer export names mapped to parser symbol roots. */
  exports?: { exported: string; symbol: string }[];
  /** JavaScript or TypeScript module syntax detected through the AST. */
  moduleSystem?: "esm" | "commonjs" | "none";
}

export interface ParserSymbolSnapshot {
  language: ImpactLanguage;
  kind: SymbolKind;
  qualifiedName: string;
  /** Value-bearing one-line signature rendered from the AST. Never raw source text. */
  signature: string;
  /** Callables only. Required = parameters without default/optional/rest. */
  arity?: { required: number; total: number };
  contractFacets: Partial<Record<ContractFacet, string | null>>;
  contractFingerprint: string;
  implementationFingerprint: string;
  documentationFingerprint: string | null;
  /** Set by the planner after boundary resolution; parsers leave it undefined. */
  visibility?: SymbolVisibility;
}

const PLAN_FAILURE_PAYLOADS = new WeakMap<object, Readonly<PlanError>>();

/** Carries a stable planning failure code with an optional safe relative path. */
export class PlanFailure extends Error {
  readonly code: PlanErrorCode;
  declare readonly path?: string;

  constructor(code: PlanErrorCode, message: string, path?: string) {
    super(message);
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "PlanFailure",
      writable: true,
    });
    this.code = code;
    Object.defineProperty(this, "message", {
      configurable: true,
      enumerable: true,
      value: message,
      writable: true,
    });

    const normalizedPath = normalizeRelativePath(path);
    if (normalizedPath !== undefined) this.path = normalizedPath;

    PLAN_FAILURE_PAYLOADS.set(
      this,
      Object.freeze({
        code,
        message,
        ...(normalizedPath === undefined ? {} : { path: normalizedPath }),
      }),
    );
  }

  /** Returns the sanitized payload only when the error is an authentic PlanFailure. */
  static read(error: unknown): PlanError | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const payload = PLAN_FAILURE_PAYLOADS.get(error);
    return payload === undefined ? undefined : { ...payload };
  }
}

function normalizeRelativePath(path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0 || hasControlCharacter(path)) {
    return undefined;
  }

  const slashPath = path.replace(/\\/gu, "/");
  if (slashPath.startsWith("/") || /^[A-Za-z]:\//u.test(slashPath)) {
    return undefined;
  }

  const normalized = pathPosix.normalize(slashPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return undefined;
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}
