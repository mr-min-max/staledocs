import { auditRepository, type AuditReport } from "../core/audit";
import type { PlanningConfig } from "../config/planning";
import type { SuppressionConfig } from "../config/suppressions";
import {
  MCP_INVALID_PATH_INPUT,
  MCPRepositoryScopeError,
  type MCPRepositoryReadScope,
} from "./repository-scope";

const MAX_AUDIT_PATHS = 64;

/** Audits documentation in the pinned repository; named paths pass the scope first. */
export async function auditMCPDocumentation(input: {
  readonly scope: MCPRepositoryReadScope;
  readonly serverCwd: string;
  readonly paths: unknown;
  readonly planningConfig: Readonly<PlanningConfig>;
  readonly loadSuppressions?: () => Promise<SuppressionConfig>;
}): Promise<AuditReport> {
  let paths: string[] | undefined;
  if (input.paths !== undefined) {
    paths = [];
    for (const value of readPathList(input.paths)) {
      if (!value.toLowerCase().endsWith(".md")) throw invalidPath();
      const file = await input.scope.readOptionalFile(
        input.scope.rootDirectory(),
        value,
      );
      paths.push(file.displayPath);
    }
  }
  return auditRepository({
    cwd: input.serverCwd,
    paths,
    planningConfig: input.planningConfig,
    suppressions:
      paths !== undefined || input.loadSuppressions === undefined
        ? undefined
        : await input.loadSuppressions(),
  });
}

function readPathList(raw: unknown): string[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
    throw invalidPath();
  }
  const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_AUDIT_PATHS
  ) {
    throw invalidPath();
  }
  const values: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, index);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string"
    ) {
      throw invalidPath();
    }
    values.push(descriptor.value);
  }
  return values;
}

function invalidPath(): MCPRepositoryScopeError {
  return new MCPRepositoryScopeError(MCP_INVALID_PATH_INPUT);
}
