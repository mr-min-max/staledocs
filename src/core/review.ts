import type { PlanningConfig } from "../config/planning";
import type { SuppressionConfig } from "../config/suppressions";
import { getChangedFiles } from "../git/history";
import { createImpactPlan } from "../impact/planner";
import type { SymbolChange } from "../impact/types";
import {
  REVIEW_SCHEMA_VERSION,
  type ReviewReport,
  type ReviewReportChange,
  type ReviewReportDocument,
} from "../output/review";
import { assessDocumentationFreshness } from "./freshness";

export interface ReviewReportOptions {
  readonly base?: string;
  readonly head?: string;
  /** Caller-loaded planning configuration; the planner reads it from cwd when omitted. */
  readonly planningConfig?: Readonly<PlanningConfig>;
  /** Caller-loaded suppressions; the planner reads the repository file when omitted. */
  readonly suppressions?: Readonly<SuppressionConfig>;
  /** Lists changed paths between two refs, or from a ref to the working tree. */
  readonly changedFiles?: (
    fromRef: string,
    toRef: string | undefined,
  ) => Promise<readonly string[]>;
}

/** Builds the deterministic review report from a plan and freshness assessments. */
export async function buildReviewReport(
  options: ReviewReportOptions,
  cwd: string,
): Promise<ReviewReport> {
  const planning = await createImpactPlan({
    cwd,
    base: options.base,
    head: options.head,
    planningConfig: options.planningConfig,
    suppressions: options.suppressions,
  });
  const plan = planning.plan;
  const listChangedFiles =
    options.changedFiles ??
    ((fromRef: string, toRef: string | undefined) =>
      getChangedFiles(fromRef, toRef, cwd));
  const changedFiles = await listChangedFiles(
    plan.base.commit ?? plan.base.label,
    plan.head.type === "working-tree"
      ? undefined
      : (plan.head.commit ?? plan.head.label),
  );
  const publicChanges = plan.changes
    .filter(isReviewChange)
    .filter(
      (change): change is typeof change & { qualifiedName: string } =>
        change.qualifiedName !== undefined,
    )
    .map(
      (change): ReviewReportChange => ({
        id: change.id,
        qualifiedName: change.qualifiedName,
        kind: change.kind,
        category: change.category,
        risk: change.risk,
        path: change.path,
        ...(change.before === undefined ? {} : { before: change.before }),
        ...(change.after === undefined ? {} : { after: change.after }),
        ...(change.changedContractFacets === undefined
          ? {}
          : { changedContractFacets: [...change.changedContractFacets] }),
      }),
    );

  const changesById = new Map(
    plan.changes.map((change) => [change.id, change]),
  );
  const directReferenceFiles = new Set<string>();
  const directlyMapped = new Set<string>();
  const mappedMemberRoots = new Set<string>();
  const reviewImpactNames = new Map<
    string,
    { qualifiedName: string; kind: SymbolChange["kind"] }
  >();
  for (const impact of plan.documentation) {
    const change = changesById.get(impact.changeId);
    if (
      change?.qualifiedName === undefined ||
      change.visibility === "internal"
    ) {
      continue;
    }
    if (isReviewChange(change)) {
      reviewImpactNames.set(impact.changeId, {
        qualifiedName: change.qualifiedName,
        kind: change.kind,
      });
    }
    if (impact.directReferences.length > 0) {
      directlyMapped.add(change.qualifiedName);
      const separator = change.qualifiedName.indexOf(".");
      if (separator > 0) {
        mappedMemberRoots.add(change.qualifiedName.slice(0, separator));
      }
    }
    for (const reference of impact.directReferences) {
      directReferenceFiles.add(reference.file);
    }
  }
  const unmapped = new Set<string>();
  for (const { qualifiedName, kind } of reviewImpactNames.values()) {
    if (directlyMapped.has(qualifiedName)) continue;
    if (
      (kind === "class" || kind === "interface") &&
      mappedMemberRoots.has(qualifiedName)
    ) {
      continue;
    }
    unmapped.add(qualifiedName);
  }

  const documents: ReviewReportDocument[] = [];
  for (const path of [...directReferenceFiles].sort(compareStrings)) {
    const freshness = assessDocumentationFreshness({
      plan,
      changedFiles,
      target: path,
      targetExists: true,
    });
    if (freshness.status !== "stale" && freshness.status !== "co-changed") {
      continue;
    }
    documents.push({
      path,
      status: freshness.status,
      sections: freshness.sections,
    });
  }

  const breaking = publicChanges.filter(
    (change) => change.risk === "potentially-breaking",
  ).length;
  const staleDocuments = documents.filter(
    (document) => document.status === "stale",
  ).length;
  const coChangedDocuments = documents.filter(
    (document) => document.status === "co-changed",
  ).length;
  const suppressed = planning.suppressed;
  const report: ReviewReport = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    base: plan.base,
    head: plan.head,
    summary: {
      publicApiChanges: publicChanges.length,
      breaking,
      staleDocuments,
      coChangedDocuments,
      unmappedSymbols: unmapped.size,
      suppressed: plan.ignored.suppressed,
      ...(plan.summary.internalChanges === undefined
        ? {}
        : { internalChanges: plan.summary.internalChanges }),
    },
    changes: publicChanges,
    documents,
    unmapped: [...unmapped].sort(compareStrings),
    suppressed: suppressed
      .map(({ symbol, reason }) => ({
        symbol,
        ...(reason === undefined ? {} : { reason }),
      }))
      .sort((left, right) => compareStrings(left.symbol, right.symbol)),
    ...(plan.boundary === undefined ? {} : { boundary: plan.boundary }),
    ...(plan.ignored.notAnalyzed === undefined
      ? {}
      : {
          notAnalyzed: plan.ignored.notAnalyzed.map(({ path, reason }) => ({
            path,
            reason,
          })),
        }),
    verdict: breaking > 0 ? "breaking" : staleDocuments > 0 ? "stale" : "clean",
  };
  return report;
}

function isReviewChange(change: SymbolChange): boolean {
  return (
    change.scope === "symbol" &&
    change.visibility !== "internal" &&
    (change.category === "added" ||
      change.category === "exposed" ||
      change.category === "removed" ||
      change.category === "hidden" ||
      change.category === "moved" ||
      change.category === "contract-changed")
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
