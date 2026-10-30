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
/** Package manifests read for scripts and bins; past it, script rules are skipped. */
export const AUDIT_MANIFEST_LIMIT = 1000;
const MANIFEST_READ_CONCURRENCY = 8;

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
    /** More package manifests than the audit reads, so script rules were skipped. */
    manifestLimitReached?: true;
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
  /** Bins that pnpm, yarn, and bun run without a script: dependencies and workspace bins. */
  binaries?: ReadonlySet<string>;
  /** Python package directories; relative paths may resolve against them. */
  packageRoots?: readonly string[];
  docs: readonly DocumentationFile[];
  /** Closed public types by name; roots absent here get no member findings. */
  publicSymbols?: ReadonlyMap<string, AuditPublicType>;
  revision?: string;
  documentationLimitReached?: boolean;
  manifestLimitReached?: boolean;
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
  "approve-builds",
  "bin",
  "catalog",
  "constraints",
  "deploy",
  "doctor",
  "env",
  "explain",
  "fetch",
  "import",
  "licenses",
  "node",
  "npm",
  "patch",
  "patch-commit",
  "patch-remove",
  "plugin",
  "root",
  "search",
  "self-update",
  "set",
  "setup",
  "stage",
  "unplug",
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
// Bins whose names differ from the package that declares them.
const PACKAGE_BIN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "@biomejs/biome": ["biome"],
  "@changesets/cli": ["changeset"],
  "@playwright/test": ["playwright"],
  typescript: ["tsc", "tsserver"],
};
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const RELEASE_NOTES_BASENAME = /^release[-_ ]?notes(?:\.md)?$/iu;
// Common documentation translation folders, with an optional region or script.
const LANGUAGE_FOLDER =
  /^(?:ar|az|bg|bn|ca|cs|da|de|el|es|et|fa|fi|fr|he|hi|hu|id|it|ja|ka|kk|ko|lt|lv|ms|nb|nl|no|pl|pt|ro|ru|sk|sl|sr|sv|ta|th|tl|tr|uk|ur|uz|vi|yo|zh)(?:[-_][A-Za-z]{2,4})?$/u;
// Code examples under these folders often show the reader's own project.
const GUIDE_FOLDERS = new Set(["docs", "doc", "documentation", "guide", "guides"]);
// Files that describe this repository wherever they live.
const REPOSITORY_FILES = new Set([
  "agents.md",
  "claude.md",
  "contributing.md",
  "copilot-instructions.md",
]);
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
// `path:12`, `path:12:3`, `path:878-898`, and anchors `path#L10-L20`, `page.md#usage`.
const LOCATION_SUFFIX = /(?::\d+(?:[:-]\d+)*|#[^\s#/]*)$/u;
// A name that runs into a placeholder, brace list, variable, or path segment
// is a template or a file, not a script.
const SCRIPT_PLACEHOLDER = /^[<{[$%*/]/u;
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
  const [tree, listedManifests, pythonEntries] = await Promise.all([
    reader.listTree("head"),
    reader.listPackageManifests("head", AUDIT_MANIFEST_LIMIT + 1),
    reader.listPythonPackageEntries("head"),
  ]);
  const manifestLimitReached = listedManifests.length > AUDIT_MANIFEST_LIMIT;
  const manifests = listedManifests.slice(0, AUDIT_MANIFEST_LIMIT);
  const packages = await readPackageManifests(reader, manifests);
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
    scripts: packages.scripts,
    binaries: packages.binaries,
    packageRoots: pythonEntries.map((path) => posix.dirname(path)),
    docs: documentation.files,
    publicSymbols: surface.types,
    documentationLimitReached: documentation.limitReached,
    manifestLimitReached,
    boundaryLimitReached: surface.limitReached,
  });
}

/** Audits Markdown references against one repository revision without a diff. */
export function assessDocumentationAudit(input: AuditInput): AuditReport {
  const tree =
    input.tree === undefined ? undefined : indexTree(input.tree);
  const docs = input.docs.filter(
    (doc) =>
      !isChangelogDocument(doc.path) &&
      !RELEASE_NOTES_BASENAME.test(posix.basename(doc.path)) &&
      (tree === undefined || !isTranslatedCopy(doc.path, tree)),
  );
  const packageDirectories = [...input.scripts.keys()]
    .filter((directory) => directory !== ".")
    .sort(compareStrings);
  const packageRoots = [
    ...new Set([...packageDirectories, ...(input.packageRoots ?? [])]),
  ]
    .filter((directory) => directory !== ".")
    .sort(compareStrings);
  const binaries = input.binaries ?? new Set<string>();
  // A document may describe commands run inside any workspace package.
  const allScripts = new Set(
    [...input.scripts.values()].flatMap((names) => names ?? []),
  );
  let basenames: ReadonlySet<string> | undefined;
  const hasNamesake = (index: TreeIndex, path: string): boolean => {
    basenames ??= indexBasenames(index);
    return basenames.has(posix.basename(path));
  };
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
    const scripts =
      input.manifestLimitReached === true
        ? undefined
        : knownScripts(input.scripts, packageDirectory, allScripts);
    // In a guide, a missing script or path in a code example counts only
    // with a rename signal; links are checked everywhere.
    const guide = isGuideDocument(section.file);
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
        const missing = missingScript(evidence.text, scripts, binaries);
        if (
          missing !== undefined &&
          (!guide || missing.closest !== undefined)
        ) {
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
        const path = missingSpanPath(
          evidence.text,
          tree,
          [
            posix.dirname(section.file),
            ...(packageDirectory === undefined ? [] : [packageDirectory]),
          ],
          packageRoots,
        );
        if (path !== undefined && (!guide || hasNamesake(tree, path))) {
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
      if (path.length === 0 || linkExists(tree, path)) continue;
      const decoded = decodeTarget(path);
      if (decoded !== undefined && linkExists(tree, decoded)) continue;
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
    ...(input.manifestLimitReached === true
      ? { manifestLimitReached: true as const }
      : {}),
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

interface PackageManifest {
  scripts: readonly string[] | null;
  binaries: readonly string[];
}

async function readPackageManifests(
  reader: GitSnapshotReader,
  manifests: readonly string[],
): Promise<{
  scripts: Map<string, readonly string[] | null>;
  binaries: Set<string>;
}> {
  const read: PackageManifest[] = [];
  for (
    let start = 0;
    start < manifests.length;
    start += MANIFEST_READ_CONCURRENCY
  ) {
    read.push(
      ...(await Promise.all(
        manifests
          .slice(start, start + MANIFEST_READ_CONCURRENCY)
          .map((manifest) => readManifest(reader, manifest)),
      )),
    );
  }
  const scripts = new Map<string, readonly string[] | null>();
  const binaries = new Set<string>();
  manifests.forEach((manifest, index) => {
    scripts.set(posix.dirname(manifest), read[index].scripts);
    for (const binary of read[index].binaries) binaries.add(binary);
  });
  return { scripts, binaries };
}

async function readManifest(
  reader: GitSnapshotReader,
  manifest: string,
): Promise<PackageManifest> {
  let parsed: unknown;
  try {
    const source = await reader.readAt("head", manifest);
    if (source === undefined) return { scripts: null, binaries: [] };
    parsed = JSON.parse(source);
  } catch {
    return { scripts: null, binaries: [] };
  }
  if (!isRecord(parsed)) return { scripts: null, binaries: [] };
  return { scripts: manifestScripts(parsed), binaries: manifestBins(parsed) };
}

function manifestScripts(
  manifest: Record<string, unknown>,
): readonly string[] | null {
  const declared = manifest.scripts;
  if (declared === undefined) return [];
  if (!isRecord(declared)) return null;
  return Object.entries(declared)
    .filter(([, command]) => typeof command === "string")
    .map(([name]) => name)
    .sort(compareStrings);
}

/** Bins a package manager can run from this manifest's dependencies or own `bin`. */
function manifestBins(manifest: Record<string, unknown>): string[] {
  const bins: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      bins.push(name, ...(PACKAGE_BIN_ALIASES[name] ?? []));
    }
  }
  const { bin, name } = manifest;
  if (isRecord(bin)) {
    bins.push(...Object.keys(bin));
  } else if (typeof bin === "string" && typeof name === "string") {
    bins.push(name.slice(name.lastIndexOf("/") + 1));
  }
  return bins;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function indexBasenames(tree: TreeIndex): Set<string> {
  const names = new Set<string>();
  for (const path of [...tree.entries, ...tree.directories]) {
    names.add(posix.basename(path));
  }
  return names;
}

/** A page under a language folder whose original exists without it or under `en`. */
function isTranslatedCopy(path: string, tree: TreeIndex): boolean {
  const parts = path.split("/");
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!LANGUAGE_FOLDER.test(parts[index])) continue;
    const before = parts.slice(0, index);
    const after = parts.slice(index + 1);
    if (
      tree.entries.has([...before, ...after].join("/")) ||
      tree.entries.has([...before, "en", ...after].join("/"))
    ) {
      return true;
    }
  }
  return false;
}

function isGuideDocument(path: string): boolean {
  return (
    GUIDE_FOLDERS.has(path.split("/", 1)[0]) &&
    !REPOSITORY_FILES.has(posix.basename(path).toLowerCase())
  );
}

function existsInTree(tree: TreeIndex, path: string): boolean {
  return tree.entries.has(path) || tree.directories.has(path);
}

/** Static site generators link a page as `page`, `page.html`, or `page.md`. */
function linkExists(tree: TreeIndex, path: string): boolean {
  if (existsInTree(tree, path)) return true;
  const basename = posix.basename(path);
  if (basename.endsWith(".html")) {
    return tree.entries.has(`${path.slice(0, -".html".length)}.md`);
  }
  return !basename.includes(".") && tree.entries.has(`${path}.md`);
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
  allScripts: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  const root = scripts.get(".");
  const scoped =
    packageDirectory === undefined ? undefined : scripts.get(packageDirectory);
  // An unreadable root or own manifest could hold any script, so nothing is
  // reported; an unreadable manifest elsewhere, often a test fixture, is not.
  if (root === null || scoped === null) return undefined;
  if (root === undefined && scoped === undefined) return undefined;
  return allScripts;
}

function missingScript(
  text: string,
  scripts: ReadonlySet<string>,
  binaries: ReadonlySet<string>,
): { value: string; closest?: string } | undefined {
  const span = text.trimStart();
  const match = SCRIPT_INVOCATION.exec(span);
  if (match === null) return undefined;
  const [invocation, manager, run, name] = match;
  // After `run` every name is a script, even `npm run deploy`.
  if (
    name.startsWith("-") ||
    (run === undefined && PACKAGE_MANAGER_COMMANDS.has(name))
  ) {
    return undefined;
  }
  if (SCRIPT_PLACEHOLDER.test(span.slice(invocation.length))) return undefined;
  if (run === undefined) {
    if (manager === "npm" && !NPM_SCRIPT_ALIASES.has(name)) return undefined;
    if (manager === "bun" && BUN_NATIVE_COMMANDS.has(name)) return undefined;
  }
  // bun runs files; pnpm (without `run`), yarn, and bun run dependency bins.
  if (manager === "bun" && SOURCE_FILE.test(name)) return undefined;
  if (
    binaries.has(name) &&
    (manager === "yarn" ||
      manager === "bun" ||
      (manager === "pnpm" && run === undefined))
  ) {
    return undefined;
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
  packageRoots: readonly string[],
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
  const path = normalizeSpanPath(span.replace(LOCATION_SUFFIX, ""));
  if (path === undefined) return undefined;
  // A bare folder name such as `lib/` names a convention, not a file here.
  if (!path.includes("/") && !PATH_EXTENSION.test(path)) return undefined;
  const prefixed = PATH_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix));
  if (
    GENERATED_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix)) ||
    path.split("/").some((part) => part === "node_modules" || part === ".git")
  ) {
    return undefined;
  }
  if (!prefixed && !PATH_EXTENSION.test(path)) return undefined;
  // A root document may describe any workspace or Python package's layout.
  const resolutions = ["", ...new Set([...bases, ...packageRoots])]
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
