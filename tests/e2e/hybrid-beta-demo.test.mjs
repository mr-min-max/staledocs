import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const demoScript = path.join(repositoryRoot, "scripts", "demo-hybrid-beta.mjs");
const snapshotScript = path.join(
  repositoryRoot,
  "scripts",
  "hybrid-beta-snapshot.mjs",
);
const forbiddenOutput = [
  repositoryRoot,
  "/Users/",
  "/home/",
  "sk-proj-",
  "preparation_digest",
  "candidate_markdown",
  "system_prompt",
  "generation.prompt",
  "README fixture",
  "Updated by",
];

function credentialFreeEnv() {
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
    "STALEDOCS_COMPAT_API_KEY",
    "STALEDOCS_PROVIDER",
    "STALEDOCS_MODEL",
    "STALEDOCS_PROVIDER_BASE_URL",
    "STALEDOCS_ALLOW_LOCAL_HTTP",
    "STALEDOCS_QWEN_REGION",
    "STALEDOCS_QWEN_WORKSPACE_ID",
    "STALEDOCS_OLLAMA_HOST",
    "STALEDOCS_TRUST_POLICY",
  ]) {
    delete env[key];
  }
  return env;
}

async function runDemo() {
  const result = await execFileAsync(process.execPath, [demoScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: credentialFreeEnv(),
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.stderr, "");
  const output = result.stdout.trim();
  assert.ok(output.length > 0);
  for (const value of forbiddenOutput) {
    assert.equal(output.includes(value), false, `demo output leaked ${value}`);
  }
  return JSON.parse(output);
}

test("emits deterministic, canonical, credential-free hybrid beta evidence", async () => {
  const first = await runDemo();
  const second = await runDemo();
  assert.deepEqual(first, second);
  assert.equal(first.schema_version, "staledocs.hybrid-beta-demo.v1");
  assert.equal(first.status, "pass");
  assert.deepEqual(first.checks, {
    no_impact_plan_has_no_next_action: true,
    one_target_auto_selected_in_mock_dry_run: true,
    multiple_targets_require_selection: true,
    all_targets_require_explicit_behavior: true,
    mcp_prepare_validate_approved: true,
    mcp_prepare_validate_did_not_write: true,
    prompt_contains_signatures: true,
    forged_preparation_blocked: true,
    secret_candidate_redacted_or_blocked: true,
  });
  assert.deepEqual(first.tools, [
    "prepare_documentation_update",
    "validate_documentation_draft",
    "check_docs_freshness",
  ]);
  assert.deepEqual(first.providers, ["none"]);
  assert.deepEqual(first.fixtures, [
    "no-impact",
    "single-target",
    "multiple-targets",
    "provider-free-mcp",
  ]);
  assert.equal(first.counts.affected_targets, 2);
  assert.equal(first.counts.secret_findings, 1);
});


test("working-tree snapshot detects content, directory, mode, HEAD, and symlink changes", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "staledocs-hybrid-snapshot-"));
  const snapshot = async () => {
    const { snapshotRepositoryTree } = await import(snapshotScript);
    return snapshotRepositoryTree(fixture);
  };
  try {
    const gitOptions = { cwd: fixture, encoding: "utf8" };
    await execFileAsync("git", ["init", "--quiet"], gitOptions);
    await execFileAsync(
      "git",
      ["config", "user.name", "snapshot test"],
      gitOptions,
    );
    await execFileAsync(
      "git",
      ["config", "user.email", "snapshot@example.invalid"],
      gitOptions,
    );
    await writeFile(path.join(fixture, "tracked.md"), "one\n", "utf8");
    await execFileAsync("git", ["add", "tracked.md"], gitOptions);
    await execFileAsync(
      "git",
      ["commit", "--quiet", "-m", "baseline"],
      gitOptions,
    );
    const baseline = await snapshot();
    assert.equal(
      await snapshot(),
      baseline,
      "unchanged HEAD snapshot must be stable",
    );
    await writeFile(path.join(fixture, "tracked.md"), "two\n", "utf8");
    assert.notEqual(
      await snapshot(),
      baseline,
      "tracked mutation must change snapshot",
    );
    await writeFile(path.join(fixture, "tracked.md"), "one\n", "utf8");

    await writeFile(path.join(fixture, "untracked.txt"), "new\n", "utf8");
    assert.notEqual(
      await snapshot(),
      baseline,
      "untracked creation must change snapshot",
    );
    await rm(path.join(fixture, "untracked.txt"));

    await rm(path.join(fixture, "tracked.md"));
    assert.notEqual(
      await snapshot(),
      baseline,
      "deletion must change snapshot",
    );
    await writeFile(path.join(fixture, "tracked.md"), "one\n", "utf8");

    const emptyDirectory = path.join(fixture, "empty-directory");
    await mkdir(emptyDirectory);
    assert.notEqual(
      await snapshot(),
      baseline,
      "empty-directory creation must change snapshot",
    );
    await rm(emptyDirectory, { recursive: true });
    assert.equal(
      await snapshot(),
      baseline,
      "empty-directory removal must restore snapshot",
    );

    const trackedMode = (await lstat(path.join(fixture, "tracked.md"))).mode;
    const executableMode = (trackedMode & 0o7777) ^ 0o100;
    await chmod(path.join(fixture, "tracked.md"), executableMode);
    assert.notEqual(
      await snapshot(),
      baseline,
      "executable-bit change must change snapshot",
    );
    await chmod(path.join(fixture, "tracked.md"), trackedMode & 0o7777);
    assert.equal(
      await snapshot(),
      baseline,
      "executable-bit restoration must restore snapshot",
    );

    await symlink("tracked.md", path.join(fixture, "tracked-link"));
    assert.notEqual(
      await snapshot(),
      baseline,
      "symlink creation must change snapshot",
    );
    await rm(path.join(fixture, "tracked-link"));
    assert.equal(
      await snapshot(),
      baseline,
      "symlink removal must restore snapshot",
    );

    await execFileAsync(
      "git",
      ["commit", "--quiet", "--allow-empty", "-m", "head-only change"],
      gitOptions,
    );
    assert.notEqual(
      await snapshot(),
      baseline,
      "HEAD change must change snapshot",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
