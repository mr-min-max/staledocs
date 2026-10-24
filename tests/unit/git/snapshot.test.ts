import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  promises as fs,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { execFileSync } from "node:child_process";
import { GitSnapshotReader, isPathWithinRoot } from "../../../src/git/snapshot";
import { PlanFailure } from "../../../src/impact/types";

const INVALID_REF_CODE_POINTS = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
  0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
  0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f,
] as const;

const INVALID_REF_SOURCES = ["head", "base", "environment"] as const;

function repo() {
  const root = mkdtempSync(join(tmpdir(), "staledocs-git-"));
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  execFileSync("git", ["init", "-q", "--initial-branch", "main"], {
    cwd: root,
  });
  execFileSync("git", ["config", "core.hooksPath", hooks], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  return root;
}
function commit(root: string, message: string) {
  execFileSync("git", ["add", "--", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", message], { cwd: root });
}

describe("GitSnapshotReader", () => {
  test("reads committed changes and normalizes paths", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    commit(root, "initial");
    writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
    writeFileSync(join(root, "src/new.py"), "x = 1\n");
    const reader = new GitSnapshotReader(root);
    const result = await reader.read({
      base: "HEAD",
      head: "HEAD",
      include: ["**/*"],
      exclude: [],
    });
    expect(result.files).toHaveLength(0);
    const working = await reader.read({
      base: "HEAD",
      include: ["**/*"],
      exclude: [],
    });
    expect(working.head.type).toBe("working-tree");
    expect(working.files.map((f) => f.afterPath)).toEqual(
      expect.arrayContaining(["src/a.ts", "src/new.py"]),
    );
    expect(
      working.files.find((f) => f.afterPath === "src/a.ts")?.afterSource,
    ).toContain("a = 2");
  });

  test("supports immutable head and excluded/unsupported counts", async () => {
    const root = repo();
    writeFileSync(join(root, "a.ts"), "x\n");
    writeFileSync(join(root, "note.txt"), "n\n");
    commit(root, "initial");
    writeFileSync(join(root, "a.ts"), "y\n");
    writeFileSync(join(root, "note.txt"), "z\n");
    const result = await new GitSnapshotReader(root).read({
      base: "HEAD",
      head: "HEAD",
      include: ["**/*.ts"],
      exclude: [],
    });
    expect(result.head.type).toBe("git");
    expect(result.files).toEqual([]);
    const tree = await new GitSnapshotReader(root).read({
      base: "HEAD",
      include: ["**/*.ts"],
      exclude: [],
    });
    expect(tree.ignored.unsupported).toBeGreaterThanOrEqual(1);
    expect(tree.files.find((f) => f.afterPath === "note.txt")).toMatchObject({
      supported: false,
      analysis: "unsupported",
    });
  });

  test("rejects a leading option marker as a fixed invalid ref", async () => {
    const root = repo();
    writeFileSync(join(root, "a.ts"), "x\n");
    commit(root, "initial");
    await expect(
      new GitSnapshotReader(root).read({
        base: "-bad",
        include: [],
        exclude: [],
      }),
    ).rejects.toMatchObject({ code: "PLAN_INVALID_REF" });
  });

  test("reports a valid default selection outside a repository", async () => {
    const root = repo();
    await expect(
      new GitSnapshotReader(join(root, "missing")).read({
        include: [],
        exclude: [],
      }),
    ).rejects.toMatchObject({ code: "PLAN_NOT_GIT_REPOSITORY" });
  });

  test.each(
    INVALID_REF_SOURCES.flatMap((source) =>
      INVALID_REF_CODE_POINTS.map((codePoint) => ({ source, codePoint })),
    ),
  )(
    "rejects $source control code point $codePoint before repository discovery",
    async ({ source, codePoint }) => {
      const fixture = mkdtempSync(join(tmpdir(), "staledocs-invalid-ref-"));
      const missingRepository = join(fixture, "missing");
      const hostileRef = `valid${String.fromCodePoint(codePoint)}tail`;
      const options = {
        include: [],
        exclude: [],
        ...(source === "head" ? { head: hostileRef } : {}),
        ...(source === "base" ? { base: hostileRef } : {}),
      };
      const environment = { ...process.env };
      delete environment.STALEDOCS_BASE_REF;
      if (source === "environment") environment.STALEDOCS_BASE_REF = hostileRef;

      const error = await new GitSnapshotReader(missingRepository, environment)
        .read(options)
        .catch((value: unknown) => value);

      expect(PlanFailure.read(error)).toEqual({
        code: "PLAN_INVALID_REF",
        message: "The Git reference is invalid.",
      });
      expect(String(error)).not.toContain(hostileRef);
    },
  );

  // Break caught: a validated file is swapped for a symlink between lstat and open.
  test("rejects a worktree symlink swap without reading the target", async () => {
    const root = repo();
    const sourcePath = join(root, "source.ts");
    const outsidePath = join(root, "outside-sentinel.ts");
    writeFileSync(sourcePath, "export const value = 1;\n");
    commit(root, "initial");
    writeFileSync(sourcePath, "export const value = 2;\n");
    writeFileSync(outsidePath, "outside-sentinel");
    const canonicalSourcePath = realpathSync(sourcePath);

    const realRealpath = fs.realpath.bind(fs);
    const realpath = jest
      .spyOn(fs, "realpath")
      .mockImplementation(async (path) => {
        const resolved = await realRealpath(path);
        if (resolved === canonicalSourcePath) {
          unlinkSync(sourcePath);
          symlinkSync(outsidePath, sourcePath);
        }
        return resolved;
      });

    try {
      await expect(
        new GitSnapshotReader(root).read({
          base: "HEAD",
          include: ["**/*.ts"],
          exclude: [],
        }),
      ).rejects.toMatchObject({
        code: "PLAN_UNSAFE_WORKTREE_PATH",
        message: "The working-tree path is unsafe.",
        path: "source.ts",
      });
    } finally {
      realpath.mockRestore();
    }
  });

  // Break caught: resolving a leaf by pathname after validation follows a
  // replacement intermediate directory and reads attacker-selected source.
  test("rejects an intermediate-directory swap before the worktree read", async () => {
    const root = repo();
    const parentPath = join(root, "src");
    const displacedParentPath = join(root, "src-original");
    const sourcePath = join(parentPath, "source.ts");
    mkdirSync(parentPath);
    writeFileSync(sourcePath, "export const value = 1;\n");
    commit(root, "initial");
    writeFileSync(sourcePath, "export const value = 2;\n");
    const canonicalSourcePath = realpathSync(sourcePath);

    const realRealpath = fs.realpath.bind(fs);
    const realpath = jest
      .spyOn(fs, "realpath")
      .mockImplementation(async (path) => {
        const resolved = await realRealpath(path);
        if (resolved === canonicalSourcePath) {
          renameSync(parentPath, displacedParentPath);
          mkdirSync(parentPath);
          writeFileSync(sourcePath, "replacement-source-sentinel\n");
        }
        return resolved;
      });

    try {
      const error = await new GitSnapshotReader(root)
        .read({
          base: "HEAD",
          include: ["**/*.ts"],
          exclude: [],
        })
        .catch((value: unknown) => value);

      expect(error).toMatchObject({
        code: "PLAN_UNSAFE_WORKTREE_PATH",
        message: "The working-tree path is unsafe.",
        path: "src/source.ts",
      });
      expect(String(error)).not.toContain("replacement-source-sentinel");
    } finally {
      realpath.mockRestore();
    }
  });

  // Break caught: a slash-prefix containment check accepts a Windows sibling
  // or rejects valid case-insensitive descendants when tests run on POSIX.
  test("uses platform path semantics for default and Windows containment", () => {
    expect(isPathWithinRoot("/repo", "/repo/src/source.ts")).toBe(true);
    expect(isPathWithinRoot("/repo", "/repo-sibling/source.ts")).toBe(false);
    expect(
      isPathWithinRoot(
        "C:\\Repository",
        "c:\\repository\\src\\source.ts",
        win32,
      ),
    ).toBe(true);
    expect(
      isPathWithinRoot(
        "C:\\Repository",
        "C:\\Repository-sibling\\source.ts",
        win32,
      ),
    ).toBe(false);
    expect(isPathWithinRoot("C:\\Repository", "D:\\source.ts", win32)).toBe(
      false,
    );
  });

  // Break caught: a supported rename endpoint is discarded when the other
  // endpoint has an unsupported extension, rather than becoming delete/add.
  test("classifies supported and unsupported rename endpoints independently", async () => {
    const root = repo();
    writeFileSync(join(root, "removed.ts"), "export const removed = 1;\n");
    writeFileSync(
      join(root, "legacy.txt"),
      "export const commonPrefixForRenameDetection = 1;\n" +
        "export const commonSecondLine = 2;\n" +
        "// unsupported-before-source-sentinel\n",
    );
    commit(root, "base");
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["mv", "--", "removed.ts", "removed.txt"], {
      cwd: root,
    });
    execFileSync("git", ["mv", "--", "legacy.txt", "restored.ts"], {
      cwd: root,
    });
    writeFileSync(
      join(root, "restored.ts"),
      "export const commonPrefixForRenameDetection = 1;\n" +
        "export const commonSecondLine = 2;\n",
    );
    commit(root, "rename across supported boundary");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    const result = await new GitSnapshotReader(root).read({
      base,
      head,
      include: ["**/*.ts"],
      exclude: [],
    });

    expect(result.files).toEqual([
      expect.objectContaining({
        status: "deleted",
        beforePath: "removed.ts",
        afterPath: undefined,
        afterSource: undefined,
      }),
      expect.objectContaining({
        status: "added",
        beforePath: undefined,
        afterPath: "restored.ts",
        beforeSource: undefined,
      }),
    ]);
    expect(JSON.stringify(result.files)).not.toContain(
      "unsupported-before-source-sentinel",
    );
  });

  // Break caught: include/exclude is applied only to a rename destination, so
  // the in-scope endpoint is lost or the excluded endpoint is read.
  test("classifies included and excluded rename endpoints independently", async () => {
    const root = repo();
    mkdirSync(join(root, "excluded"));
    writeFileSync(
      join(root, "published.ts"),
      "export const published = 'public-before';\n",
    );
    writeFileSync(
      join(root, "excluded/legacy.ts"),
      "export const commonPrefixForExcludedRename = 1;\n" +
        "export const commonExcludedSecondLine = 2;\n" +
        "// excluded-before-source-sentinel\n",
    );
    commit(root, "base");
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["mv", "--", "published.ts", "excluded/published.ts"], {
      cwd: root,
    });
    execFileSync("git", ["mv", "--", "excluded/legacy.ts", "restored.ts"], {
      cwd: root,
    });
    writeFileSync(
      join(root, "restored.ts"),
      "export const commonPrefixForExcludedRename = 1;\n" +
        "export const commonExcludedSecondLine = 2;\n",
    );
    commit(root, "rename across exclusion boundary");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    const result = await new GitSnapshotReader(root).read({
      base,
      head,
      include: ["**/*.ts"],
      exclude: ["excluded/**"],
    });

    expect(result.files).toEqual([
      expect.objectContaining({
        status: "deleted",
        beforePath: "published.ts",
        afterPath: undefined,
        afterSource: undefined,
      }),
      expect.objectContaining({
        status: "added",
        beforePath: undefined,
        afterPath: "restored.ts",
        beforeSource: undefined,
      }),
    ]);
    expect(JSON.stringify(result.files)).not.toContain(
      "excluded-before-source-sentinel",
    );
  });

  // Break caught: line-oriented status parsing splits tracked paths at spaces.
  test("preserves whitespace in modified, renamed, and untracked paths", async () => {
    const root = repo();
    writeFileSync(join(root, "tracked file.py"), "value = 1\n");
    writeFileSync(join(root, "old name.ts"), "export const oldName = 1;\n");
    commit(root, "initial");
    writeFileSync(join(root, "tracked file.py"), "value = 2\n");
    execFileSync("git", ["mv", "--", "old name.ts", "renamed name.ts"], {
      cwd: root,
    });
    writeFileSync(join(root, "new file.ts"), "export const fresh = 1;\n");

    const result = await new GitSnapshotReader(root).read({
      base: "HEAD",
      include: ["**/*"],
      exclude: [],
    });

    expect(
      result.files.map(({ status, beforePath, afterPath }) => ({
        status,
        beforePath,
        afterPath,
      })),
    ).toEqual([
      {
        status: "renamed",
        beforePath: "old name.ts",
        afterPath: "renamed name.ts",
      },
      {
        status: "modified",
        beforePath: "tracked file.py",
        afterPath: "tracked file.py",
      },
      { status: "added", beforePath: undefined, afterPath: "new file.ts" },
    ]);
  });

  // Break caught: commands after root discovery remain scoped to the constructor subdirectory.
  test("reads the entire repository from a subdirectory", async () => {
    const root = repo();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "root.ts"), "export const rootValue = 1;\n");
    writeFileSync(join(root, "nested/inside.ts"), "export const inside = 1;\n");
    commit(root, "initial");
    writeFileSync(join(root, "root.ts"), "export const rootValue = 2;\n");
    writeFileSync(join(root, "nested/inside.ts"), "export const inside = 2;\n");
    writeFileSync(join(root, "outside.py"), "outside = 1\n");
    writeFileSync(join(root, "nested/new.py"), "inside = 1\n");

    const result = await new GitSnapshotReader(join(root, "nested")).read({
      base: "HEAD",
      include: ["**/*"],
      exclude: [],
    });

    expect(result.root).toBe(realpathSync(root));
    expect(result.files.map((file) => file.afterPath)).toEqual([
      "nested/inside.ts",
      "root.ts",
      "nested/new.py",
      "outside.py",
    ]);
  });

  // Break caught: a tracked file changed to a symlink is reported as status T, not silently ignored.
  test("rejects tracked file to symlink type changes", async () => {
    const root = repo();
    const trackedPath = join(root, "tracked.ts");
    const outsidePath = join(root, "outside.ts");
    writeFileSync(trackedPath, "export const safe = 1;\n");
    writeFileSync(outsidePath, "outside-sentinel\n");
    commit(root, "initial");
    unlinkSync(trackedPath);
    symlinkSync(outsidePath, trackedPath);

    await expect(
      new GitSnapshotReader(root).read({
        base: "HEAD",
        include: ["**/*.ts"],
        exclude: [],
      }),
    ).rejects.toMatchObject({
      code: "PLAN_UNSAFE_WORKTREE_PATH",
      message: "The working-tree path is unsafe.",
      path: "tracked.ts",
    });
  });

  test("rejects a tracked file changed to a non-regular file", async () => {
    const root = repo();
    const trackedPath = join(root, "tracked.ts");
    writeFileSync(trackedPath, "export const safe = 1;\n");
    commit(root, "initial");
    unlinkSync(trackedPath);
    execFileSync("mkfifo", [trackedPath]);

    await expect(
      new GitSnapshotReader(root).read({
        base: "HEAD",
        include: ["**/*.ts"],
        exclude: [],
      }),
    ).rejects.toMatchObject({
      code: "PLAN_UNSAFE_WORKTREE_PATH",
      message: "The working-tree path is unsafe.",
      path: "tracked.ts",
    });
  });

  // Break caught: a shallow repository with no local parent is not an initial repository.
  test("reports a missing base at the shallow-history boundary", async () => {
    const source = repo();
    writeFileSync(join(source, "first.ts"), "export const first = 1;\n");
    commit(source, "first");
    writeFileSync(join(source, "second.ts"), "export const second = 1;\n");
    commit(source, "second");
    const clone = mkdtempSync(join(tmpdir(), "staledocs-shallow-"));
    execFileSync(
      "git",
      ["clone", "-q", "--depth", "1", `file://${source}`, clone],
      { cwd: source },
    );

    await expect(
      new GitSnapshotReader(clone).read({
        include: ["**/*.ts"],
        exclude: [],
      }),
    ).rejects.toMatchObject({
      code: "PLAN_SHALLOW_HISTORY",
      message:
        "The selected Git base is unavailable in this shallow repository.",
    });
  });

  test("uses the configured base before symbolic and fallback candidates", async () => {
    const root = repo();
    writeFileSync(join(root, "first.ts"), "export const first = 1;\n");
    commit(root, "first");
    const first = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(root, "second.ts"), "export const second = 1;\n");
    commit(root, "second");
    const result = await new GitSnapshotReader(root, {
      ...process.env,
      STALEDOCS_BASE_REF: "HEAD~1",
    }).read({ include: ["**/*.ts"], exclude: [] });

    expect(result.base).toEqual({
      type: "git",
      label: "HEAD~1",
      commit: first,
    });
  });

  test("resolves origin HEAD to its symbolic target label", async () => {
    const root = repo();
    writeFileSync(join(root, "first.ts"), "export const first = 1;\n");
    commit(root, "first");
    const first = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(root, "second.ts"), "export const second = 1;\n");
    commit(root, "second");
    execFileSync("git", ["update-ref", "refs/remotes/origin/trunk", first], {
      cwd: root,
    });
    execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"],
      { cwd: root },
    );

    const result = await new GitSnapshotReader(root).read({
      include: ["**/*.ts"],
      exclude: [],
    });

    expect(result.base).toEqual({
      type: "git",
      label: first,
      commit: first,
    });
  });

  test("returns the empty tree only for a true initial repository", async () => {
    const root = repo();
    writeFileSync(join(root, "initial.ts"), "export const initial = 1;\n");
    commit(root, "initial");

    const result = await new GitSnapshotReader(root).read({
      include: ["**/*.ts"],
      exclude: [],
    });

    expect(result.base).toEqual({
      type: "git",
      label: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    });
    expect(result.files).toEqual([
      expect.objectContaining({
        status: "added",
        afterPath: "initial.ts",
        afterSource: "export const initial = 1;\n",
      }),
    ]);
  });

  test("never fetches while discovering a comparison base", async () => {
    const root = repo();
    writeFileSync(join(root, "initial.ts"), "export const initial = 1;\n");
    commit(root, "initial");
    const wrapperDir = mkdtempSync(join(tmpdir(), "staledocs-git-wrapper-"));
    const wrapperPath = join(wrapperDir, "git");
    const fetchLog = join(wrapperDir, "fetch.log");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      wrapperPath,
      `#!/bin/sh
if [ "$1" = fetch ]; then
  printf 'fetch' >> "$STALEDOCS_FETCH_LOG"
fi
exec "${realGit}" "$@"
`,
    );
    chmodSync(wrapperPath, 0o755);

    await new GitSnapshotReader(root, {
      ...process.env,
      PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
      STALEDOCS_FETCH_LOG: fetchLog,
    }).read({ include: ["**/*.ts"], exclude: [] });

    await expect(fs.readFile(fetchLog, "utf8")).rejects.toThrow();
  });

  test("reports staged, unstaged, deleted, renamed, and untracked source changes", async () => {
    const root = repo();
    writeFileSync(join(root, "staged.ts"), "export const staged = 1;\n");
    writeFileSync(join(root, "unstaged.ts"), "export const unstaged = 1;\n");
    writeFileSync(join(root, "deleted.ts"), "export const deleted = 1;\n");
    writeFileSync(join(root, "old.ts"), "export const oldName = 1;\n");
    writeFileSync(join(root, "note.txt"), "note\n");
    commit(root, "initial");
    writeFileSync(join(root, "staged.ts"), "export const staged = 2;\n");
    execFileSync("git", ["add", "--", "staged.ts"], { cwd: root });
    writeFileSync(join(root, "unstaged.ts"), "export const unstaged = 2;\n");
    execFileSync("git", ["rm", "-q", "--", "deleted.ts"], { cwd: root });
    execFileSync("git", ["mv", "--", "old.ts", "renamed.ts"], { cwd: root });
    writeFileSync(join(root, "new.py"), "new_value = 1\n");

    const result = await new GitSnapshotReader(root).read({
      base: "HEAD",
      include: ["**/*"],
      exclude: [],
    });

    expect(
      result.files.map(({ status, beforePath, afterPath }) => ({
        status,
        beforePath,
        afterPath,
      })),
    ).toEqual([
      { status: "deleted", beforePath: "deleted.ts", afterPath: undefined },
      { status: "renamed", beforePath: "old.ts", afterPath: "renamed.ts" },
      { status: "modified", beforePath: "staged.ts", afterPath: "staged.ts" },
      {
        status: "modified",
        beforePath: "unstaged.ts",
        afterPath: "unstaged.ts",
      },
      { status: "added", beforePath: undefined, afterPath: "new.py" },
    ]);
  });

  test("keeps immutable heads detached from worktree edits", async () => {
    const root = repo();
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    commit(root, "initial");
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    commit(root, "committed");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(root, "a.ts"), "export const a = 3;\n");

    const result = await new GitSnapshotReader(root).read({
      base,
      head,
      include: ["**/*.ts"],
      exclude: [],
    });

    expect(result.head).toEqual({ type: "git", label: head, commit: head });
    expect(result.files).toEqual([
      expect.objectContaining({
        status: "modified",
        beforeSource: "export const a = 1;\n",
        afterSource: "export const a = 2;\n",
      }),
    ]);
  });

  test("rejects newline-bearing untracked paths without splitting or leaking them", async () => {
    const root = repo();
    writeFileSync(join(root, "safe.ts"), "export const safe = 1;\n");
    commit(root, "initial");
    const unsafeName = "unsafe\nsource.ts";
    writeFileSync(join(root, unsafeName), "source-sentinel\n");

    const error = await new GitSnapshotReader(root)
      .read({
        base: "HEAD",
        include: ["**/*.ts"],
        exclude: [],
      })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      code: "PLAN_SOURCE_READ_FAILED",
      message: "Unable to read repository source.",
    });
    expect(String(error)).not.toContain("source-sentinel");
    expect(String(error)).not.toContain(unsafeName);
  });

  test("keeps unsupported and excluded counts separate from parsed files", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/kept.ts"), "export const kept = 1;\n");
    writeFileSync(
      join(root, "src/excluded.ts"),
      "export const excluded = 1;\n",
    );
    writeFileSync(join(root, "src/note.txt"), "unsupported\n");
    commit(root, "initial");
    writeFileSync(join(root, "src/kept.ts"), "export const kept = 2;\n");
    writeFileSync(
      join(root, "src/excluded.ts"),
      "export const excluded = 2;\n",
    );
    writeFileSync(join(root, "src/note.txt"), "unsupported changed\n");

    const result = await new GitSnapshotReader(root).read({
      base: "HEAD",
      include: ["src/**/*.ts"],
      exclude: ["src/excluded.ts"],
    });

    expect(
      result.files.find((file) => file.afterPath === "src/kept.ts"),
    ).toEqual(expect.objectContaining({ supported: true, excluded: false }));
    expect(
      result.files.find((file) => file.afterPath === "src/excluded.ts"),
    ).toEqual(expect.objectContaining({ supported: true, excluded: true }));
    expect(
      result.files.find((file) => file.afterPath === "src/note.txt"),
    ).toEqual(
      expect.objectContaining({
        supported: false,
        excluded: false,
        analysis: "unsupported",
      }),
    );
    expect(result.ignored).toEqual({ unsupported: 1, excluded: 1 });
  });

  test.each(["-bad", "bad\nref", "bad\0ref"])(
    "rejects unsafe base ref %j with a fixed diagnostic",
    async (base) => {
      const root = repo();
      writeFileSync(join(root, "a.ts"), "a\n");
      commit(root, "initial");

      await expect(
        new GitSnapshotReader(root).read({
          base,
          include: [],
          exclude: [],
        }),
      ).rejects.toMatchObject({
        code: "PLAN_INVALID_REF",
        message: "The Git reference is invalid.",
      });
    },
  );

  test("reports missing base and head without leaking ref or Git diagnostics", async () => {
    const root = repo();
    writeFileSync(join(root, "a.ts"), "a\n");
    commit(root, "initial");
    const sentinel = "missing-secret-sentinel";

    const missingBase = await new GitSnapshotReader(root)
      .read({
        base: sentinel,
        include: [],
        exclude: [],
      })
      .catch((error: unknown) => error);
    expect(missingBase).toMatchObject({
      code: "PLAN_BASE_NOT_FOUND",
      message: "The Git base could not be resolved.",
    });
    expect(String(missingBase)).not.toContain(sentinel);

    const missingHead = await new GitSnapshotReader(root)
      .read({
        head: sentinel,
        include: [],
        exclude: [],
      })
      .catch((error: unknown) => error);
    expect(missingHead).toMatchObject({
      code: "PLAN_HEAD_NOT_FOUND",
      message: "The Git head could not be resolved.",
    });
    expect(String(missingHead)).not.toContain(sentinel);
  });

  test("reads optional revision files and lists bounded package manifests", async () => {
    const root = repo();
    mkdirSync(join(root, "packages"), { recursive: true });
    mkdirSync(join(root, "packages", "one"), { recursive: true });
    mkdirSync(join(root, "packages", "two"), { recursive: true });
    mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
    mkdirSync(join(root, "dist", "generated"), { recursive: true });
    mkdirSync(join(root, "build", "generated"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"main":"src/index.ts"}\n');
    writeFileSync(join(root, "packages", "one", "package.json"), "{}\n");
    writeFileSync(join(root, "packages", "two", "package.json"), "{}\n");
    writeFileSync(
      join(root, "node_modules", "ignored", "package.json"),
      "{}\n",
    );
    writeFileSync(join(root, "dist", "generated", "package.json"), "{}\n");
    writeFileSync(join(root, "build", "generated", "package.json"), "{}\n");
    writeFileSync(join(root, "entry.mts"), "export const value = 1;\n");
    commit(root, "initial");

    const reader = new GitSnapshotReader(root);
    await reader.read({ base: "HEAD", include: ["**/*"], exclude: [] });

    await expect(reader.readAt("base", "entry.mts")).resolves.toContain(
      "export const value",
    );
    await expect(reader.readAt("base", "missing.ts")).resolves.toBeUndefined();
    await expect(reader.listPackageManifests("base")).resolves.toEqual([
      "package.json",
      "packages/one/package.json",
      "packages/two/package.json",
    ]);
    await expect(reader.listPackageManifests("base", 2)).resolves.toEqual([
      "package.json",
      "packages/one/package.json",
    ]);
  });

  // Break caught: the missing-file probe dereferences the empty-tree sentinel as a
  // commit, so a first-commit repository fails planning instead of reporting absence.
  test("treats files as absent at the empty-tree base of a first commit", async () => {
    const root = repo();
    writeFileSync(root + "/only.ts", "export const only = 1;\n");
    commit(root, "initial");

    const reader = new GitSnapshotReader(root);
    await reader.read({ include: ["**/*"], exclude: [] });

    await expect(reader.readAt("base", "only.ts")).resolves.toBeUndefined();
    await expect(reader.listPackageManifests("base")).resolves.toEqual([]);
  });

  test("reads untracked head files and manifests in working-tree mode", async () => {
    const root = repo();
    writeFileSync(join(root, "base.ts"), "export const base = 1;\n");
    commit(root, "initial");
    mkdirSync(join(root, "apps"));
    mkdirSync(join(root, "apps", "web"));
    writeFileSync(join(root, "apps", "web", "package.json"), "{}\n");
    writeFileSync(join(root, "head.cjs"), "export const head = 1;\n");

    const reader = new GitSnapshotReader(root);
    await reader.read({ base: "HEAD", include: ["**/*"], exclude: [] });

    await expect(reader.readAt("head", "head.cjs")).resolves.toContain(
      "export const head",
    );
    await expect(reader.readAt("head", "missing.cjs")).resolves.toBeUndefined();
    await expect(reader.listPackageManifests("head")).resolves.toEqual([
      "apps/web/package.json",
    ]);
  });

  test("lists the committed tree and the working tree once per revision", async () => {
    const root = repo();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "guide.md"), "# Guide\n");
    writeFileSync(join(root, ".gitignore"), "ignored.md\n");
    writeFileSync(join(root, "removed.ts"), "export const removed = 1;\n");
    commit(root, "initial");
    unlinkSync(join(root, "removed.ts"));
    execFileSync("git", ["rm", "-q", "--cached", "removed.ts"], { cwd: root });
    writeFileSync(join(root, "untracked.md"), "# New\n");
    writeFileSync(join(root, "ignored.md"), "# Ignored\n");

    const committed = new GitSnapshotReader(root);
    await committed.read({ base: "HEAD", head: "HEAD", include: [], exclude: [] });
    expect([...((await committed.listTree("head")) ?? [])].sort()).toEqual([
      ".gitignore",
      "docs/guide.md",
      "removed.ts",
    ]);

    const working = new GitSnapshotReader(root);
    await expect(working.openWorkingTree()).resolves.toEqual({
      root: realpathSync(root),
      head: { type: "working-tree", label: "HEAD" },
    });
    const tree = await working.listTree("head");
    expect([...(tree ?? [])].sort()).toEqual([
      ".gitignore",
      "docs/guide.md",
      "untracked.md",
    ]);
    writeFileSync(join(root, "later.md"), "# Later\n");
    await expect(working.listTree("head")).resolves.toBe(tree);
  });

  test("reports an unavailable tree above the entry or byte bound", async () => {
    const root = repo();
    writeFileSync(join(root, "a.md"), "a\n");
    writeFileSync(join(root, "b.md"), "b\n");
    commit(root, "initial");

    const byEntries = new GitSnapshotReader(root);
    await byEntries.openWorkingTree();
    await expect(byEntries.listTree("head", { entries: 1 })).resolves.toBeUndefined();

    const byBytes = new GitSnapshotReader(root);
    await byBytes.openWorkingTree();
    await expect(byBytes.listTree("head", { bytes: 4 })).resolves.toBeUndefined();

    const within = new GitSnapshotReader(root);
    await within.openWorkingTree();
    await expect(within.listTree("head", { entries: 2 })).resolves.toEqual(
      new Set(["a.md", "b.md"]),
    );
  });

  test("fails closed when the working tree has no commit to pin", async () => {
    const root = repo();
    await expect(new GitSnapshotReader(root).openWorkingTree()).rejects.toMatchObject({
      code: "PLAN_HEAD_NOT_FOUND",
    });
  });

  test("rejects direct containment escapes with a fixed unsafe-path error", async () => {
    const root = repo();
    const outside = join(root, "..", "staledocs-outside-sentinel.ts");
    writeFileSync(outside, "outside-sentinel\n");
    try {
      const reader = new GitSnapshotReader(root) as unknown as {
        worktreeFile(root: string, path: string): Promise<string>;
      };
      await expect(
        reader.worktreeFile(root, "../staledocs-outside-sentinel.ts"),
      ).rejects.toMatchObject({
        code: "PLAN_UNSAFE_WORKTREE_PATH",
        message: "The working-tree path is unsafe.",
      });
    } finally {
      await fs.unlink(outside);
    }
  });
});
