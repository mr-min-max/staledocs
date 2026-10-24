import { execFile as execFileCallback } from "node:child_process";
import { promises as fs, type BigIntStats } from "node:fs";
import { promisify } from "node:util";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { SnapshotDescriptor, PlanFailure } from "../impact/types";

const execFile = promisify(execFileCallback);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_BUFFER = 4 * 1024 * 1024;
const WORKTREE_READ_TIMEOUT_MS = 5_000;
const TREE_ENTRY_LIMIT = 200_000;
const TREE_LISTING_MAX_BYTES = 32 * 1024 * 1024;
const STATUS = new Set(["A", "M", "D", "R", "T"]);

interface PathSemantics {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  readonly sep: string;
}

interface FilesystemIdentity {
  dev: string;
  ino: string;
  type: string;
}

interface ValidatedWorktreePath {
  leaf: string;
  parentAbsolute: string;
  parentIdentity: FilesystemIdentity;
  leafIdentity: FilesystemIdentity;
}

const NATIVE_PATH_SEMANTICS: PathSemantics = { relative, isAbsolute, sep };
const WORKTREE_READER_SCRIPT = String.raw`
const fs = require("node:fs");
const [
  leaf,
  expectedParentDev,
  expectedParentIno,
  expectedParentType,
  expectedLeafDev,
  expectedLeafIno,
  expectedLeafType,
] = process.argv.slice(1);
let descriptor;

function identity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    type: (stat.mode & 0o170000n).toString(),
  };
}

function sameSnapshot(left, right) {
  const leftIdentity = identity(left);
  const rightIdentity = identity(right);
  return leftIdentity.dev === rightIdentity.dev &&
    leftIdentity.ino === rightIdentity.ino &&
    leftIdentity.type === rightIdentity.type &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

try {
  if (typeof leaf !== "string" || leaf.length === 0 || leaf === "." ||
      leaf === ".." || leaf.includes("/") || leaf.includes("\\") ||
      leaf.includes("\0")) throw new Error();
  const parent = fs.lstatSync(".", { bigint: true });
  const parentIdentity = identity(parent);
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      parentIdentity.dev !== expectedParentDev ||
      parentIdentity.ino !== expectedParentIno ||
      parentIdentity.type !== expectedParentType) throw new Error();
  descriptor = fs.openSync(
    leaf,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  const before = fs.fstatSync(descriptor, { bigint: true });
  const beforeIdentity = identity(before);
  if (!before.isFile() || before.isSymbolicLink() ||
      beforeIdentity.dev !== expectedLeafDev ||
      beforeIdentity.ino !== expectedLeafIno ||
      beforeIdentity.type !== expectedLeafType) throw new Error();
  const source = fs.readFileSync(descriptor, { encoding: "utf8" });
  const after = fs.fstatSync(descriptor, { bigint: true });
  if (!sameSnapshot(before, after)) throw new Error();
  process.stdout.write(source);
} catch {
  process.exitCode = 1;
} finally {
  if (descriptor !== undefined) {
    try { fs.closeSync(descriptor); } catch {}
  }
}
`;

/** Returns whether a candidate is the root itself or a platform-safe descendant. */
export function isPathWithinRoot(
  root: string,
  candidate: string,
  pathSemantics: PathSemantics = NATIVE_PATH_SEMANTICS,
): boolean {
  const relativePath = pathSemantics.relative(root, candidate);
  return (
    relativePath.length === 0 ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${pathSemantics.sep}`) &&
      !pathSemantics.isAbsolute(relativePath))
  );
}

export type SnapshotFileStatus = "added" | "modified" | "deleted" | "renamed";
export interface SnapshotFileChange {
  status: SnapshotFileStatus;
  beforePath?: string;
  afterPath?: string;
  beforeSource?: string;
  afterSource?: string;
  supported: boolean;
  excluded: boolean;
  analysis?: "commonjs" | "unsupported";
}
export interface TreeListingLimits {
  /** Maximum distinct entries; above it the listing is unavailable. */
  entries?: number;
  /** Maximum bytes of each Git listing command's output. */
  bytes?: number;
}
export interface GitSnapshotSet {
  root: string;
  base: SnapshotDescriptor;
  head: SnapshotDescriptor;
  files: SnapshotFileChange[];
  ignored: { unsupported: number; excluded: number };
}

/** Reads bounded Git/worktree snapshots and captures source text for planning. */
export class GitSnapshotReader {
  private repositoryRoot?: string;
  private baseCommit?: string;
  private headCommit?: string;
  private headUsesWorkingTree = false;
  private readonly trees = new Map<
    "base" | "head",
    ReadonlySet<string> | undefined
  >();

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Resolves the selected refs, classifies changed paths, and captures safe sources. */
  async read(options: {
    base?: string;
    head?: string;
    include: string[];
    exclude: string[];
  }): Promise<GitSnapshotSet> {
    const headLabel = options.head ?? "HEAD";
    this.validateRef(headLabel);
    let baseLabel = options.base ?? this.env.STALEDOCS_BASE_REF;
    if (baseLabel !== undefined && baseLabel.length > 0) {
      this.validateRef(baseLabel);
    }
    const root = await this.gitRoot();
    this.repositoryRoot = root;
    const headCommit = await this.resolveCommit(
      headLabel,
      "PLAN_HEAD_NOT_FOUND",
    );
    if (!baseLabel) baseLabel = await this.discoverBase(headCommit);
    const baseCommit = await this.resolveBase(baseLabel);
    const immutable = options.head !== undefined;
    this.baseCommit = baseCommit;
    this.headCommit = headCommit;
    this.headUsesWorkingTree = !immutable;
    this.trees.clear();
    const changes = immutable
      ? await this.committedDiff(baseCommit, headCommit)
      : await this.workingDiff(baseCommit);
    const files: SnapshotFileChange[] = [];
    let unsupported = 0;
    let excluded = 0;
    for (const change of changes) {
      const paths = [change.beforePath, change.afterPath].filter(
        (p): p is string => p !== undefined,
      );
      const normalized = paths.map((p) => normalizePath(p));
      if (normalized.some((p) => p === undefined))
        throw new PlanFailure(
          "PLAN_SOURCE_READ_FAILED",
          "Unable to read repository source.",
        );
      const beforePath = change.beforePath
        ? normalizePath(change.beforePath)!
        : undefined;
      const afterPath = change.afterPath
        ? normalizePath(change.afterPath)!
        : undefined;
      let effectiveChange = { ...change, beforePath, afterPath };
      if (change.status === "renamed") {
        const before = classifyPath(beforePath!, options);
        const after = classifyPath(afterPath!, options);
        if (!before.supported) unsupported++;
        else if (!before.inScope) excluded++;
        if (!after.supported) unsupported++;
        else if (!after.inScope) excluded++;

        if (before.inScope && !after.inScope) {
          effectiveChange = {
            status: "deleted" as const,
            beforePath,
            afterPath: undefined,
          };
        } else if (!before.inScope && after.inScope) {
          effectiveChange = {
            status: "added" as const,
            beforePath: undefined,
            afterPath,
          };
        } else if (!before.inScope && !after.inScope) {
          files.push({
            ...effectiveChange,
            supported: before.supported || after.supported,
            excluded:
              (before.supported && !before.inScope) ||
              (after.supported && !after.inScope),
            ...(!before.supported && !after.supported
              ? { analysis: "unsupported" as const }
              : {}),
          });
          continue;
        }
      } else {
        const endpoint = classifyPath(afterPath ?? beforePath!, options);
        if (!endpoint.supported) unsupported++;
        else if (!endpoint.inScope) excluded++;
        if (!endpoint.inScope) {
          files.push({
            ...effectiveChange,
            supported: endpoint.supported,
            excluded: endpoint.supported,
            ...(endpoint.supported ? {} : { analysis: "unsupported" as const }),
          });
          continue;
        }
      }

      let beforeSource: string | undefined;
      let afterSource: string | undefined;
      if (effectiveChange.beforePath && effectiveChange.status !== "added") {
        beforeSource = await this.blob(baseCommit, effectiveChange.beforePath);
      }
      if (effectiveChange.afterPath && effectiveChange.status !== "deleted") {
        afterSource = immutable
          ? await this.blob(headCommit, effectiveChange.afterPath)
          : await this.worktreeFile(root, effectiveChange.afterPath);
      }
      files.push({
        ...effectiveChange,
        beforeSource,
        afterSource,
        supported: true,
        excluded: false,
      });
    }
    return {
      root,
      base: { type: "git", label: baseLabel, commit: baseCommit },
      head: {
        type: immutable ? "git" : "working-tree",
        label: headLabel,
        ...(immutable ? { commit: headCommit } : {}),
      },
      files,
      ignored: { unsupported, excluded },
    };
  }

  /** Pins HEAD and the working tree for single-revision reads without a diff. */
  async openWorkingTree(): Promise<{ root: string; head: SnapshotDescriptor }> {
    const root = await this.gitRoot();
    this.repositoryRoot = root;
    this.headCommit = await this.resolveCommit("HEAD", "PLAN_HEAD_NOT_FOUND");
    this.headUsesWorkingTree = true;
    this.trees.clear();
    return { root, head: { type: "working-tree", label: "HEAD" } };
  }

  /**
   * Lists every path at a revision once, from `git ls-tree` or, for a
   * working-tree head, tracked plus untracked non-ignored files. Returns
   * undefined when the entry or byte bound is exceeded.
   */
  async listTree(
    revision: "base" | "head",
    limits: TreeListingLimits = {},
  ): Promise<ReadonlySet<string> | undefined> {
    if (this.trees.has(revision)) return this.trees.get(revision);
    const commit = revision === "base" ? this.baseCommit : this.headCommit;
    const entryLimit = limits.entries ?? TREE_ENTRY_LIMIT;
    const byteLimit = limits.bytes ?? TREE_LISTING_MAX_BYTES;
    if (
      commit === undefined ||
      !Number.isSafeInteger(entryLimit) ||
      !Number.isSafeInteger(byteLimit)
    ) {
      throw new PlanFailure(
        "PLAN_SOURCE_READ_FAILED",
        "Unable to read repository snapshot.",
      );
    }
    let tree: Set<string> | undefined = new Set<string>();
    try {
      const outputs =
        revision === "head" && this.headUsesWorkingTree
          ? await Promise.all([
              this.runBounded(["ls-files", "-z", "--"], byteLimit),
              this.runBounded(
                ["ls-files", "--others", "--exclude-standard", "-z", "--"],
                byteLimit,
              ),
            ])
          : [
              await this.runBounded(
                ["ls-tree", "-r", "--name-only", "-z", commit, "--"],
                byteLimit,
              ),
            ];
      for (const path of outputs.flatMap(parseNulPaths)) {
        const normalized = normalizePath(path);
        if (normalized === undefined) continue;
        tree.add(normalized);
        if (tree.size > entryLimit) {
          tree = undefined;
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof TreeListingTooLarge)) {
        throw new PlanFailure(
          "PLAN_SOURCE_READ_FAILED",
          "Unable to read repository snapshot.",
        );
      }
      tree = undefined;
    }
    this.trees.set(revision, tree);
    return tree;
  }

  /** Reads a repository file at the base commit, head commit, or working tree. */
  async readAt(
    revision: "base" | "head",
    path: string,
  ): Promise<string | undefined> {
    const normalized = normalizePath(path);
    const root = this.repositoryRoot;
    const commit = revision === "base" ? this.baseCommit : this.headCommit;
    if (
      normalized === undefined ||
      root === undefined ||
      commit === undefined
    ) {
      throw new PlanFailure(
        "PLAN_SOURCE_READ_FAILED",
        "Unable to read repository source.",
      );
    }
    if (revision === "head" && this.headUsesWorkingTree) {
      try {
        return await this.worktreeFile(root, normalized);
      } catch (error) {
        if (
          error instanceof PlanFailure &&
          error.code === "PLAN_UNSAFE_WORKTREE_PATH"
        ) {
          try {
            await fs.lstat(resolve(root, normalized));
          } catch (statError) {
            if (
              typeof statError === "object" &&
              statError !== null &&
              "code" in statError &&
              statError.code === "ENOENT"
            ) {
              return undefined;
            }
          }
        }
        throw error;
      }
    }
    return this.optionalBlob(commit, normalized);
  }

  /** Lists bounded package manifests at an immutable or working-tree revision. */
  async listPackageManifests(
    revision: "base" | "head",
    limit = 50,
  ): Promise<string[]> {
    const commit = revision === "base" ? this.baseCommit : this.headCommit;
    if (commit === undefined || !Number.isSafeInteger(limit)) {
      throw new PlanFailure(
        "PLAN_SOURCE_READ_FAILED",
        "Unable to read repository snapshot.",
      );
    }
    if (limit <= 0) return [];
    try {
      const output =
        revision === "head" && this.headUsesWorkingTree
          ? (
              await Promise.all([
                this.run(["ls-files", "-z", "--"]),
                this.run([
                  "ls-files",
                  "--others",
                  "--exclude-standard",
                  "-z",
                  "--",
                ]),
              ])
            ).join("")
          : await this.run([
              "ls-tree",
              "-r",
              "--name-only",
              "-z",
              commit,
              "--",
            ]);
      return [...new Set(parseNulPaths(output))]
        .map(normalizePath)
        .filter((candidate): candidate is string => candidate !== undefined)
        .filter((candidate) => {
          const parts = candidate.split("/");
          return (
            posix.basename(candidate) === "package.json" &&
            !parts.some((part) =>
              ["node_modules", "dist", "build"].includes(part),
            )
          );
        })
        .sort()
        .slice(0, limit);
    } catch {
      throw new PlanFailure(
        "PLAN_SOURCE_READ_FAILED",
        "Unable to read repository snapshot.",
      );
    }
  }

  /** Lists package initializers, capped before boundary selection. */
  async listPythonPackageEntries(
    revision: "base" | "head",
    limit = 21,
  ): Promise<string[]> {
    const commit = revision === "base" ? this.baseCommit : this.headCommit;
    if (commit === undefined || !Number.isSafeInteger(limit)) {
      throw new PlanFailure(
        "PLAN_SOURCE_READ_FAILED",
        "Unable to read repository snapshot.",
      );
    }
    if (limit <= 0) return [];
    try {
      const output =
        revision === "head" && this.headUsesWorkingTree
          ? (
              await Promise.all([
                this.run(["ls-files", "-z", "--"]),
                this.run([
                  "ls-files",
                  "--others",
                  "--exclude-standard",
                  "-z",
                  "--",
                ]),
              ])
            ).join("")
          : await this.run([
              "ls-tree",
              "-r",
              "--name-only",
              "-z",
              commit,
              "--",
            ]);
      return [...new Set(parseNulPaths(output))]
        .map(normalizePath)
        .filter((candidate): candidate is string => candidate !== undefined)
        .filter((candidate) => {
          const parts = candidate.split("/");
          return (
            parts[parts.length - 1] === "__init__.py" &&
            parts.length >= 2 &&
            parts.length <= 4
          );
        })
        .sort()
        .slice(0, limit);
    } catch {
      throw new PlanFailure(
        "PLAN_SOURCE_READ_FAILED",
        "Unable to read repository snapshot.",
      );
    }
  }

  private async gitRoot(): Promise<string> {
    try {
      return (await this.run(["rev-parse", "--show-toplevel"])).trim();
    } catch {
      throw new PlanFailure(
        "PLAN_NOT_GIT_REPOSITORY",
        "The current directory is not a Git repository.",
      );
    }
  }
  private async run(args: string[]): Promise<string> {
    try {
      const result = await execFile("git", args, {
        cwd: this.repositoryRoot ?? this.cwd,
        env: this.env,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      });
      return result.stdout;
    } catch {
      throw new Error("git command failed");
    }
  }
  private async runBounded(args: string[], maxBuffer: number): Promise<string> {
    try {
      const result = await execFile("git", args, {
        cwd: this.repositoryRoot ?? this.cwd,
        env: this.env,
        maxBuffer,
        windowsHide: true,
      });
      return result.stdout;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ) {
        throw new TreeListingTooLarge();
      }
      throw new Error("git command failed", { cause: error });
    }
  }
  private validateRef(ref: string): void {
    if (
      ref.startsWith("-") ||
      [...ref].some((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      })
    )
      throw new PlanFailure(
        "PLAN_INVALID_REF",
        "The Git reference is invalid.",
      );
  }
  private async resolveCommit(
    ref: string,
    code: "PLAN_BASE_NOT_FOUND" | "PLAN_HEAD_NOT_FOUND",
  ): Promise<string> {
    this.validateRef(ref);
    try {
      return (
        await this.run(["rev-parse", "--verify", `${ref}^{commit}`])
      ).trim();
    } catch {
      throw new PlanFailure(
        code,
        code === "PLAN_HEAD_NOT_FOUND"
          ? "The Git head could not be resolved."
          : "The Git base could not be resolved.",
      );
    }
  }
  private async resolveBase(ref: string): Promise<string> {
    this.validateRef(ref);
    if (ref === EMPTY_TREE) return ref;
    try {
      return await this.resolveCommit(ref, "PLAN_BASE_NOT_FOUND");
    } catch {
      try {
        if (
          (await this.run(["rev-parse", "--is-shallow-repository"])).trim() ===
          "true"
        )
          throw new PlanFailure(
            "PLAN_SHALLOW_HISTORY",
            "The selected Git base is unavailable in this shallow repository.",
          );
      } catch (e) {
        if (e instanceof PlanFailure) throw e;
      }
      throw new PlanFailure(
        "PLAN_BASE_NOT_FOUND",
        "The Git base could not be resolved.",
      );
    }
  }
  private async discoverBase(head: string): Promise<string> {
    const candidates: string[] = [];
    try {
      const symbolic = (
        await this.run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
      ).trim();
      if (symbolic) candidates.push(symbolic);
    } catch {
      /* absent */
    }
    candidates.push("origin/main", "main", "origin/master", "master", "HEAD~1");
    for (const candidate of candidates) {
      try {
        const resolved = await this.resolveCommit(
          candidate,
          "PLAN_BASE_NOT_FOUND",
        );
        if (resolved === head && !(await this.hasParent(head))) {
          if (await this.isShallow()) throw this.shallowHistoryFailure();
          return EMPTY_TREE;
        }
        return resolved;
      } catch (error) {
        if (
          error instanceof PlanFailure &&
          error.code === "PLAN_SHALLOW_HISTORY"
        )
          throw error;
        /* next */
      }
    }
    try {
      await this.resolveCommit("HEAD~1", "PLAN_BASE_NOT_FOUND");
    } catch {
      if (await this.isShallow()) throw this.shallowHistoryFailure();
      return EMPTY_TREE;
    }
    return head;
  }
  private async isShallow(): Promise<boolean> {
    try {
      return (
        (await this.run(["rev-parse", "--is-shallow-repository"])).trim() ===
        "true"
      );
    } catch {
      return false;
    }
  }
  private shallowHistoryFailure(): PlanFailure {
    return new PlanFailure(
      "PLAN_SHALLOW_HISTORY",
      "The selected Git base is unavailable in this shallow repository.",
    );
  }
  private async hasParent(commit: string): Promise<boolean> {
    try {
      await this.run(["rev-parse", "--verify", `${commit}^`]);
      return true;
    } catch {
      return false;
    }
  }
  private async committedDiff(
    base: string,
    head: string,
  ): Promise<
    Omit<
      SnapshotFileChange,
      "supported" | "excluded" | "analysis" | "beforeSource" | "afterSource"
    >[]
  > {
    try {
      const output = await this.run([
        "diff-tree",
        "--root",
        "--name-status",
        "-r",
        "-M",
        "-z",
        base,
        head,
        "--",
      ]);
      return parseStatus(output);
    } catch {
      throw new PlanFailure(
        "PLAN_SOURCE_READ_FAILED",
        "Unable to read repository snapshot.",
      );
    }
  }
  private async workingDiff(
    base: string,
  ): Promise<
    Omit<
      SnapshotFileChange,
      "supported" | "excluded" | "analysis" | "beforeSource" | "afterSource"
    >[]
  > {
    try {
      const [tracked, untracked] = await Promise.all([
        this.run(["diff", "--name-status", "-M", "-z", base, "--"]),
        this.run(["ls-files", "--others", "--exclude-standard", "-z", "--"]),
      ]);
      const result = parseStatus(tracked);
      for (const path of parseNulPaths(untracked))
        result.push({ status: "added", afterPath: path });
      return result;
    } catch {
      throw new PlanFailure(
        "PLAN_SOURCE_READ_FAILED",
        "Unable to read repository snapshot.",
      );
    }
  }
  private async blob(commit: string, path: string): Promise<string> {
    try {
      return await this.run(["show", `${commit}:${path}`, "--"]);
    } catch {
      throw new PlanFailure(
        "PLAN_SOURCE_READ_FAILED",
        "Unable to read repository source.",
        path,
      );
    }
  }
  private async optionalBlob(
    commit: string,
    path: string,
  ): Promise<string | undefined> {
    try {
      return await this.run(["show", `${commit}:${path}`, "--"]);
    } catch {
      try {
        await this.run(["cat-file", "-e", `${commit}^{tree}`]);
        return undefined;
      } catch {
        throw new PlanFailure(
          "PLAN_SOURCE_READ_FAILED",
          "Unable to read repository source.",
          path,
        );
      }
    }
  }
  private async worktreeFile(root: string, path: string): Promise<string> {
    try {
      const validated = await validateWorktreePath(root, path);
      const result = await execFile(
        process.execPath,
        [
          "-e",
          WORKTREE_READER_SCRIPT,
          "--",
          validated.leaf,
          validated.parentIdentity.dev,
          validated.parentIdentity.ino,
          validated.parentIdentity.type,
          validated.leafIdentity.dev,
          validated.leafIdentity.ino,
          validated.leafIdentity.type,
        ],
        {
          cwd: validated.parentAbsolute,
          encoding: "utf8",
          timeout: WORKTREE_READ_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
        },
      );
      return result.stdout;
    } catch {
      throw new PlanFailure(
        "PLAN_UNSAFE_WORKTREE_PATH",
        "The working-tree path is unsafe.",
        path,
      );
    }
  }
}

class TreeListingTooLarge extends Error {}

function normalizePath(value: string): string | undefined {
  if (value.includes("\0") || value.includes("\n") || value.startsWith("/"))
    return undefined;
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  return normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
    ? undefined
    : normalized;
}

function classifyPath(
  path: string,
  options: { include: string[]; exclude: string[] },
): { supported: boolean; inScope: boolean } {
  const supported = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/u.test(path);
  return {
    supported,
    inScope:
      supported &&
      !isMatched(path, options.exclude) &&
      isMatched(path, options.include),
  };
}

async function validateWorktreePath(
  root: string,
  path: string,
): Promise<ValidatedWorktreePath> {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  if (!isPathWithinRoot(absoluteRoot, absolute) || absolute === absoluteRoot) {
    throw new Error();
  }

  let current = absoluteRoot;
  let parentAbsolute = absoluteRoot;
  let stat = await fs.lstat(absoluteRoot, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
  let parentIdentity = filesystemIdentity(stat);
  const components = relative(absoluteRoot, absolute).split(sep);
  for (const [index, component] of components.entries()) {
    if (component.length === 0) throw new Error();
    current = resolve(current, component);
    stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error();
    if (index < components.length - 1) {
      if (!stat.isDirectory()) throw new Error();
      parentAbsolute = current;
      parentIdentity = filesystemIdentity(stat);
    }
  }
  if (!stat.isFile()) throw new Error();

  const [realRoot, realPath] = await Promise.all([
    fs.realpath(absoluteRoot),
    fs.realpath(absolute),
  ]);
  if (!isPathWithinRoot(realRoot, realPath)) throw new Error();

  return {
    leaf: components[components.length - 1],
    parentAbsolute,
    parentIdentity,
    leafIdentity: filesystemIdentity(stat),
  };
}

function filesystemIdentity(stat: BigIntStats): FilesystemIdentity {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    type: (stat.mode & 0o170000n).toString(),
  };
}

function isMatched(path: string, patterns: string[]): boolean {
  return (
    patterns.length > 0 &&
    patterns.some((pattern) => posix.matchesGlob(path, pattern))
  );
}
function parseStatus(
  output: string,
): Omit<
  SnapshotFileChange,
  "supported" | "excluded" | "analysis" | "beforeSource" | "afterSource"
>[] {
  const tokens = parseNulTokens(output);
  const result: Omit<
    SnapshotFileChange,
    "supported" | "excluded" | "analysis" | "beforeSource" | "afterSource"
  >[] = [];
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i++];
    const code = token[0];
    if (
      !code ||
      !STATUS.has(code) ||
      (code === "R" ? !/^R(?:\d{3})?$/u.test(token) : token.length !== 1)
    )
      throw new Error("invalid Git status");
    if (code === "R")
      result.push({
        status: "renamed",
        beforePath: requiredToken(tokens[i++]),
        afterPath: requiredToken(tokens[i++]),
      });
    else {
      const path = requiredToken(tokens[i++]);
      result.push(
        code === "D"
          ? { status: "deleted", beforePath: path }
          : code === "A"
            ? { status: "added", afterPath: path }
            : {
                status: "modified",
                beforePath: path,
                afterPath: path,
              },
      );
    }
  }
  return result;
}

function parseNulPaths(output: string): string[] {
  return parseNulTokens(output).map(requiredToken);
}

function parseNulTokens(output: string): string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) throw new Error("invalid Git output");
  const tokens = output.split("\0");
  tokens.pop();
  return tokens;
}

function requiredToken(value: string | undefined): string {
  if (value === undefined || value.length === 0)
    throw new Error("invalid Git output");
  return value;
}
