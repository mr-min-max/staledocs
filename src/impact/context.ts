import { posix as pathPosix } from "node:path";
import { sanitizeDiagnostic } from "../security/scanner";
import { canonicalStringify } from "./canonical";
import {
  IMPACT_CONTEXT_SCHEMA_VERSION,
  MAX_MAX_CONTEXT_BYTES,
  MIN_MAX_CONTEXT_BYTES,
  PlanFailure,
  type ChangeCategory,
  type ChangeRisk,
  type ContractFacet,
  type ContextBudgetReport,
  type DocumentationImpact,
  type DocumentationReference,
  type ImpactProviderChange,
  type ImpactProviderContext,
  type ImpactSummary,
  type SymbolChange,
  type SymbolKind,
} from "./types";

const CATEGORY_PRIORITY: Readonly<Record<ChangeCategory, number>> = {
  removed: 0,
  hidden: 1,
  "contract-changed": 2,
  moved: 3,
  added: 4,
  exposed: 5,
  "dependency-changed": 6,
  "implementation-changed": 7,
  "documentation-changed": 8,
};

const CATEGORIES: readonly ChangeCategory[] = [
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

const RISKS: readonly ChangeRisk[] = [
  "potentially-breaking",
  "review-required",
  "informational",
];

const KINDS: readonly (SymbolKind | "module")[] = [
  "function",
  "class",
  "method",
  "interface",
  "type",
  "enum",
  "variable",
  "module",
];

const CONTRACT_FACETS: readonly ContractFacet[] = [
  "parameters",
  "return",
  "inheritance",
  "members",
  "modifiers",
  "constructor",
];

const DOCUMENTATION_REASONS: readonly DocumentationReference["reason"][] = [
  "code-span",
  "source-link",
  "heading",
  "api-documentation",
  "changelog",
  "entrypoint",
  "architecture",
];

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const DIAGNOSTIC_PREFIX_PATTERN =
  /^(?:fatal|error|warning|hint|usage|git|command failed):(?:\s|$)/iu;
const POSIX_ABSOLUTE_PATH_SHAPE = /(?:^|\s|:|=|\(|\[|\{|["'`])\/[^/\s]/u;
const WINDOWS_ABSOLUTE_PATH_SHAPE = /[A-Za-z]:[\\/][^\s]/u;

interface ProjectedChangeCandidate {
  documentationKey?: string;
  full?: ImpactProviderChange;
  compact?: ImpactProviderChange;
  priority: number;
  sortPath: string;
  sortKind: string;
  sortQualifiedName: string;
  sortCategory: string;
  sortId: string;
}

/**
 * Projects semantic impact into a deterministic provider context byte budget.
 *
 * Higher-priority records are retained first, with compact forms used when the
 * full record does not fit. The returned report accounts for every input change.
 *
 * @param input - Validated impact data and the maximum serialized byte count.
 * @returns The bounded provider context and its inclusion report.
 * @throws {PlanFailure} When the budget or projected payload is invalid.
 */
export function buildImpactContext(input: {
  impactDigest: string;
  summary: ImpactSummary;
  changes: SymbolChange[];
  documentation: DocumentationImpact[];
  maxBytes: number;
}): {
  providerContext: ImpactProviderContext;
  report: ContextBudgetReport;
} {
  validateBudget(input.maxBytes);

  if (!isSha256Hex(input.impactDigest)) invalidContextPayload();
  if (!Array.isArray(input.changes)) invalidContextPayload();
  if (!Array.isArray(input.documentation)) invalidContextPayload();

  const impactDigest = input.impactDigest;
  const summary = projectSummary(input.summary);
  const totalRecords = input.changes.length;
  let providerContext = createContext(
    impactDigest,
    summary,
    [],
    [],
    totalRecords,
  );
  ensureFits(providerContext, input.maxBytes);

  const documentationByChange = indexDocumentation(input.documentation);
  const orderedChanges = input.changes
    .map(projectChangeCandidate)
    .filter(
      (candidate): candidate is ProjectedChangeCandidate =>
        candidate !== undefined,
    )
    .sort(compareContextChanges);

  for (const change of orderedChanges) {
    if (change.full !== undefined) {
      const fullDocumentation = projectMatchingDocumentation(
        change.documentationKey === undefined
          ? []
          : (documentationByChange.get(change.documentationKey) ?? []),
        change.full.id,
      );
      const fullCandidate = appendRecord(
        providerContext,
        change.full,
        fullDocumentation,
        totalRecords,
      );
      if (fits(fullCandidate, input.maxBytes)) {
        providerContext = fullCandidate;
        continue;
      }
    }

    if (change.compact === undefined) continue;
    const compactDocumentation = projectMatchingDocumentation(
      change.documentationKey === undefined
        ? []
        : (documentationByChange.get(change.documentationKey) ?? []),
      change.compact.id,
    );
    const compactCandidate = appendRecord(
      providerContext,
      change.compact,
      compactDocumentation,
      totalRecords,
    );
    if (fits(compactCandidate, input.maxBytes)) {
      providerContext = compactCandidate;
    }
  }

  const usedBytes = serializedBytes(providerContext);
  const includedRecords = providerContext.changes.length;
  return {
    providerContext,
    report: {
      maxBytes: input.maxBytes,
      usedBytes,
      totalRecords,
      includedRecords,
      omittedRecords: totalRecords - includedRecords,
      impactDigest,
    },
  };
}

function validateBudget(maxBytes: number): void {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < MIN_MAX_CONTEXT_BYTES ||
    maxBytes > MAX_MAX_CONTEXT_BYTES
  ) {
    throw new PlanFailure(
      "PLAN_INVALID_CONTEXT_BUDGET",
      "The provider context byte budget is invalid.",
    );
  }
}

function ensureFits(context: ImpactProviderContext, maxBytes: number): void {
  if (!fits(context, maxBytes)) {
    throw new PlanFailure(
      "PLAN_INVALID_CONTEXT_BUDGET",
      "The provider context byte budget cannot fit its mandatory envelope.",
    );
  }
}

function createContext(
  impactDigest: string,
  summary: ImpactSummary,
  changes: ImpactProviderChange[],
  documentation: DocumentationImpact[],
  omittedRecords: number,
): ImpactProviderContext {
  return {
    schemaVersion: IMPACT_CONTEXT_SCHEMA_VERSION,
    impactDigest,
    summary,
    changes,
    documentation,
    omittedRecords,
  };
}

function appendRecord(
  context: ImpactProviderContext,
  change: ImpactProviderChange,
  documentation: DocumentationImpact[],
  totalRecords: number,
): ImpactProviderContext {
  const changes = [...context.changes, change];
  return createContext(
    context.impactDigest,
    context.summary,
    changes,
    [...context.documentation, ...documentation],
    totalRecords - changes.length,
  );
}

function fits(context: ImpactProviderContext, maxBytes: number): boolean {
  return serializedBytes(context) <= maxBytes;
}

function serializedBytes(context: ImpactProviderContext): number {
  return Buffer.byteLength(canonicalStringify(context), "utf8");
}

function compareContextChanges(
  a: ProjectedChangeCandidate,
  b: ProjectedChangeCandidate,
): number {
  return (
    a.priority - b.priority ||
    compareStrings(a.sortPath, b.sortPath) ||
    compareStrings(a.sortKind, b.sortKind) ||
    compareStrings(a.sortQualifiedName, b.sortQualifiedName) ||
    compareStrings(a.sortCategory, b.sortCategory) ||
    compareStrings(a.sortId, b.sortId)
  );
}

function projectChangeCandidate(
  change: SymbolChange,
): ProjectedChangeCandidate | undefined {
  if (change.visibility === "internal") return undefined;
  try {
    if (typeof change !== "object" || change === null) return undefined;

    const category = allowlisted(change.category, CATEGORIES);
    const risk = allowlisted(change.risk, RISKS);
    const kind = allowlisted(change.kind, KINDS);
    if (category === undefined || risk === undefined || kind === undefined) {
      return undefined;
    }

    const id = typeof change.id === "string" ? change.id : undefined;
    const path = typeof change.path === "string" ? change.path : undefined;
    const qualifiedName =
      change.qualifiedName === undefined
        ? undefined
        : typeof change.qualifiedName === "string"
          ? change.qualifiedName
          : null;
    const full =
      id !== undefined &&
      path !== undefined &&
      qualifiedName !== null &&
      isSafeIdentityText(id) &&
      isRepositoryRelativePath(path) &&
      (qualifiedName === undefined || isSafeIdentityText(qualifiedName))
        ? projectFullChange(
            change,
            id,
            category,
            risk,
            path,
            kind,
            qualifiedName,
          )
        : undefined;
    const compact = isSha256Hex(change.digest)
      ? {
          id: change.digest,
          category,
          risk,
          kind,
          compacted: true as const,
        }
      : undefined;
    if (full === undefined && compact === undefined) return undefined;

    return {
      ...(id === undefined ? {} : { documentationKey: id }),
      ...(full === undefined ? {} : { full }),
      ...(compact === undefined ? {} : { compact }),
      priority: CATEGORY_PRIORITY[category],
      sortPath: path ?? "",
      sortKind: kind,
      sortQualifiedName: qualifiedName ?? "",
      sortCategory: category,
      sortId: id ?? "",
    };
  } catch {
    return undefined;
  }
}

function projectFullChange(
  change: SymbolChange,
  id: string,
  category: ChangeCategory,
  risk: ChangeRisk,
  path: string,
  kind: SymbolKind | "module",
  qualifiedName: string | undefined,
): ImpactProviderChange {
  const facets = Array.isArray(change.changedContractFacets)
    ? change.changedContractFacets
        .map((facet) => allowlisted(facet, CONTRACT_FACETS))
        .filter((facet): facet is ContractFacet => facet !== undefined)
        .sort()
    : undefined;
  return {
    id,
    category,
    risk,
    path,
    kind,
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
    ...(facets === undefined ? {} : { changedContractFacets: facets }),
    ...(isSafeSignatureText(change.before) ? { before: change.before } : {}),
    ...(isSafeSignatureText(change.after) ? { after: change.after } : {}),
  };
}

function projectSummary(summary: ImpactSummary): ImpactSummary {
  try {
    if (typeof summary !== "object" || summary === null) {
      invalidContextPayload();
    }
    const byCategoryInput = summary.byCategory;
    if (typeof byCategoryInput !== "object" || byCategoryInput === null) {
      invalidContextPayload();
    }
    const byCategory = Object.fromEntries(
      CATEGORIES.map((category) => [
        category,
        requireCount(byCategoryInput[category]),
      ]),
    ) as Record<ChangeCategory, number>;
    return {
      totalChanges: requireCount(summary.totalChanges),
      publicApiChanges: requireCount(summary.publicApiChanges),
      potentiallyBreaking: requireCount(summary.potentiallyBreaking),
      reviewRequired: requireCount(summary.reviewRequired),
      informational: requireCount(summary.informational),
      unmapped: requireCount(summary.unmapped),
      byCategory,
      ...(summary.internalChanges === undefined
        ? {}
        : { internalChanges: requireCount(summary.internalChanges) }),
    };
  } catch (error) {
    if (PlanFailure.read(error) !== undefined) throw error;
    invalidContextPayload();
  }
}

function indexDocumentation(
  documentation: DocumentationImpact[],
): Map<string, DocumentationImpact[]> {
  const byChange = new Map<string, DocumentationImpact[]>();
  for (const impact of documentation) {
    try {
      if (
        typeof impact !== "object" ||
        impact === null ||
        typeof impact.changeId !== "string"
      ) {
        continue;
      }
      const matches = byChange.get(impact.changeId) ?? [];
      matches.push(impact);
      byChange.set(impact.changeId, matches);
    } catch {
      continue;
    }
  }
  return byChange;
}

function projectMatchingDocumentation(
  documentation: DocumentationImpact[],
  providerChangeId: string,
): DocumentationImpact[] {
  return documentation
    .map((impact) => projectDocumentation(impact, providerChangeId))
    .filter((impact): impact is DocumentationImpact => impact !== undefined)
    .sort(compareCanonical);
}

function projectDocumentation(
  impact: DocumentationImpact,
  providerChangeId: string,
): DocumentationImpact | undefined {
  try {
    if (typeof impact.unmapped !== "boolean") return undefined;
    return {
      changeId: providerChangeId,
      directReferences: projectReferences(impact.directReferences),
      recommendations: projectReferences(impact.recommendations),
      unmapped: impact.unmapped,
    };
  } catch {
    return undefined;
  }
}

function projectReferences(
  references: DocumentationReference[],
): DocumentationReference[] {
  if (!Array.isArray(references)) return [];
  return references
    .map(projectReference)
    .filter(
      (reference): reference is DocumentationReference =>
        reference !== undefined,
    )
    .sort(compareCanonical);
}

function projectReference(
  reference: DocumentationReference,
): DocumentationReference | undefined {
  try {
    if (typeof reference !== "object" || reference === null) return undefined;
    const reason = allowlisted(reference.reason, DOCUMENTATION_REASONS);
    if (
      !isRepositoryRelativePath(reference.file) ||
      !isSafeIdentityText(reference.section) ||
      !isSafeIdentityText(reference.slug) ||
      reason === undefined
    ) {
      return undefined;
    }
    return {
      file: reference.file,
      section: reference.section,
      slug: reference.slug,
      reason,
    };
  } catch {
    return undefined;
  }
}

function isRepositoryRelativePath(value: unknown): value is string {
  if (
    !isSafeIdentityText(value) ||
    value.includes("\\") ||
    value.length === 0
  ) {
    return false;
  }
  if (value.startsWith("/") || /^[A-Za-z]:\//u.test(value)) {
    return false;
  }
  const normalized = pathPosix.normalize(value);
  return (
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    normalized === value
  );
}

function isSafeSignatureText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const codePoints = Array.from(value);
  if (codePoints.length > 400) return false;
  for (const character of codePoints) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 31 ||
      codePoint === 127 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return false;
    }
  }
  return true;
}

function isSafeIdentityText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return false;
    }
  }
  if (
    sanitizeDiagnostic(value) !== value ||
    DIAGNOSTIC_PREFIX_PATTERN.test(value.trimStart()) ||
    POSIX_ABSOLUTE_PATH_SHAPE.test(value) ||
    WINDOWS_ABSOLUTE_PATH_SHAPE.test(value) ||
    value.includes("file://")
  ) {
    return false;
  }
  return true;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

function requireCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidContextPayload();
  }
  return value as number;
}

function allowlisted<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && allowed.some((item) => item === value)
    ? (value as T)
    : undefined;
}

function invalidContextPayload(): never {
  throw new PlanFailure(
    "PLAN_PARSE_FAILED",
    "The impact context payload is invalid.",
  );
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareCanonical(a: unknown, b: unknown): number {
  const left = canonicalStringify(a);
  const right = canonicalStringify(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
