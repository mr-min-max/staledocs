import { simpleGit } from "simple-git";

export interface CommitInfo {
  hash: string;
  message: string;
  date: string;
  author: string;
}

/** Resolves the repository root for a working directory. */
export async function getGitRoot(cwd?: string): Promise<string> {
  const git = cwd ? simpleGit(cwd) : simpleGit();
  const root = await git.revparse(["--show-toplevel"]);
  return root.trim();
}

/** Returns commit metadata between two git refs for changelog generation. */
export async function getCommitsSince(
  fromRef: string,
  toRef: string = "HEAD",
  cwd?: string,
): Promise<CommitInfo[]> {
  const git = cwd ? simpleGit(cwd) : simpleGit();
  const log = await git.log({ from: fromRef, to: toRef });

  return log.all.map((commit) => ({
    hash: commit.hash.substring(0, 7),
    message: commit.message,
    date: commit.date,
    author: (commit as any).author_name || "",
  }));
}

/** Returns the unified diff between two git refs. */
export async function getDiff(
  fromRef: string,
  toRef: string = "HEAD",
  cwd?: string,
): Promise<string> {
  const git = cwd ? simpleGit(cwd) : simpleGit();
  return git.diff([`${fromRef}..${toRef}`]);
}

/** Lists files changed between two git refs or from a ref to the working tree. */
export async function getChangedFiles(
  fromRef: string,
  toRef?: string,
  cwd?: string,
): Promise<string[]> {
  const git = cwd ? simpleGit(cwd) : simpleGit();
  const args =
    toRef === undefined
      ? ["--name-only", fromRef]
      : ["--name-only", `${fromRef}..${toRef}`];
  const result = await git.diff(args);
  return result.trim().split("\n").filter(Boolean);
}

/** Returns the latest reachable git tag, or null when the repo has no tags. */
export async function getLatestTag(cwd?: string): Promise<string | null> {
  const git = cwd ? simpleGit(cwd) : simpleGit();
  try {
    const tag = await git.raw(["describe", "--tags", "--abbrev=0"]);
    return tag.trim();
  } catch {
    return null;
  }
}
