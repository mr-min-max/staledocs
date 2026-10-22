#!/usr/bin/env node
/**
 * staledocs MCP (Model Context Protocol) Server
 *
 * Exposes staledocs's functionality as tools for AI assistants (ChatGPT, Claude, Cursor, etc.)
 * via the Model Context Protocol standard.
 *
 * Tools:
 * - analyze_codebase: Parse and return code structure (AST)
 * - generate_readme: Generate README documentation
 * - generate_api_docs: Generate API reference documentation
 * - generate_diagram: Generate architecture diagram
 * - check_docs_freshness: Run an AST-backed source/document co-change guard
 * - audit_documentation: Find Markdown references that no longer exist
 *
 * Usage:
 *   staledocs --mcp
 *   # or add to Claude/Cursor MCP config
 */

import { analyzeCapturedSources } from "../core/analyzer";
import { Generator } from "../core/generator";
import { createProvider } from "../providers/registry";
import type { ParsedModule } from "../parsers/types";
import { createImpactPlan } from "../impact/planner";
import {
  PLAN_ERROR_CODES,
  PlanFailure,
  type PlanErrorCode,
} from "../impact/types";
import { readPackageVersion } from "../core/package-meta";
import { resolveTemplatesDir } from "../core/templates";
import {
  ProviderConfigurationError,
  type ProviderConfigurationErrorCode,
} from "../providers/errors";
import { getProviderProfile } from "../providers/profiles";
import {
  resolveProviderSelection,
  type ResolvedProviderSelection,
} from "../providers/selection";
import {
  TrustInvalidProviderOutputError,
  TrustViolationError,
} from "../security/types";
import {
  getSafeErrorDiagnostic,
  inspectSafeAllowlistedErrorCode,
  UNKNOWN_ERROR_DIAGNOSTIC,
} from "../security/diagnostics";
import {
  MCPRepositoryReadScope,
  MCPRepositoryScopeError,
  readExactMCPRecord,
  readOwnMCPArgument,
  type AuthorizedMCPDirectory,
} from "./repository-scope";
import {
  MCPScopedConfigLoader,
  MCPUnsafeConfigurationError,
} from "./scoped-config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createMCPUpdateWorkflowContext,
  defaultMCPUpdateWorkflowContext,
  prepareDocumentationUpdate,
  validateDocumentationDraft,
  MCP_TARGET_REQUIRED,
  type MCPUpdateWorkflowContext,
} from "./update-workflow";
import { MCP_INVALID_PREPARATION } from "./preparation-token";
import { checkMCPDocumentationFreshness } from "./scoped-freshness";
import { auditMCPDocumentation } from "./scoped-audit";

const SAFE_MCP_ERROR_CODES = new Set<string>([
  ...PLAN_ERROR_CODES,
  "TRUST_REPOSITORY_REQUIRED",
  "TRUST_INVALID_PATH",
  "TRUST_INSPECTION_FAILED",
  "TRUST_PATH_OUTSIDE_ROOT",
  "TRUST_UNSAFE_SYMLINK",
  "TRUST_INVALID_TARGET_TYPE",
  "TRUST_RACE_DETECTED",
  "TRUST_ATOMIC_WRITE_FAILED",
  MCP_TARGET_REQUIRED,
  MCP_INVALID_PREPARATION,
]);
const UNKNOWN_MCP_ERROR = "Unknown MCP error.";

const MCP_GENERATION_FAILED = "MCP_GENERATION_FAILED" as const;
const MCP_GENERATION_FAILED_MESSAGE =
  "The MCP documentation generation request failed.";
const MCP_GENERATION_ERROR_CONFIGURATION =
  "Invalid MCP legacy generation error configuration.";
const MCP_GENERATION_ERROR_PAYLOADS = new WeakMap<
  object,
  { readonly code: typeof MCP_GENERATION_FAILED; readonly message: string }
>();
const MCP_GENERATION_CODE_SET = new Set<string>([MCP_GENERATION_FAILED]);
const MCP_GENERATION_MESSAGE_SET = new Set<string>([
  MCP_GENERATION_FAILED_MESSAGE,
]);

/** A fixed, value-free failure for unknown legacy provider-backed generation errors. */
export class MCPLegacyGenerationError extends Error {
  declare readonly code: typeof MCP_GENERATION_FAILED;

  constructor() {
    if (arguments.length !== 0) {
      throw new TypeError(MCP_GENERATION_ERROR_CONFIGURATION);
    }
    super(MCP_GENERATION_FAILED_MESSAGE);
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "MCPLegacyGenerationError",
      writable: true,
    });
    Object.defineProperty(this, "code", {
      configurable: true,
      enumerable: true,
      value: MCP_GENERATION_FAILED,
      writable: true,
    });
    Object.defineProperty(this, "message", {
      configurable: true,
      enumerable: true,
      value: MCP_GENERATION_FAILED_MESSAGE,
      writable: true,
    });
    MCP_GENERATION_ERROR_PAYLOADS.set(
      this,
      Object.freeze({
        code: MCP_GENERATION_FAILED,
        message: MCP_GENERATION_FAILED_MESSAGE,
      }),
    );
  }

  /** Returns the fixed payload only for an authentic, unmodified generation error. */
  static read(
    error: unknown,
  ): { readonly code: string; readonly message: string } | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const payload = MCP_GENERATION_ERROR_PAYLOADS.get(error);
    if (payload === undefined) return undefined;
    try {
      const codeDescriptor = Object.getOwnPropertyDescriptor(error, "code");
      const messageDescriptor = Object.getOwnPropertyDescriptor(
        error,
        "message",
      );
      if (
        codeDescriptor === undefined ||
        !Object.hasOwn(codeDescriptor, "value") ||
        messageDescriptor === undefined ||
        !Object.hasOwn(messageDescriptor, "value") ||
        codeDescriptor.value !== payload.code ||
        messageDescriptor.value !== payload.message
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return { ...payload };
  }

  /** Detects generation-shaped errors without trusting mutable candidate fields. */
  static isCandidate(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    if (MCP_GENERATION_ERROR_PAYLOADS.has(error)) return true;
    try {
      const codeDescriptor = findErrorPropertyDescriptor(error, "code");
      const messageDescriptor = findErrorPropertyDescriptor(error, "message");
      if (
        (codeDescriptor !== undefined &&
          !Object.hasOwn(codeDescriptor, "value")) ||
        (messageDescriptor !== undefined &&
          !Object.hasOwn(messageDescriptor, "value"))
      ) {
        return true;
      }
      const code =
        codeDescriptor !== undefined && Object.hasOwn(codeDescriptor, "value")
          ? codeDescriptor.value
          : undefined;
      const message =
        messageDescriptor !== undefined &&
        Object.hasOwn(messageDescriptor, "value")
          ? messageDescriptor.value
          : undefined;
      return (
        (typeof code === "string" && MCP_GENERATION_CODE_SET.has(code)) ||
        (typeof message === "string" && MCP_GENERATION_MESSAGE_SET.has(message))
      );
    } catch {
      return true;
    }
  }
}

function findErrorPropertyDescriptor(
  object: object,
  property: PropertyKey,
): PropertyDescriptor | undefined {
  const visited = new Set<object>();
  let current: object | null = object;
  while (current !== null) {
    if (visited.has(current)) throw new Error("Cyclic error prototype.");
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor !== undefined) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

export interface MCPServerContext {
  readonly serverCwd: string;
  readonly scope: MCPRepositoryReadScope;
  readonly configLoader: MCPScopedConfigLoader;
  readonly updateWorkflow: MCPUpdateWorkflowContext;
}

function invalidMCPRef(): PlanFailure {
  return new PlanFailure("PLAN_INVALID_REF", "The Git reference is invalid.");
}

function invalidMCPContextBudget(): PlanFailure {
  return new PlanFailure(
    "PLAN_INVALID_CONTEXT_BUDGET",
    "The provider context byte budget is invalid.",
  );
}

function readMCPPlanOptions(args: unknown): {
  base?: string;
  head?: string;
  maxContextBytes?: number;
} {
  const base = readOwnMCPArgument(args, "base", invalidMCPRef);
  const head = readOwnMCPArgument(args, "head", invalidMCPRef);
  const maxContextBytes = readOwnMCPArgument(
    args,
    "max_context_bytes",
    invalidMCPContextBudget,
  );
  if (base !== undefined && typeof base !== "string") throw invalidMCPRef();
  if (head !== undefined && typeof head !== "string") throw invalidMCPRef();
  if (
    maxContextBytes !== undefined &&
    (typeof maxContextBytes !== "number" ||
      !Number.isInteger(maxContextBytes) ||
      maxContextBytes < 1024 ||
      maxContextBytes > 1048576)
  ) {
    throw invalidMCPContextBudget();
  }
  return { base, head, maxContextBytes };
}

/** Formats sanitized MCP diagnostics and collapses forged error candidates safely. */
export function formatMCPError(error: unknown): string {
  const scopeError = MCPRepositoryScopeError.read(error);
  if (scopeError !== undefined) {
    return `${scopeError.code}: ${scopeError.message}`;
  }
  const planError = PlanFailure.read(error);
  if (planError !== undefined) {
    return `${planError.code}: ${planError.message}`;
  }
  const trustViolation = TrustViolationError.read(error);
  if (trustViolation !== undefined) {
    return `${trustViolation.code}: ${trustViolation.message}`;
  }
  const trustOutputError = TrustInvalidProviderOutputError.read(error);
  if (trustOutputError !== undefined) {
    return `${trustOutputError.code}: ${trustOutputError.message}`;
  }
  if (MCPRepositoryScopeError.isCandidate(error)) {
    return UNKNOWN_MCP_ERROR;
  }
  if (
    TrustViolationError.isCandidate(error) ||
    TrustInvalidProviderOutputError.isCandidate(error)
  ) {
    return UNKNOWN_MCP_ERROR;
  }
  const configurationError = MCPUnsafeConfigurationError.read(error);
  if (configurationError !== undefined) {
    return `${configurationError.code}: ${configurationError.message}`;
  }
  if (MCPUnsafeConfigurationError.isCandidate(error)) {
    return UNKNOWN_MCP_ERROR;
  }
  const generationError = MCPLegacyGenerationError.read(error);
  if (generationError !== undefined) {
    return `${generationError.code}: ${generationError.message}`;
  }
  if (MCPLegacyGenerationError.isCandidate(error)) {
    return UNKNOWN_MCP_ERROR;
  }
  const providerCode = readKnownProviderConfigurationCode(error);
  if (providerCode !== undefined) {
    const providerError = new ProviderConfigurationError(providerCode);
    return `${providerError.code}: ${providerError.message}`;
  }

  const diagnostic = getSafeErrorDiagnostic(error);
  if (diagnostic.message === UNKNOWN_ERROR_DIAGNOSTIC) {
    return UNKNOWN_MCP_ERROR;
  }

  const { code, hasUntrustedCode } = inspectSafeAllowlistedErrorCode(
    error,
    SAFE_MCP_ERROR_CODES,
  );
  if (!code) {
    return hasUntrustedCode ? UNKNOWN_MCP_ERROR : diagnostic.message;
  }
  if (PLAN_ERROR_CODES.has(code as PlanErrorCode)) return UNKNOWN_MCP_ERROR;

  const prefix = `${code}:`;
  return diagnostic.message.startsWith(prefix)
    ? diagnostic.message
    : `${prefix} ${diagnostic.message}`;
}

/** Available MCP tools */
export const TOOLS: Tool[] = [
  {
    name: "analyze_codebase",
    description:
      "Analyze a codebase directory using AST parsing. Returns structured data about functions, classes, types, and imports found in the code.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description:
            "Path within the Git worktree where this MCP server started (absolute or repository-relative).",
        },
        include: {
          type: "string",
          description:
            "Comma-separated glob patterns to include (default: **/*.ts,**/*.py)",
          default: "**/*.ts,**/*.tsx,**/*.js,**/*.jsx,**/*.py",
        },
        exclude: {
          type: "string",
          description: "Comma-separated glob patterns to exclude",
          default: "**/node_modules/**,**/dist/**,**/*.test.*",
        },
      },
      required: ["directory"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_readme",
    description:
      "Generate a professional README.md for a project by analyzing its code structure, package metadata, and dependencies.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description:
            "Path within the Git worktree where this MCP server started (absolute or repository-relative).",
        },
      },
      required: ["directory"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_api_docs",
    description:
      "Generate API reference documentation for all exported symbols (functions, classes, types) in a codebase.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description:
            "Path within the Git worktree where this MCP server started (absolute or repository-relative).",
        },
      },
      required: ["directory"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_diagram",
    description:
      "Generate a Mermaid architecture diagram showing module dependencies and data flow.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description:
            "Path within the Git worktree where this MCP server started (absolute or repository-relative).",
        },
      },
      required: ["directory"],
      additionalProperties: false,
    },
  },
  {
    name: "check_docs_freshness",
    description:
      "Run plan-driven documentation freshness checks. This reports stale sections that directly mention changed symbols and does not verify semantic correctness.",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description:
            "Path within the Git worktree where this MCP server started (absolute or repository-relative).",
        },
        doc_file: {
          type: "string",
          description:
            "Path to the documentation file to check (relative to directory; default: discovered repository README)",
        },
        since: {
          type: "string",
          description: "Optional Git ref to compare against (default: planner base discovery)",
        },
      },
      required: ["directory"],
      additionalProperties: false,
    },
  },
  {
    name: "audit_documentation",
    description:
      "Audit Markdown in the repository where this MCP server started for package scripts, repository paths, and public class members that no longer exist. Read-only and deterministic; it does not fix anything.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 64,
          description:
            "Repository-relative Markdown files to audit (default: discovered documentation and agent instruction files)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "plan_documentation_impact",
    description:
      "Plan deterministic documentation impact for the repository where this MCP server started.",
    inputSchema: {
      type: "object",
      properties: {
        base: {
          type: "string",
          description: "Explicit comparison base Git ref",
        },
        head: {
          type: "string",
          description: "Compare two committed Git refs",
        },
        max_context_bytes: {
          type: "integer",
          minimum: 1024,
          maximum: 1048576,
          description: "Provider-context byte ceiling",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "prepare_documentation_update",
    description:
      "Prepare one repository-scoped Markdown update without writing files or calling a provider.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string" },
        head: { type: "string" },
        max_context_bytes: {
          type: "integer",
          minimum: 1024,
          maximum: 1048576,
        },
        target: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        schema_version: {
          type: "string",
          const: "aidoc.mcp-update-preparation.v1",
        },
        preparation_digest: { type: "string" },
        target: { type: "string" },
        generation: {
          type: "object",
          properties: {
            system_prompt: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["system_prompt", "prompt"],
          additionalProperties: false,
        },
        context: contextBudgetSchema(),
        trust: trustSummarySchema(),
        instructions: { type: "array", items: { type: "string" } },
      },
      required: [
        "schema_version",
        "preparation_digest",
        "target",
        "generation",
        "context",
        "trust",
        "instructions",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "validate_documentation_draft",
    description:
      "Validate a host-generated Markdown draft against the latest server-side preparation for the target, without writing files. preparation_digest is optional and, when present, must be the exact value returned by prepare_documentation_update.",
    inputSchema: {
      type: "object",
      properties: {
        preparation_digest: { type: "string" },
        target: { type: "string" },
        candidate_markdown: { type: "string" },
      },
      required: ["target", "candidate_markdown"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        schema_version: {
          type: "string",
          const: "aidoc.mcp-draft-validation.v1",
        },
        valid: { type: "boolean" },
        target: { type: "string" },
        approved_markdown: { type: "string" },
        markdown_warnings: { type: "array", items: { type: "string" } },
        diff: diffSummarySchema(),
        trust: trustSummarySchema(),
      },
      required: [
        "schema_version",
        "valid",
        "target",
        "markdown_warnings",
        "diff",
        "trust",
      ],
      additionalProperties: false,
    },
  },
];

function contextBudgetSchema(): object {
  return {
    type: "object",
    properties: {
      maxBytes: { type: "integer" },
      usedBytes: { type: "integer" },
      totalRecords: { type: "integer" },
      includedRecords: { type: "integer" },
      omittedRecords: { type: "integer" },
      impactDigest: { type: "string" },
    },
    required: [
      "maxBytes",
      "usedBytes",
      "totalRecords",
      "includedRecords",
      "omittedRecords",
      "impactDigest",
    ],
    additionalProperties: false,
  };
}

function trustSummarySchema(): object {
  return {
    type: "object",
    properties: {
      policy: { type: "string", enum: ["warn", "redact", "strict"] },
      action: {
        type: "string",
        enum: ["allowed", "warned", "redacted", "blocked"],
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string" },
            count: { type: "integer" },
          },
          required: ["kind", "count"],
          additionalProperties: false,
        },
      },
    },
    required: ["policy", "action", "findings"],
    additionalProperties: false,
  };
}

function diffSummarySchema(): object {
  return {
    type: "object",
    properties: {
      changed: { type: "boolean" },
      addedLines: { type: "integer" },
      removedLines: { type: "integer" },
      oldBytes: { type: "integer" },
      newBytes: { type: "integer" },
    },
    required: ["changed", "addedLines", "removedLines", "oldBytes", "newBytes"],
    additionalProperties: false,
  };
}

/** Creates the single pinned scope, config loader, and workflow context for a server. */
export async function createMCPServerContext(
  serverCwd = process.cwd(),
  hostEnvironment?: Readonly<NodeJS.ProcessEnv>,
): Promise<MCPServerContext> {
  const scope = await MCPRepositoryReadScope.open(serverCwd);
  const configLoader = new MCPScopedConfigLoader(scope, hostEnvironment);
  const updateWorkflow = createMCPUpdateWorkflowContext(
    serverCwd,
    undefined,
    trustPolicyFromEnvironment(hostEnvironment),
    () => configLoader.loadPlanning(scope.rootDirectory()),
    () => configLoader.loadSuppressions(),
  );
  return Object.freeze({
    serverCwd,
    scope,
    configLoader,
    updateWorkflow,
  });
}

async function resolveMCPServerContext(
  contextOrCwd: MCPServerContext | string | undefined,
  legacyWorkflowContext: MCPUpdateWorkflowContext | undefined,
): Promise<MCPServerContext> {
  if (typeof contextOrCwd === "object" && contextOrCwd !== null) {
    if (legacyWorkflowContext === undefined) return contextOrCwd;
    return Object.freeze({
      ...contextOrCwd,
      updateWorkflow: Object.freeze({
        ...legacyWorkflowContext,
        serverCwd: contextOrCwd.serverCwd,
        loadPlanningConfig: contextOrCwd.updateWorkflow.loadPlanningConfig,
      }),
    });
  }

  const context = await createMCPServerContext(
    typeof contextOrCwd === "string" ? contextOrCwd : process.cwd(),
  );
  const workflowContext =
    legacyWorkflowContext ?? defaultMCPUpdateWorkflowContext(context.serverCwd);

  return Object.freeze({
    ...context,
    updateWorkflow: Object.freeze({
      ...workflowContext,
      serverCwd: context.serverCwd,
      loadPlanningConfig: context.updateWorkflow.loadPlanningConfig,
    }),
  });
}

function trustPolicyFromEnvironment(
  environment: Readonly<NodeJS.ProcessEnv> | undefined,
): MCPUpdateWorkflowContext["trustPolicy"] {
  const source = environment ?? process.env;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      source,
      "STALEDOCS_TRUST_POLICY",
    );
    const value =
      descriptor !== undefined && Object.hasOwn(descriptor, "value")
        ? descriptor.value
        : undefined;
    return value === "warn" || value === "strict" || value === "redact"
      ? value
      : "redact";
  } catch {
    return "redact";
  }
}

function invalidMCPPath(): MCPRepositoryScopeError {
  return new MCPRepositoryScopeError("MCP_INVALID_PATH_INPUT");
}

function readLegacyRecord(
  args: unknown,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  return readExactMCPRecord(args, allowedKeys, invalidMCPPath);
}

function mapAnalysisModules(modules: readonly ParsedModule[]): {
  totalModules: number;
  totalFunctions: number;
  totalClasses: number;
  totalTypes: number;
  modules: readonly unknown[];
} {
  return {
    totalModules: modules.length,
    totalFunctions: modules.reduce(
      (acc, module) => acc + module.functions.length,
      0,
    ),
    totalClasses: modules.reduce(
      (acc, module) => acc + module.classes.length,
      0,
    ),
    totalTypes: modules.reduce((acc, module) => acc + module.types.length, 0),
    modules: modules.map((module) => ({
      filePath: module.filePath,
      language: module.language,
      functions: module.functions.map((functionInfo) => ({
        name: functionInfo.name,
        signature: functionInfo.signature,
        returnType: functionInfo.returnType,
        isAsync: functionInfo.isAsync,
        hasDoc: !!functionInfo.existingDoc,
      })),
      classes: module.classes.map((classInfo) => ({
        name: classInfo.name,
        extends: classInfo.extends,
        implements: classInfo.implements,
        methodCount: classInfo.methods.length,
        hasDoc: !!classInfo.existingDoc,
      })),
      types: module.types.map((typeInfo) => ({
        name: typeInfo.name,
        kind: typeInfo.kind,
      })),
    })),
  };
}

async function analyzeAuthorizedSources(
  context: MCPServerContext,
  directory: AuthorizedMCPDirectory,
  include: readonly string[],
  exclude: readonly string[],
): Promise<readonly ParsedModule[]> {
  const files = await context.scope.enumerateSources(
    directory,
    context.scope.validateGlobList(include, "include"),
    context.scope.validateGlobList(exclude, "exclude"),
  );
  return analyzeCapturedSources(
    files.map((file) => ({
      displayPath: file.displayPath,
      content: file.content,
    })),
  );
}

function cloneApprovedEndpoint(
  endpoint: ResolvedProviderSelection["endpoint"],
): ResolvedProviderSelection["endpoint"] {
  if (endpoint === undefined) return undefined;
  return {
    url: new URL(endpoint.url.href),
    origin: endpoint.origin,
    local: endpoint.local,
    addresses: endpoint.addresses.map(({ address, family }) => ({
      address,
      family,
    })),
  };
}

function cloneProviderSelection(
  selection: ResolvedProviderSelection,
): ResolvedProviderSelection {
  const endpoint = cloneApprovedEndpoint(selection.endpoint);
  return {
    provider: selection.provider,
    ...(selection.model === undefined ? {} : { model: selection.model }),
    ...(endpoint === undefined ? {} : { endpoint }),
    source: selection.source,
    boundary: selection.boundary,
    ...(selection.credentialEnv === undefined
      ? {}
      : { credentialEnv: selection.credentialEnv }),
    ...(selection.qwen === undefined
      ? {}
      : {
          qwen: {
            region: selection.qwen.region,
            ...(selection.qwen.workspaceId === undefined
              ? {}
              : { workspaceId: selection.qwen.workspaceId }),
          },
        }),
  };
}

const PROVIDER_CONFIGURATION_ERROR_CODES =
  new Set<ProviderConfigurationErrorCode>([
    "PROVIDER_INVALID_ENDPOINT",
    "PROVIDER_ENDPOINT_NOT_PUBLIC",
    "PROVIDER_LOCAL_HTTP_NOT_CONFIRMED",
    "PROVIDER_SELECTION_REQUIRED",
    "PROVIDER_SELECTION_CANCELLED",
    "QWEN_PLAN_NOT_PERMITTED_FOR_CUSTOM_APP",
  ]);

function readKnownProviderConfigurationCode(
  error: unknown,
): ProviderConfigurationErrorCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string" ||
      !PROVIDER_CONFIGURATION_ERROR_CODES.has(
        descriptor.value as ProviderConfigurationErrorCode,
      )
    ) {
      return undefined;
    }
    return descriptor.value as ProviderConfigurationErrorCode;
  } catch {
    return undefined;
  }
}

function recognizedTrustError(error: unknown): Error | undefined {
  if (
    TrustInvalidProviderOutputError.read(error) !== undefined ||
    TrustViolationError.read(error) !== undefined
  ) {
    return error as Error;
  }
  return undefined;
}

function normalizeLegacyGenerationError(error: unknown): never {
  if (MCPRepositoryScopeError.read(error) !== undefined) throw error;
  if (MCPUnsafeConfigurationError.read(error) !== undefined) throw error;
  if (PlanFailure.read(error) !== undefined) throw error;

  const providerCode = readKnownProviderConfigurationCode(error);
  if (providerCode !== undefined) {
    throw new ProviderConfigurationError(providerCode);
  }

  const trustError = recognizedTrustError(error);
  if (trustError !== undefined) throw trustError;
  throw new MCPLegacyGenerationError();
}

type LegacyGenerationKind = "readme" | "api" | "diagram";

async function generateLegacyTool(
  context: MCPServerContext,
  directory: AuthorizedMCPDirectory,
  kind: LegacyGenerationKind,
): Promise<{ content: string; format: "markdown" | "mermaid" }> {
  const settings = await context.configLoader.loadProvider(directory);
  const metadata =
    kind === "readme"
      ? await context.configLoader.readProjectMetadata(directory)
      : undefined;
  const modules = await analyzeAuthorizedSources(
    context,
    directory,
    settings.config.include,
    settings.config.exclude,
  );

  try {
    const selection = await resolveProviderSelection({
      config: settings.config,
      env: settings.effectiveEnvironment as NodeJS.ProcessEnv,
      interactive: false,
    });
    if (selection === null) {
      throw new ProviderConfigurationError("PROVIDER_SELECTION_CANCELLED");
    }

    const acceptedSelection = cloneProviderSelection(selection);
    const acceptedEndpointUrl = acceptedSelection.endpoint?.url.href;
    const isBuiltInProvider =
      getProviderProfile(acceptedSelection.provider) !== undefined;
    const acceptedProviderBaseUrl = acceptedEndpointUrl;
    const acceptedAllowLocalHttp =
      acceptedSelection.endpoint !== undefined
        ? acceptedSelection.endpoint.local &&
          acceptedSelection.endpoint.url.protocol === "http:"
        : isBuiltInProvider
          ? false
          : settings.config.allowLocalHttp;
    const acceptedOllamaHost =
      acceptedSelection.provider === "ollama" ? acceptedEndpointUrl : undefined;
    const provider = createProvider({
      provider: acceptedSelection.provider,
      model: acceptedSelection.model,
      ollamaHost: acceptedOllamaHost,
      providerBaseUrl: acceptedProviderBaseUrl,
      allowLocalHttp: acceptedAllowLocalHttp,
      endpoint: acceptedSelection.endpoint,
      ...(acceptedSelection.qwen === undefined
        ? {}
        : { qwen: { ...acceptedSelection.qwen } }),
      credentialEnvironment: settings.credentials,
    });
    const generator = new Generator(provider, resolveTemplatesDir(), {
      policy: settings.config.trustPolicy,
      origin: "mcp",
      pathProtection: context.scope.createMCPPathProtection(),
    });

    if (kind === "readme") {
      const content = await generator.generateReadme({
        projectName: metadata!.name,
        description: metadata!.description,
        modules: [...modules],
        dependencies: [...metadata!.dependencies],
        badges: true,
        tableOfContents: true,
        installSection: true,
        usageExamples: true,
      });
      return { content, format: "markdown" };
    }
    if (kind === "api") {
      return {
        content: await generator.generateApiDocs([...modules]),
        format: "markdown",
      };
    }
    return {
      content: await generator.generateDiagram([...modules]),
      format: "mermaid",
    };
  } catch (error: unknown) {
    normalizeLegacyGenerationError(error);
  }
}

/** Handle a tool call */
export async function handleToolCall(
  name: string,
  args: unknown,
  contextOrCwd?: MCPServerContext | string,
  legacyWorkflowContext?: MCPUpdateWorkflowContext,
): Promise<unknown> {
  switch (name) {
    case "analyze_codebase": {
      const legacyArgs = readLegacyRecord(args, [
        "directory",
        "include",
        "exclude",
      ]);
      const context = await resolveMCPServerContext(
        contextOrCwd,
        legacyWorkflowContext,
      );
      const directory = await context.scope.authorizeDirectory(
        legacyArgs.directory,
      );
      const callerInclude = context.scope.parseOptionalGlobList(
        legacyArgs.include,
        "include",
      );
      const callerExclude = context.scope.parseOptionalGlobList(
        legacyArgs.exclude,
        "exclude",
      );
      const config = await context.configLoader.loadPlanning(directory);
      const modules = await analyzeAuthorizedSources(
        context,
        directory,
        callerInclude ?? config.include,
        callerExclude ?? config.exclude,
      );
      return mapAnalysisModules(modules);
    }

    case "generate_readme": {
      const legacyArgs = readLegacyRecord(args, ["directory"]);
      const context = await resolveMCPServerContext(
        contextOrCwd,
        legacyWorkflowContext,
      );
      const directory = await context.scope.authorizeDirectory(
        legacyArgs.directory,
      );
      return generateLegacyTool(context, directory, "readme");
    }

    case "generate_api_docs": {
      const legacyArgs = readLegacyRecord(args, ["directory"]);
      const context = await resolveMCPServerContext(
        contextOrCwd,
        legacyWorkflowContext,
      );
      const directory = await context.scope.authorizeDirectory(
        legacyArgs.directory,
      );
      return generateLegacyTool(context, directory, "api");
    }

    case "generate_diagram": {
      const legacyArgs = readLegacyRecord(args, ["directory"]);
      const context = await resolveMCPServerContext(
        contextOrCwd,
        legacyWorkflowContext,
      );
      const directory = await context.scope.authorizeDirectory(
        legacyArgs.directory,
      );
      return generateLegacyTool(context, directory, "diagram");
    }

    case "check_docs_freshness": {
      const legacyArgs = readLegacyRecord(args, [
        "directory",
        "doc_file",
        "since",
      ]);
      const context = await resolveMCPServerContext(
        contextOrCwd,
        legacyWorkflowContext,
      );
      const directory = await context.scope.authorizeDirectory(
        legacyArgs.directory,
      );
      const report = await checkMCPDocumentationFreshness({
        scope: context.scope,
        serverCwd: context.serverCwd,
        directory,
        docFile: legacyArgs.doc_file,
        since: legacyArgs.since,
        planningConfig: await context.configLoader.loadPlanning(
          context.scope.rootDirectory(),
        ),
        loadSuppressions: () => context.configLoader.loadSuppressions(),
      });
      return {
        ...report,
        recommendation:
          report.status === "stale"
            ? "Run staledocs update to refresh documentation."
            : null,
      };
    }

    case "audit_documentation": {
      const auditArgs = readLegacyRecord(args, ["paths"]);
      const context = await resolveMCPServerContext(
        contextOrCwd,
        legacyWorkflowContext,
      );
      return auditMCPDocumentation({
        scope: context.scope,
        serverCwd: context.serverCwd,
        paths: auditArgs.paths,
        planningConfig: await context.configLoader.loadPlanning(
          context.scope.rootDirectory(),
        ),
        loadSuppressions: () => context.configLoader.loadSuppressions(),
      });
    }

    case "plan_documentation_impact": {
      const options = readMCPPlanOptions(args);
      const context = await resolveMCPServerContext(
        contextOrCwd,
        legacyWorkflowContext,
      );
      const planningConfig = await context.configLoader.loadPlanning(
        context.scope.rootDirectory(),
      );
      const result = await createImpactPlan({
        cwd: context.serverCwd,
        base: options.base,
        head: options.head,
        maxContextBytes: options.maxContextBytes,
        planningConfig,
        suppressions: await context.configLoader.loadSuppressions(),
      });
      return result.plan;
    }

    case "prepare_documentation_update": {
      const context = await resolveMCPServerContext(
        contextOrCwd,
        legacyWorkflowContext,
      );
      return prepareDocumentationUpdate(args, context.updateWorkflow);
    }

    case "validate_documentation_draft": {
      const context = await resolveMCPServerContext(
        contextOrCwd,
        legacyWorkflowContext,
      );
      return validateDocumentationDraft(args, context.updateWorkflow);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Creates an MCP server whose tool calls share one startup context. */
export async function createMCPServer(
  serverCwd = process.cwd(),
  hostEnvironment?: Readonly<NodeJS.ProcessEnv>,
): Promise<Server> {
  const context = await createMCPServerContext(serverCwd, hostEnvironment);
  const server = new Server(
    { name: "staledocs", version: readPackageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await handleToolCall(
        request.params.name,
        request.params.arguments ?? {},
        context,
      );
      const response = {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
      if (
        request.params.name === "prepare_documentation_update" ||
        request.params.name === "validate_documentation_draft" ||
        request.params.name === "audit_documentation"
      ) {
        return { ...response, structuredContent: result };
      }
      return response;
    } catch (error: unknown) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: formatMCPError(error),
          },
        ],
      };
    }
  });

  return server;
}

/** MCP Server over stdio */
export async function startMCPServer(): Promise<void> {
  const server = await createMCPServer();
  await server.connect(new StdioServerTransport());
}
