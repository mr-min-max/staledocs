import { randomBytes } from "node:crypto";
import { posix as pathPosix } from "node:path";
import type { SuppressionConfig } from "../config/suppressions";
import type { PlanningConfig } from "../config/planning";
import { createImpactPlan } from "../impact/planner";
import {
  projectProviderContextForTarget,
  resolveDocumentationTargets,
  type DocumentationTargetCandidate,
  type ResolvedDocumentationTarget,
} from "../impact/targets";
import { sha256Hex } from "../impact/canonical";
import {
  MAX_MAX_CONTEXT_BYTES,
  MIN_MAX_CONTEXT_BYTES,
  PlanFailure,
  type ContextBudgetReport,
} from "../impact/types";
import { renderUpdateGenerationEnvelope } from "../core/update-preparation";
import { resolveTemplatesDir } from "../core/templates";
import {
  summarizeTextDiff,
  type SafeDiffSummary,
} from "../output/diff-summary";
import { validateMarkdown } from "../output/markdown";
import {
  TrustGateway,
  type ContextEnvelope,
  type TrustEvent,
} from "../security/gateway";
import {
  RepositoryWriteError,
  type FindingSummary,
  type TrustPolicy,
} from "../security/types";
import { RepositoryWriteScope } from "../security/repository-writer";
import {
  MCPRepositoryReadScope,
  type AuthorizedMCPDirectory,
} from "./repository-scope";
import { MCPScopedConfigLoader } from "./scoped-config";
import {
  MCP_PREPARATION_SCHEMA,
  MCPPreparationError,
  PreparationTokenCodec,
  type PreparationClaims,
} from "./preparation-token";

export const MCP_TARGET_REQUIRED = "MCP_TARGET_REQUIRED" as const;
const PREPARE_SCHEMA_VERSION = "aidoc.mcp-update-preparation.v1" as const;
const VALIDATION_SCHEMA_VERSION = "aidoc.mcp-draft-validation.v1" as const;
const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
export const PREPARATION_STORE_CAPACITY = 32;

export interface PreparationRecord {
  readonly claims: PreparationClaims;
  readonly token: string;
  readonly issuedAt: number;
}

/** Holds the newest preparation per normalized target, evicting the oldest past capacity. */
export class PreparationStore {
  readonly #records = new Map<string, PreparationRecord>();

  record(target: string, claims: PreparationClaims, token: string): void {
    this.#records.delete(target);
    this.#records.set(target, { claims, token, issuedAt: Date.now() });
    while (this.#records.size > PREPARATION_STORE_CAPACITY) {
      const oldest = this.#records.keys().next();
      if (oldest.done === true) break;
      this.#records.delete(oldest.value);
    }
  }

  latest(target: string): PreparationRecord | undefined {
    return this.#records.get(target);
  }

  clear(): void {
    this.#records.clear();
  }
}

export interface MCPUpdateWorkflowContext {
  readonly serverCwd: string;
  readonly tokenCodec: PreparationTokenCodec;
  readonly preparations: PreparationStore;
  readonly trustPolicy: TrustPolicy;
  readonly loadPlanningConfig: () => Promise<Readonly<PlanningConfig>>;
  readonly loadSuppressions?: () => Promise<SuppressionConfig>;
}

export interface PrepareDocumentationUpdateArguments {
  readonly base?: string;
  readonly head?: string;
  readonly max_context_bytes?: number;
  readonly target?: string;
}

export interface ValidateDocumentationDraftArguments {
  readonly preparation_digest?: string;
  readonly target: string;
  readonly candidate_markdown: string;
}

/** Indicates that a safe existing Markdown target must be selected explicitly. */
export class MCPTargetRequiredError extends Error {
  readonly code = MCP_TARGET_REQUIRED;
  readonly candidates: readonly string[];

  constructor(candidates: readonly string[]) {
    const safeCandidates = candidates.filter(isSafeRelativeMarkdownTarget);
    super(
      safeCandidates.length === 0
        ? "No safe existing Markdown target is available."
        : `Select one existing Markdown target: ${safeCandidates.join(", ")}.`,
    );
    this.name = "MCPTargetRequiredError";
    this.candidates = safeCandidates;
  }
}

const FALLBACK_CODEC = new PreparationTokenCodec(randomBytes(32));
const FALLBACK_PREPARATIONS = new PreparationStore();

/** Builds a workflow context with a per-server token codec, preparation store, and fresh config loader. */
export function createMCPUpdateWorkflowContext(
  serverCwd: string,
  tokenCodec = new PreparationTokenCodec(randomBytes(32)),
  trustPolicy = environmentTrustPolicy(),
  loadPlanningConfig: () => Promise<Readonly<PlanningConfig>> = () =>
    loadPlanningConfigForFreshScope(serverCwd),
  loadSuppressions?: () => Promise<SuppressionConfig>,
): MCPUpdateWorkflowContext {
  return {
    serverCwd,
    tokenCodec,
    preparations: new PreparationStore(),
    trustPolicy,
    loadPlanningConfig,
    loadSuppressions,
  };
}

/** Provides the bounded direct-call compatibility context for a server directory. */
export function defaultMCPUpdateWorkflowContext(
  serverCwd: string,
): MCPUpdateWorkflowContext {
  return {
    serverCwd,
    tokenCodec: FALLBACK_CODEC,
    preparations: FALLBACK_PREPARATIONS,
    trustPolicy: environmentTrustPolicy(),
    loadPlanningConfig: () => loadPlanningConfigForFreshScope(serverCwd),
  };
}

async function loadPlanningConfigForFreshScope(
  serverCwd: string,
): Promise<Readonly<PlanningConfig>> {
  const scope = await MCPRepositoryReadScope.open(serverCwd);
  const loader = new MCPScopedConfigLoader(scope);
  const directory: AuthorizedMCPDirectory = scope.rootDirectory();
  return loader.loadPlanning(directory);
}

/** Plans and inspects a repository update without writing files or calling a provider. */
export async function prepareDocumentationUpdate(
  args: unknown,
  context: MCPUpdateWorkflowContext,
): Promise<{
  schema_version: typeof PREPARE_SCHEMA_VERSION;
  preparation_digest: string;
  target: string;
  generation: { system_prompt: string; prompt: string };
  context: ContextBudgetReport;
  trust: TrustSummary;
  instructions: readonly string[];
}> {
  const options = readPrepareArguments(args);
  const planningConfig = await context.loadPlanningConfig();
  const planning = await createImpactPlan({
    cwd: context.serverCwd,
    base: options.base,
    head: options.head,
    maxContextBytes: options.max_context_bytes,
    planningConfig,
    suppressions:
      context.loadSuppressions === undefined
        ? undefined
        : await context.loadSuppressions(),
  });
  const scope = await RepositoryWriteScope.open(context.serverCwd);
  const targets = await resolveDocumentationTargets({
    plan: planning.plan,
    scope,
    explicitTargets:
      options.target === undefined ? undefined : [options.target],
  });

  if (targets.length !== 1) {
    throw new MCPTargetRequiredError(
      targets.map((target) => normalizedDisplayPath(target.path)),
    );
  }

  const target = targets[0];
  const targetPath = normalizedDisplayPath(target.path);
  const existingDoc = target.prepared.existingText;
  if (existingDoc === null) throw new MCPTargetRequiredError([]);

  const projectedContext = projectProviderContextForTarget(
    planning.providerContext,
    normalizedTargetCandidate(target),
  );
  const envelope = renderUpdateGenerationEnvelope({
    templatesDir: resolveTemplatesDir(),
    existingDoc,
    target: targetPath,
    impactPlan: projectedContext,
  });
  const inspected = inspectInput(context.trustPolicy, envelope, [
    context.serverCwd,
  ]);
  const claims: PreparationClaims = {
    schemaVersion: MCP_PREPARATION_SCHEMA,
    planDigest: planning.plan.digest,
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.head === undefined ? {} : { head: options.head }),
    maxContextBytes: planning.plan.context.maxBytes,
    target: targetPath,
    targetDigest: sha256Hex(existingDoc),
  };
  const preparationDigest = context.tokenCodec.issue(claims);
  context.preparations.record(targetPath, claims, preparationDigest);

  return {
    schema_version: PREPARE_SCHEMA_VERSION,
    preparation_digest: preparationDigest,
    target: targetPath,
    generation: {
      system_prompt: inspected.approved.systemPrompt,
      prompt: inspected.approved.prompt,
    },
    context: planning.plan.context,
    trust: inspected.summary,
    instructions: [
      "Generate only Markdown for the returned target from the approved generation input.",
      "Call validate_documentation_draft with the same target and the candidate_markdown. Do not copy preparation_digest into text.",
      "Write only after validation succeeds; this MCP workflow never writes the repository.",
    ],
  };
}

/** Rechecks preparation freshness and validates a candidate Markdown draft safely. */
export async function validateDocumentationDraft(
  args: unknown,
  context: MCPUpdateWorkflowContext,
): Promise<{
  schema_version: typeof VALIDATION_SCHEMA_VERSION;
  valid: boolean;
  target: string;
  approved_markdown?: string;
  markdown_warnings: readonly string[];
  diff: SafeDiffSummary;
  trust: TrustSummary;
}> {
  const options = readValidateArguments(args);
  // A supplied digest must verify on its own; the store never rescues a wrong one.
  const claims =
    options.preparationDigest !== undefined
      ? context.tokenCodec.verify(options.preparationDigest)
      : context.preparations.latest(options.target)?.claims;
  if (claims === undefined || options.target !== claims.target) {
    throw invalidPreparation();
  }

  const planningConfig = await context.loadPlanningConfig();
  const planning = await createImpactPlan({
    cwd: context.serverCwd,
    base: claims.base,
    head: claims.head,
    maxContextBytes: claims.maxContextBytes,
    planningConfig,
    suppressions:
      context.loadSuppressions === undefined
        ? undefined
        : await context.loadSuppressions(),
  });
  if (planning.plan.digest !== claims.planDigest) throw invalidPreparation();

  const scope = await RepositoryWriteScope.open(context.serverCwd);
  let target: ResolvedDocumentationTarget;
  try {
    const resolved = await resolveDocumentationTargets({
      plan: planning.plan,
      scope,
      explicitTargets: [claims.target],
    });
    if (resolved.length !== 1) throw invalidPreparation();
    target = resolved[0];
  } catch (error: unknown) {
    if (isStaleRepositoryError(error)) throw invalidPreparation();
    throw error;
  }

  const targetPath = normalizedDisplayPath(target.path);
  const existingDoc = target.prepared.existingText;
  if (
    targetPath !== claims.target ||
    existingDoc === null ||
    sha256Hex(existingDoc) !== claims.targetDigest
  ) {
    throw invalidPreparation();
  }

  const projectedContext = projectProviderContextForTarget(
    planning.providerContext,
    normalizedTargetCandidate(target),
  );
  const envelope = renderUpdateGenerationEnvelope({
    templatesDir: resolveTemplatesDir(),
    existingDoc,
    target: targetPath,
    impactPlan: projectedContext,
  });
  const inspected = inspectOutput(
    context.trustPolicy,
    envelope,
    options.candidateMarkdown,
    [context.serverCwd],
  );
  const markdown = validateMarkdown(inspected.approved);
  const diff = summarizeTextDiff(existingDoc, inspected.approved);

  return {
    schema_version: VALIDATION_SCHEMA_VERSION,
    valid: markdown.isValid,
    target: claims.target,
    ...(markdown.isValid ? { approved_markdown: inspected.approved } : {}),
    markdown_warnings: markdown.warnings,
    diff,
    trust: inspected.summary,
  };
}

interface TrustSummary {
  readonly policy: TrustPolicy;
  readonly action: TrustEvent["action"];
  readonly findings: readonly FindingSummary[];
}

function inspectInput(
  policy: TrustPolicy,
  envelope: ContextEnvelope,
  sensitivePaths: readonly string[],
): {
  approved: { systemPrompt: string; prompt: string };
  summary: TrustSummary;
} {
  let event: TrustEvent | undefined;
  const gateway = TrustGateway.forInspection({
    policy: privacyFloorPolicy(policy),
    origin: "mcp",
    sensitivePaths,
    onEvent: (candidate) => {
      if (candidate.stage === "input") event = candidate;
    },
  });
  const approved = gateway.approveInputEnvelope(envelope);
  return {
    approved,
    summary: trustSummary(policy, event),
  };
}

function inspectOutput(
  policy: TrustPolicy,
  envelope: ContextEnvelope,
  output: string,
  sensitivePaths: readonly string[],
): { approved: string; summary: TrustSummary } {
  let event: TrustEvent | undefined;
  const gateway = TrustGateway.forInspection({
    policy: privacyFloorPolicy(policy),
    origin: "mcp",
    sensitivePaths,
    onEvent: (candidate) => {
      if (candidate.stage === "output") event = candidate;
    },
  });
  const approved = gateway.approveOutputEnvelope(envelope, output);
  return {
    approved,
    summary: trustSummary(policy, event),
  };
}

function privacyFloorPolicy(policy: TrustPolicy): TrustPolicy {
  return policy === "strict" ? "strict" : "redact";
}

function trustSummary(
  policy: TrustPolicy,
  event: TrustEvent | undefined,
): TrustSummary {
  return {
    policy,
    action: event?.action ?? "allowed",
    findings: event?.findings ?? [],
  };
}

function readPrepareArguments(
  args: unknown,
): PrepareDocumentationUpdateArguments {
  const record = readExactRecord(args, [
    "base",
    "head",
    "max_context_bytes",
    "target",
  ]);
  const base = readOptionalOwn(record, "base");
  const head = readOptionalOwn(record, "head");
  const maxContextBytes = readOptionalOwn(record, "max_context_bytes");
  const target = readOptionalOwn(record, "target");
  const hasBase = Object.hasOwn(record, "base");
  const hasHead = Object.hasOwn(record, "head");
  const hasMaxContextBytes = Object.hasOwn(record, "max_context_bytes");
  const hasTarget = Object.hasOwn(record, "target");

  if (hasBase && typeof base !== "string") {
    throw invalidPlanReference();
  }
  if (hasHead && typeof head !== "string") {
    throw invalidPlanReference();
  }
  if (
    hasMaxContextBytes &&
    (typeof maxContextBytes !== "number" ||
      !Number.isInteger(maxContextBytes) ||
      maxContextBytes < MIN_MAX_CONTEXT_BYTES ||
      maxContextBytes > MAX_MAX_CONTEXT_BYTES)
  ) {
    throw invalidContextBudget();
  }
  const normalizedTarget =
    hasTarget && typeof target === "string"
      ? normalizeInputTarget(target)
      : undefined;
  if (hasTarget && normalizedTarget === undefined) {
    throw new RepositoryWriteError("TRUST_INVALID_PATH");
  }

  return {
    ...(hasBase ? { base: base as string } : {}),
    ...(hasHead ? { head: head as string } : {}),
    ...(hasMaxContextBytes
      ? { max_context_bytes: maxContextBytes as number }
      : {}),
    ...(hasTarget ? { target: normalizedTarget } : {}),
  };
}

function readValidateArguments(args: unknown): {
  preparationDigest?: string;
  target: string;
  candidateMarkdown: string;
} {
  const record = readExactRecord(args, [
    "preparation_digest",
    "target",
    "candidate_markdown",
  ]);
  const hasPreparationDigest = Object.hasOwn(record, "preparation_digest");
  const preparationDigest = readOptionalOwn(record, "preparation_digest");
  const target = readRequiredOwn(record, "target");
  const candidateMarkdown = readRequiredOwn(record, "candidate_markdown");
  const normalizedTarget =
    typeof target === "string" ? normalizeInputTarget(target) : undefined;
  if (
    (hasPreparationDigest &&
      (typeof preparationDigest !== "string" ||
        preparationDigest.length === 0)) ||
    normalizedTarget === undefined ||
    typeof candidateMarkdown !== "string" ||
    Buffer.byteLength(candidateMarkdown, "utf8") > MAX_CANDIDATE_BYTES
  ) {
    throw invalidPreparation();
  }
  return {
    ...(hasPreparationDigest
      ? { preparationDigest: preparationDigest as string }
      : {}),
    target: normalizedTarget,
    candidateMarkdown,
  };
}

function readExactRecord(
  args: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw invalidPreparation();
  }
  try {
    const keys = Reflect.ownKeys(args);
    const stringKeys = keys.filter(
      (key): key is string => typeof key === "string",
    );
    if (
      stringKeys.length !== keys.length ||
      !stringKeys.every((key) => allowedKeys.includes(key))
    ) {
      throw invalidPreparation();
    }
    for (const key of allowedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(args, key);
      if (descriptor !== undefined && !("value" in descriptor)) {
        throw invalidPreparation();
      }
    }
    const safeRecord: Record<string, unknown> = Object.create(null);
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(args, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw invalidPreparation();
      }
      safeRecord[key] = descriptor.value;
    }
    return safeRecord;
  } catch (error: unknown) {
    if (error instanceof MCPPreparationError) throw error;
    throw invalidPreparation();
  }
}

function readOptionalOwn(
  record: Record<string, unknown>,
  key: string,
): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw invalidPreparation();
    }
    return descriptor.value;
  } catch (error: unknown) {
    if (error instanceof MCPPreparationError) throw error;
    throw invalidPreparation();
  }
}

function readRequiredOwn(
  record: Record<string, unknown>,
  key: string,
): unknown {
  if (!Object.hasOwn(record, key)) throw invalidPreparation();
  return readOptionalOwn(record, key);
}

function normalizedTargetCandidate(
  target: DocumentationTargetCandidate,
): DocumentationTargetCandidate {
  return {
    path: normalizedDisplayPath(target.path),
    reasons: target.reasons,
    sections: target.sections,
  };
}

function normalizedDisplayPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!isSafeRelativeMarkdownTarget(normalized)) {
    throw invalidPreparation();
  }
  return normalized;
}

function isSafeRelativeMarkdownTarget(value: string): boolean {
  if (
    value.length === 0 ||
    hasControlCharacter(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//u.test(value) ||
    !value.toLowerCase().endsWith(".md")
  ) {
    return false;
  }
  const normalized = pathPosix.normalize(value);
  return (
    normalized === value &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function normalizeInputTarget(value: string): string | undefined {
  if (
    value.length === 0 ||
    hasControlCharacter(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//u.test(value)
  ) {
    return undefined;
  }
  const components = value.split("/");
  if (components.some((component) => component === "..")) return undefined;
  const normalized = pathPosix.normalize(value);
  return isSafeRelativeMarkdownTarget(normalized) ? normalized : undefined;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function invalidPreparation(): MCPPreparationError {
  return new MCPPreparationError();
}

function invalidPlanReference(): Error {
  return new PlanFailure("PLAN_INVALID_REF", "The Git reference is invalid.");
}

function invalidContextBudget(): Error {
  return new PlanFailure(
    "PLAN_INVALID_CONTEXT_BUDGET",
    "The provider context byte budget is invalid.",
  );
}

function isStaleRepositoryError(error: unknown): boolean {
  return (
    error instanceof RepositoryWriteError &&
    [
      "TRUST_INVALID_PATH",
      "TRUST_PATH_OUTSIDE_ROOT",
      "TRUST_UNSAFE_SYMLINK",
      "TRUST_INVALID_TARGET_TYPE",
      "TRUST_RACE_DETECTED",
      "TRUST_INSPECTION_FAILED",
    ].includes(error.code)
  );
}

function environmentTrustPolicy(): TrustPolicy {
  const value = process.env.STALEDOCS_TRUST_POLICY;
  return value === "warn" || value === "strict" || value === "redact"
    ? value
    : "redact";
}
