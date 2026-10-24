import * as fs from "node:fs";
import * as path from "node:path";
import { getChangedFiles, getGitRoot } from "../git/history";
import { createImpactPlan, discoverReadme } from "../impact/planner";
import { toPlanError } from "../impact/canonical";
import { isContractChange, type ImpactPlan } from "../impact/types";

export type DocumentationCheckStatus =
  | "clean"
  | "co-changed"
  | "stale"
  | "missing"
  | "unknown";

export interface StaleSection {
  section: string;
  slug: string;
  symbols: string[];
}

export interface FreshnessReport {
  status: DocumentationCheckStatus;
  target: string;
  targetChanged: boolean;
  /** Changed public symbols that this document mentions (direct references). */
  referencedSymbols: string[];
  /** Sections that mention changed symbols; empty unless status is stale/co-changed. */
  sections: StaleSection[];
  /** Changed public symbols not mentioned anywhere in discovered documentation. */
  unmappedSymbols: string[];
  /** Kept for compatibility with the old report: AST-backed changed source paths. */
  sourceFiles: string[];
  message: string;
}

/** Normalizes repository-relative documentation paths without changing case. */
export function normalizeDocPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

/** Builds a freshness report from the shared deterministic impact plan. */
export function assessDocumentationFreshness(input: {
  plan: ImpactPlan;
  changedFiles: readonly string[];
  target: string;
  targetExists: boolean;
}): FreshnessReport {
  const target = normalizeDocPath(input.target);
  const changedFiles = input.changedFiles.map(normalizeDocPath);
  const targetChanged = changedFiles.includes(target);
  const symbolChanges = new Map(
    input.plan.changes
      .filter(isContractChange)
      .map((change) => [change.id, change]),
  );
  const referencesBySection = new Map<
    string,
    { section: string; slug: string; symbols: Set<string> }
  >();
  const referencedSymbols = new Set<string>();

  for (const impact of input.plan.documentation) {
    const change = symbolChanges.get(impact.changeId);
    if (change?.qualifiedName === undefined) continue;
    for (const reference of impact.directReferences) {
      if (normalizeDocPath(reference.file) !== target) continue;
      referencedSymbols.add(change.qualifiedName);
      const key = `${reference.slug}\u0000${reference.section}`;
      const section = referencesBySection.get(key) ?? {
        section: reference.section,
        slug: reference.slug,
        symbols: new Set<string>(),
      };
      section.symbols.add(change.qualifiedName);
      referencesBySection.set(key, section);
    }
  }

  const mappedMemberRoots = new Set<string>();
  for (const impact of input.plan.documentation) {
    if (impact.directReferences.length === 0) continue;
    const qualifiedName = symbolChanges.get(impact.changeId)?.qualifiedName;
    if (qualifiedName === undefined) continue;
    const separator = qualifiedName.indexOf(".");
    if (separator > 0) mappedMemberRoots.add(qualifiedName.slice(0, separator));
  }
  const unmappedSymbols: string[] = [];
  for (const impact of input.plan.documentation) {
    if (impact.directReferences.length > 0) continue;
    const change = symbolChanges.get(impact.changeId);
    if (change?.qualifiedName === undefined) continue;
    if (
      (change.kind === "class" || change.kind === "interface") &&
      mappedMemberRoots.has(change.qualifiedName)
    ) {
      continue;
    }
    unmappedSymbols.push(change.qualifiedName);
  }
  const sourceFiles = [
    ...new Set(
      [...symbolChanges.values()].map((change) =>
        normalizeDocPath(change.path),
      ),
    ),
  ].sort(compareStrings);
  const referenced = [...referencedSymbols].sort(compareStrings);
  const unmapped = [...new Set(unmappedSymbols)].sort(compareStrings);
  const sections = [...referencesBySection.values()]
    .map((section) => ({
      section: section.section,
      slug: section.slug,
      symbols: [...section.symbols].sort(compareStrings),
    }))
    .sort(
      (left, right) =>
        compareStrings(left.slug, right.slug) ||
        compareStrings(left.section, right.section),
    );

  if (!input.targetExists) {
    return {
      status: "missing",
      target,
      targetChanged,
      referencedSymbols: referenced,
      sections: [],
      unmappedSymbols: unmapped,
      sourceFiles,
      message: `Documentation target is missing: ${target}`,
    };
  }

  if (referenced.length === 0) {
    return {
      status: "clean",
      target,
      targetChanged,
      referencedSymbols: [],
      sections: [],
      unmappedSymbols: unmapped,
      sourceFiles,
      message: `No changed public symbol is mentioned in ${target}`,
    };
  }

  if (!targetChanged) {
    return {
      status: "stale",
      target,
      targetChanged,
      referencedSymbols: referenced,
      sections,
      unmappedSymbols: unmapped,
      sourceFiles,
      message: `${target}: ${sections.length} sections mention changed public symbols and were not updated (${sections
        .map((section) => `${section.section}: ${section.symbols.join(", ")}`)
        .join("; ")})`,
    };
  }

  return {
    status: "co-changed",
    target,
    targetChanged,
    referencedSymbols: referenced,
    sections,
    unmappedSymbols: unmapped,
    sourceFiles,
    message: `${target} changed with the ${referenced.length} public symbol${referenced.length === 1 ? "" : "s"} it mentions; content correctness was not verified`,
  };
}

/** Runs plan-backed freshness and sanitizes operational failures. */
export async function checkDocumentationFreshness(
  cwd: string,
  target: string | undefined,
  since: string,
  to = "HEAD",
): Promise<FreshnessReport> {
  try {
    const root = await getGitRoot(cwd);
    const planning = await createImpactPlan({
      cwd,
      base: since,
      head: to === "HEAD" ? undefined : to,
    });
    const discovered =
      target === undefined ? await discoverReadme(root) : undefined;
    const requestedTarget =
      target === undefined ? (discovered ?? "README.md") : target;
    const absoluteTarget = path.resolve(root, requestedTarget);
    const relativeTarget = normalizeDocPath(
      path.relative(root, absoluteTarget),
    );
    const changedFiles = await getChangedFiles(
      since,
      to === "HEAD" ? undefined : to,
      cwd,
    );
    return assessDocumentationFreshness({
      plan: planning.plan,
      changedFiles,
      target: relativeTarget,
      targetExists: fs.existsSync(absoluteTarget),
    });
  } catch (error: unknown) {
    const planError = toPlanError(error);
    return {
      status: "unknown",
      target: normalizeDocPath(target ?? "README.md"),
      targetChanged: false,
      referencedSymbols: [],
      sections: [],
      unmappedSymbols: [],
      sourceFiles: [],
      message: `Could not evaluate documentation freshness: ${planError.message}`,
    };
  }
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
