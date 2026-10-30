import { posix } from "node:path";
import {
  loadPlanningConfig,
  parsePlanningConfig,
  type PlanningConfig,
} from "../config/planning";
import {
  loadSuppressions,
  matchingSuppression,
  type SuppressionConfig,
} from "../config/suppressions";
import { GitSnapshotReader } from "../git/snapshot";
import {
  isChangelogDocument,
  scanDocumentationEvidence,
  type DocumentationFile,
} from "../impact/documentation";
import {
  discoverDocumentationFiles,
  readDocumentationFiles,
  resolvePublicTypeScriptSurface,
} from "../impact/planner";
import { PlanFailure } from "../impact/types";
import { listDeclaredTypeMembers } from "../parsers/typescript";
import { sanitizeDiagnostic } from "../security/scanner";

export const AUDIT_SCHEMA_VERSION = "aidoc.audit.v1" as const;
export const AUDIT_FINDING_LIMIT = 500;

export type AuditFindingKind =
  | "member-missing"
  | "path-missing"
  | "script-missing";

export interface AuditFinding {
  file: string;
  section: string;
  slug: string;
  kind: AuditFindingKind;
  value: string;
  /** Nearest known script name, only for `script-missing`. */
  closest?: string;
  evidence: "code-span" | "link";
}

export interface AuditReport {
  schema_version: typeof AUDIT_SCHEMA_VERSION;
  revision: string;
  summary: {
    /** All findings, including any beyond the finding limit. */
    findings: number;
    /** Markdown files audited; changelog-style files are skipped. */
    files: number;
    byKind: Record<AuditFindingKind, number>;
    truncated?: true;
  };
  findings: AuditFinding[];
  ignored?: {
    documentationLimitReached?: true;
    treeLimitReached?: true;
    /** The public entry walk hit its bound, so member rules were skipped. */
    boundaryLimitReached?: true;
  };
}

/** A public TypeScript class or interface whose declared members are all known. */
export interface AuditPublicType {
  kind: "class" | "interface";
  members: readonly string[];
}

export interface AuditInput {
  /** Repository-relative tree entries; undefined when the listing exceeded its bound. */
  tree: ReadonlySet<string> | undefined;
  /** Package directory ("." for the root) to script names; null when unreadable. */
  scripts: ReadonlyMap<string, readonly string[] | null>;
  docs: readonly DocumentationFile[];
  /** Closed public types by name; roots absent here get no member findings. */
  publicSymbols?: ReadonlyMap<string, AuditPublicType>;
  revision?: string;
  documentationLimitReached?: boolean;
  boundaryLimitReached?: boolean;
}

export interface AuditOptions {
  cwd?: string;
  /** Repository-relative Markdown files to audit instead of discovery. */
  paths?: readonly string[];
  readonly planningConfig?: Readonly<PlanningConfig>;
  readonly suppressions?: Readonly<SuppressionConfig>;
}

/** Files coding agents read first; audited even outside discovered directories. */
export const AGENT_INSTRUCTION_FILES = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
]);

const SCRIPT_INVOCATION =
  /^(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([A-Za-z0-9:_.-]+)/u;
const PACKAGE_MANAGER_COMMANDS = new Set([
  "install",
  "i",
  "ci",
  "add",
  "remove",
  "publish",
  "pack",
  "link",
  "init",
  "exec",
  "x",
  "dlx",
  "create",
  "update",
  "outdated",
  "audit",
  "login",
  "logout",
  "whoami",
  "version",
  "view",
  "info",
  "cache",
  "config",
  "help",
  "-v",
  "--version",
  "run",
  "uninstall",
  "un",
  "rm",
  "ls",
  "list",
  "upgrade",
  "up",
  "why",
  "dedupe",
  "rebuild",
  "prune",
  "unlink",
  "global",
  "workspace",
  "workspaces",
  "store",
  "pm",
]);
// npm runs a script without `run` only for these lifecycle names.
const NPM_SCRIPT_ALIASES = new Set(["test", "start", "stop", "restart", "build"]);
const BUN_NATIVE_COMMANDS = new Set(["test", "build"]);
const WORKSPACE_FLAG =
  /^(?:-w|-ws|--workspace|--workspaces|--filter|-F|-r|--recursive|--prefix|-C|--dir|--cwd)(?:=|$)/u;
const SHELL_SEPARATOR = /&&|\|\||[;|]/u;
const PATH_EXTENSION =
  /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx|py|md|json|yml|yaml|toml|sh|txt)$/u;
const PATH_PREFIXES = [
  "src/",
  "docs/",
  "doc/",
  "test/",
  "tests/",
  "scripts/",
  "packages/",
  "apps/",
  "lib/",
  ".github/",
];
const GENERATED_PREFIXES = [
  "dist/",
  "build/",
  "out/",
  "coverage/",
  "node_modules/",
  ".git/",
];
const NON_PATH_CHARACTERS = /[\s*?{}<>$~`]/u;
// `path:12`, `path:12:3`, `path:878-898`, and GitHub anchors `path#L10-L20`.
const LINE_SUFFIX = /(?::\d+(?:[:-]\d+)*|#L\d+(?:-L\d+)?)$/u;
// A name that runs into a placeholder, brace list, or variable is a template.
const SCRIPT_PLACEHOLDER = /^[<{[$%*]/u;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const MEMBER_REFERENCE = /^([A-Z][A-Za-z0-9_]{3,})\.([A-Za-z_][A-Za-z0-9_]*)$/u;
const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/iu;
const KIND_ORDER: readonly AuditFindingKind[] = [
  "member-missing",
  "path-missing",
  "script-missing",
];

/**
 * Audits the working tree's Markdown against its tree listing and package
 * scripts. Deterministic and AST-only; no provider is constructed.
 */
export async function auditRepository(
  options: AuditOptions = {},
): Promise<AuditReport> {
  const cwd = options.cwd ?? process.cwd();
  let config: PlanningConfig;
  try {
    config =
      options.planningConfig === undefined
        ? loadPlanningConfig(cwd)
        : parsePlanningConfig(options.planningConfig);
  } catch {
    throw new PlanFailure(
      "PLAN_SOURCE_READ_FAILED",
      "Unable to read planning configuration.",
    );
  }
  const reader = new GitSnapshotReader(cwd);
  const { root } = await reader.openWorkingTree();
  const [tree, manifests, pythonEntries] = await Promise.all([
    reader.listTree("head"),
    reader.listPackageManifests("head"),
    reader.listPythonPackageEntries("head"),
  ]);
  const scripts = await readPackageScripts(reader, manifests);
  const surface = await readPublicTypes(reader, config.entry);
  let documentation;
  if (options.paths === undefined) {
    const suppressions =
      options.suppressions ?? (await loadSuppressions(root));
    const discovery = await discoverDocumentationFiles(root, config, {
      packageDirectories: [...manifests, ...pythonEntries].map((path) =>
        posix.dirname(path),
      ),
      extraFiles: AGENT_INSTRUCTION_FILES,
    });
    documentation = {
      files: discovery.files.filter(
        (file) =>
          matchingSuppression(file.path, suppressions.docPaths) === undefined,
      ),
      limitReached: discovery.limitReached,
    };
  } else {
    documentation = await readDocumentationFiles(root, options.paths);
  }
  return assessDocumentationAudit({
    tree,
    scripts,
    docs: documentation.files,
    publicSymbols: surface.types,
    documentationLimitReached: documentation.limitReached,
    boundaryLimitReached: surface.limitReached,
  });
}

/** Audits Markdown references against one repository revision without a diff. */
export function assessDocumentationAudit(input: AuditInput): AuditReport {
  const docs = input.docs.filter((doc) => !isChangelogDocument(doc.path));
  const tree =
    input.tree === undefined ? undefined : indexTree(input.tree);
  const packageDirectories = [...input.scripts.keys()]
    .filter((directory) => directory !== ".")
    .sort(compareStrings);
  const findings = new Map<string, AuditFinding>();
  const add = (finding: AuditFinding): void => {
    const key = [
      finding.file,
      finding.slug,
      finding.kind,
      finding.value,
      finding.evidence,
    ].join("\0");
    if (!findings.has(key)) findings.set(key, finding);
  };

  for (const section of scanDocumentationEvidence([...docs])) {
    const packageDirectory = nearestPackage(section.file, packageDirectories);
    const scripts = knownScripts(input.scripts, packageDirectory);
    const location = {
      file: section.file,
      section: section.section,
      slug: section.slug,
    };
    for (const evidence of section.codeEvidence) {
      if (
        (evidence.fence === "diff" || evidence.fence === "patch") &&
        evidence.text.startsWith("-")
      ) {
        continue;
      }
      if (scripts !== undefined) {
        const missing = missingScript(evidence.text, scripts);
        if (missing !== undefined) {
          add({
            ...location,
            kind: "script-missing",
            value: sanitizeDiagnostic(missing.value),
            ...(missing.closest === undefined
              ? {}
              : { closest: sanitizeDiagnostic(missing.closest) }),
            evidence: "code-span",
          });
        }
      }
      const member = missingMember(evidence.text, input.publicSymbols);
      if (member !== undefined) {
        add({
          ...location,
          kind: "member-missing",
          value: sanitizeDiagnostic(member),
          evidence: "code-span",
        });
      }
      if (tree !== undefined) {
        const path = missingSpanPath(evidence.text, tree, [
          posix.dirname(section.file),
          ...(packageDirectory === undefined ? [] : [packageDirectory]),
        ]);
        if (path !== undefined) {
          add({
            ...location,
            kind: "path-missing",
            value: sanitizeDiagnostic(path),
            evidence: "code-span",
          });
        }
      }
    }
    if (tree === undefined) continue;
    for (const target of section.linkTargets) {
      const path = target.endsWith("/") ? target.slice(0, -1) : target;
      if (path.length === 0 || existsInTree(tree, path)) continue;
      const decoded = decodeTarget(path);
      if (decoded !== undefined && existsInTree(tree, decoded)) continue;
      add({
        ...location,
        kind: "path-missing",
        value: sanitizeDiagnostic(target),
        evidence: "link",
      });
    }
  }

  const sorted = [...findings.values()].sort(
    (left, right) =>
      compareStrings(left.file, right.file) ||
      compareStrings(left.slug, right.slug) ||
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.value, right.value) ||
      compareStrings(left.evidence, right.evidence) ||
      compareStrings(left.section, right.section),
  );
  const byKind = Object.fromEntries(
    KIND_ORDER.map((kind) => [
      kind,
      sorted.filter((finding) => finding.kind === kind).length,
    ]),
  ) as Record<AuditFindingKind, number>;
  const ignored = {
    ...(input.documentationLimitReached === true
      ? { documentationLimitReached: true as const }
      : {}),
    ...(input.tree === undefined ? { treeLimitReached: true as const } : {}),
    ...(input.boundaryLimitReached === true
      ? { boundaryLimitReached: true as const }
      : {}),
  };
  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    revision: input.revision ?? "working-tree",
    summary: {
      findings: sorted.length,
      files: new Set(docs.map((doc) => doc.path)).size,
      byKind,
      ...(sorted.length > AUDIT_FINDING_LIMIT
        ? { truncated: true as const }
        : {}),
    },
    findings: sorted.slice(0, AUDIT_FINDING_LIMIT),
    ...(Object.keys(ignored).length === 0 ? {} : { ignored }),
  };
}

/**
 * Reads the declared members of public TypeScript classes and interfaces.
 * A root declared more than once, in a JavaScript file, or with members
 * that can come from elsewhere is left out, so it gets no member findings.
 */
async function readPublicTypes(
  reader: GitSnapshotReader,
  configuredEntries: readonly string[] | undefined,
): Promise<{ types: Map<string, AuditPublicType>; limitReached: boolean }> {
  const surface = await resolvePublicTypeScriptSurface(
    reader,
    "head",
    configuredEntries,
  );
  const types = new Map<string, AuditPublicType>();
  if (surface.mode === "fallback") {
    return { types, limitReached: surface.reason === "limit-exceeded" };
  }
  const declarations = new Map<string, number>();
  const closed = new Map<string, AuditPublicType>();
  for (const [path, names] of [...surface.reachable].sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    if (!TYPESCRIPT_SOURCE.test(path)) {
      for (const name of names) {
        declarations.set(name, (declarations.get(name) ?? 0) + 1);
      }
      continue;
    }
    let declared;
    try {
      const source = await reader.readAt("head", path);
      declared = source === undefined ? [] : listDeclaredTypeMembers(path, source);
    } catch {
      continue;
    }
    for (const type of declared) {
      if (!names.has(type.name)) continue;
      declarations.set(type.name, (declarations.get(type.name) ?? 0) + 1);
      if (type.closed) {
        closed.set(type.name, { kind: type.kind, members: type.members });
      }
    }
  }
  for (const [name, type] of closed) {
    if (declarations.get(name) === 1) types.set(name, type);
  }
  return { types, limitReached: false };
}

function missingMember(
  text: string,
  publicSymbols: ReadonlyMap<string, AuditPublicType> | undefined,
): string | undefined {
  if (publicSymbols === undefined) return undefined;
  const span = text.trim();
  const match = MEMBER_REFERENCE.exec(span);
  if (match === null) return undefined;
  const type = publicSymbols.get(match[1]);
  if (type === undefined || type.members.includes(match[2])) return undefined;
  return span;
}

async function readPackageScripts(
  reader: GitSnapshotReader,
  manifests: readonly string[],
): Promise<Map<string, readonly string[] | null>> {
  const scripts = new Map<string, readonly string[] | null>();
  for (const manifest of manifests) {
    scripts.set(
      posix.dirname(manifest),
      await readManifestScripts(reader, manifest),
    );
  }
  return scripts;
}

async function readManifestScripts(
  reader: GitSnapshotReader,
  manifest: string,
): Promise<readonly string[] | null> {
  let parsed: unknown;
  try {
    const source = await reader.readAt("head", manifest);
    if (source === undefined) return null;
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const declared = (parsed as Record<string, unknown>).scripts;
  if (declared === undefined) return [];
  if (
    typeof declared !== "object" ||
    declared === null ||
    Array.isArray(declared)
  ) {
    return null;
  }
  return Object.entries(declared)
    .filter(([, command]) => typeof command === "string")
    .map(([name]) => name)
    .sort(compareStrings);
}

interface TreeIndex {
  entries: ReadonlySet<string>;
  directories: ReadonlySet<string>;
}

function indexTree(entries: ReadonlySet<string>): TreeIndex {
  const directories = new Set<string>();
  for (const entry of entries) {
    let slash = entry.lastIndexOf("/");
    while (slash > 0) {
      const directory = entry.slice(0, slash);
      if (directories.has(directory)) break;
      directories.add(directory);
      slash = directory.lastIndexOf("/");
    }
  }
  return { entries, directories };
}

function existsInTree(tree: TreeIndex, path: string): boolean {
  return tree.entries.has(path) || tree.directories.has(path);
}

function decodeTarget(target: string): string | undefined {
  if (!target.includes("%")) return undefined;
  try {
    return decodeURIComponent(target);
  } catch {
    return undefined;
  }
}

function nearestPackage(
  file: string,
  packageDirectories: readonly string[],
): string | undefined {
  let nearest: string | undefined;
  for (const directory of packageDirectories) {
    if (
      file.startsWith(`${directory}/`) &&
      (nearest === undefined || directory.length > nearest.length)
    ) {
      nearest = directory;
    }
  }
  return nearest;
}

function knownScripts(
  scripts: ReadonlyMap<string, readonly string[] | null>,
  packageDirectory: string | undefined,
): ReadonlySet<string> | undefined {
  const root = scripts.get(".");
  const scoped =
    packageDirectory === undefined ? undefined : scripts.get(packageDirectory);
  // An unreadable manifest could hold any script, so nothing is reported.
  if (root === null || scoped === null) return undefined;
  if (root === undefined && scoped === undefined) return undefined;
  return new Set([...(root ?? []), ...(scoped ?? [])]);
}

function missingScript(
  text: string,
  scripts: ReadonlySet<string>,
): { value: string; closest?: string } | undefined {
  const span = text.trimStart();
  const match = SCRIPT_INVOCATION.exec(span);
  if (match === null) return undefined;
  const [invocation, manager, run, name] = match;
  if (name.startsWith("-") || PACKAGE_MANAGER_COMMANDS.has(name)) {
    return undefined;
  }
  if (SCRIPT_PLACEHOLDER.test(span.slice(invocation.length))) return undefined;
  if (run === undefined) {
    if (manager === "npm" && !NPM_SCRIPT_ALIASES.has(name)) return undefined;
    if (manager === "bun" && BUN_NATIVE_COMMANDS.has(name)) return undefined;
  }
  const rest = span.slice(invocation.length).split(SHELL_SEPARATOR, 1)[0];
  if (rest.split(/\s+/u).some((token) => WORKSPACE_FLAG.test(token))) {
    return undefined;
  }
  if (scripts.has(name)) return undefined;
  const value = `${manager} ${run === undefined ? "" : "run "}${name}`;
  const closest = closestScript(name, scripts);
  return closest === undefined ? { value } : { value, closest };
}

function closestScript(
  name: string,
  scripts: ReadonlySet<string>,
): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of scripts) {
    if (Math.abs(candidate.length - name.length) > 2) continue;
    const distance = levenshtein(name, candidate);
    if (
      distance <= 2 &&
      (best === undefined ||
        distance < best.distance ||
        (distance === best.distance && candidate < best.name))
    ) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
}

function levenshtein(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function missingSpanPath(
  text: string,
  tree: TreeIndex,
  bases: readonly string[],
): string | undefined {
  const span = text.trim();
  if (
    !span.includes("/") ||
    NON_PATH_CHARACTERS.test(span) ||
    span.startsWith("/") ||
    span.startsWith("http") ||
    URI_SCHEME.test(span)
  ) {
    return undefined;
  }
  const path = normalizeSpanPath(span.replace(LINE_SUFFIX, ""));
  if (path === undefined) return undefined;
  const prefixed = PATH_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix));
  if (
    GENERATED_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix)) ||
    path.split("/").some((part) => part === "node_modules" || part === ".git")
  ) {
    return undefined;
  }
  if (!prefixed && !PATH_EXTENSION.test(path)) return undefined;
  const resolutions = ["", ...new Set(bases)]
    .map((base) => normalizeSpanPath(posix.join(base, path)))
    .filter((candidate): candidate is string => candidate !== undefined);
  if (resolutions.some((candidate) => existsInTree(tree, candidate))) {
    return undefined;
  }
  if (!prefixed) {
    // Without a known source prefix, a missing first directory more likely
    // means a host name, package subpath, or placeholder than a stale path.
    const first = path.split("/", 1)[0];
    const firstExists = ["", ...new Set(bases)].some((base) => {
      const directory = normalizeSpanPath(posix.join(base, first));
      return directory !== undefined && tree.directories.has(directory);
    });
    if (!firstExists) return undefined;
  }
  return path;
}

function normalizeSpanPath(value: string): string | undefined {
  const normalized = posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return undefined;
  }
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
