import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { runPreflight } from "../../scripts/public-beta-preflight.mjs";

const execFileAsync = promisify(execFile);
const PREFLIGHT_SCRIPT = path.resolve("scripts/public-beta-preflight.mjs");
const APPROVED_EMAIL = "100+tester@users.noreply.github.com";
const PRIVATE_EMAIL = "private-person@example.invalid";
const GITHUB_AUTOMATION_EMAIL = "noreply@github.com";
const DEPENDABOT_AUTOMATION_EMAIL =
  "49699333+dependabot[bot]@users.noreply.github.com";
const SOURCE_ARTIFACTS = {
  plugin: [
    "integrations/codex/staledocs/.codex-plugin/plugin.json",
    "integrations/codex/staledocs/.mcp.json",
    "integrations/codex/staledocs/skills/maintain-documentation/SKILL.md",
  ],
  claudePlugin: [
    ".claude-plugin/marketplace.json",
    "integrations/claude/staledocs/.claude-plugin/plugin.json",
    "integrations/claude/staledocs/.mcp.json",
    "integrations/claude/staledocs/skills/check/SKILL.md",
    "integrations/claude/staledocs/skills/review/SKILL.md",
    "integrations/claude/staledocs/skills/maintain-documentation/SKILL.md",
    "integrations/claude/staledocs/assets/icon.png",
  ],
  docs: [
    "README.md",
    "docs/PUBLIC_BETA.md",
    "docs/integrations/codex.md",
    "docs/integrations/claude.md",
    "docs/releases/v0.2.0-beta.4.md",
    "docs/releases/v0.2.0-beta.5.md",
    "docs/releases/v0.3.0-beta.1.md",
    "docs/releases/v0.4.0-beta.1.md",
  ],
  storefrontDocumentation: [
    "docs/CLI.md",
    "docs/GITHUB_ACTION.md",
    "tests/e2e/storefront-demo.test.mjs",
  ],
  demo: [
    "scripts/demo-hybrid-beta.mjs",
    "scripts/hybrid-beta-snapshot.mjs",
    "tests/e2e/hybrid-beta-demo.test.mjs",
  ],
  compiledMcp: [
    "dist/mcp/server.js",
    "dist/mcp/repository-scope.js",
    "dist/mcp/scoped-config.js",
    "dist/mcp/scoped-freshness.js",
    "dist/mcp/update-workflow.js",
    "dist/mcp/preparation-token.js",
    "dist/core/update-preparation.js",
    "dist/templates/update.hbs",
  ],
  storefrontStatic: [
    "docs/assets/brand/staledocs-logo.png",
    "docs/assets/brand/staledocs-avatar-source.png",
    "docs/assets/brand/staledocs-avatar.png",
    "docs/assets/brand/README.md",
    "docs/assets/social/staledocs-social-preview-source.png",
    "docs/assets/social/staledocs-social-preview.svg",
    "docs/assets/social/staledocs-social-preview.png",
    "docs/assets/demo/staledocs-flow-poster-source.png",
    "docs/assets/demo/staledocs-flow-poster.svg",
    "docs/assets/demo/staledocs-flow-poster.png",
  ],
  storefrontMedia: [
    "docs/assets/demo/staledocs-flow-scene.png",
    "docs/assets/demo/frame-01-change.svg",
    "docs/assets/demo/frame-02-plan.svg",
    "docs/assets/demo/frame-03-targets.svg",
    "docs/assets/demo/frame-04-diff.svg",
    "docs/assets/demo/frame-05-validated.svg",
    "docs/assets/demo/frame-01-change.png",
    "docs/assets/demo/frame-02-plan.png",
    "docs/assets/demo/frame-03-targets.png",
    "docs/assets/demo/frame-04-diff.png",
    "docs/assets/demo/frame-05-validated.png",
    "docs/assets/demo/staledocs-flow.gif",
    "docs/demo/staledocs-walkthrough-script.md",
    "docs/demo/staledocs-walkthrough.vtt",
    "docs/demo/recording-checklist.md",
  ],
};

async function git(repositoryRoot, args) {
  return execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

async function setIdentity(repositoryRoot, email = APPROVED_EMAIL) {
  await git(repositoryRoot, ["config", "user.name", "tester"]);
  await git(repositoryRoot, ["config", "user.email", email]);
}

async function commitFile(repositoryRoot, relativePath, content, message) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  await git(repositoryRoot, ["add", relativePath]);
  await git(repositoryRoot, ["commit", "-m", message]);
}

async function createFixture(t) {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "staledocs-public-beta-preflight-"),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  await setIdentity(repositoryRoot);
  await git(repositoryRoot, [
    "remote",
    "add",
    "origin",
    "https://github.com/example/staledocs.git",
  ]);

  await writeFile(
    path.join(repositoryRoot, ".gitignore"),
    ".private/\n",
    "utf8",
  );
  await commitFile(
    repositoryRoot,
    "README.md",
    "# fixture\n",
    "initial fixture",
  );
  await git(repositoryRoot, ["branch", "codex/release-integrity"]);

  const policyPath = path.join(
    repositoryRoot,
    ".github",
    "public-beta-policy.json",
  );
  await mkdir(path.dirname(policyPath), { recursive: true });
  await writeFile(
    policyPath,
    `${JSON.stringify(
      {
        schemaVersion: "staledocs.public-beta-policy.v1",
        canonicalRepository: "example/staledocs",
        defaultBranch: "main",
        candidateBranch: "codex/release-integrity",
        protectedIdentities: [
          {
            name: "tester",
            emails: [APPROVED_EMAIL],
          },
        ],
        allowedAutomationEmails: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    repositoryRoot,
    policyPath,
    mainRef: "main",
    candidateRef: "codex/release-integrity",
  };
}

async function createNeedlesFile(repositoryRoot, needles) {
  const privateNeedlesPath = path.join(
    repositoryRoot,
    ".private",
    "public-beta-needles.txt",
  );
  await mkdir(path.dirname(privateNeedlesPath), { recursive: true });
  await writeFile(privateNeedlesPath, `${needles.join("\n")}\n`, "utf8");
  return privateNeedlesPath;
}

async function createSourceArtifacts(repositoryRoot) {
  const files = [
    ...SOURCE_ARTIFACTS.plugin,
    ...SOURCE_ARTIFACTS.claudePlugin,
    ...SOURCE_ARTIFACTS.docs,
    ...SOURCE_ARTIFACTS.storefrontDocumentation,
    ...SOURCE_ARTIFACTS.demo,
    ...SOURCE_ARTIFACTS.compiledMcp,
    ...SOURCE_ARTIFACTS.storefrontStatic,
    ...SOURCE_ARTIFACTS.storefrontMedia,
  ];
  for (const relativePath of files) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, await readFile(path.resolve(relativePath)));
  }
  return files;
}

function findCheck(report, id) {
  const check = report.checks.find((candidate) => candidate.id === id);
  assert.ok(check, `missing check ${id}`);
  return check;
}

function assertValueSafe(report, fixture, privateValues = []) {
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(fixture.repositoryRoot), false);
  assert.equal(serialized.includes("@"), false);
  for (const value of privateValues) {
    assert.equal(serialized.includes(value), false);
  }
}

test("fails a protected identity using an unapproved email without echoing it", async (t) => {
  const fixture = await createFixture(t);
  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await setIdentity(fixture.repositoryRoot, PRIVATE_EMAIL);
  await commitFile(
    fixture.repositoryRoot,
    "private-author.txt",
    "identity fixture\n",
    "private author fixture",
  );

  const report = await runPreflight(fixture);

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "identity-policy").status, "fail");
  assertValueSafe(report, fixture, [PRIVATE_EMAIL]);
});

test("passes the protected identity after rewriting it to the approved noreply", async (t) => {
  const fixture = await createFixture(t);
  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await setIdentity(fixture.repositoryRoot, PRIVATE_EMAIL);
  await commitFile(
    fixture.repositoryRoot,
    "rewritten.txt",
    "before rewrite\n",
    "rewrite fixture",
  );
  await setIdentity(fixture.repositoryRoot);
  await git(fixture.repositoryRoot, [
    "commit",
    "--amend",
    "--no-edit",
    "--reset-author",
  ]);

  const report = await runPreflight(fixture);

  assert.equal(report.status, "pass");
  assert.equal(findCheck(report, "identity-policy").status, "pass");
  assertValueSafe(report, fixture, [PRIVATE_EMAIL, APPROVED_EMAIL]);
});

test("repository policy allows GitHub automation commit identities", async (t) => {
  const fixture = await createFixture(t);
  const repositoryPolicy = JSON.parse(
    await readFile(path.resolve(".github/public-beta-policy.json"), "utf8"),
  );
  const fixturePolicy = JSON.parse(await readFile(fixture.policyPath, "utf8"));
  fixturePolicy.allowedAutomationEmails =
    repositoryPolicy.allowedAutomationEmails;
  await writeFile(
    fixture.policyPath,
    `${JSON.stringify(fixturePolicy, null, 2)}\n`,
    "utf8",
  );

  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await writeFile(
    path.join(fixture.repositoryRoot, "merge.txt"),
    "GitHub merge fixture\n",
    "utf8",
  );
  await git(fixture.repositoryRoot, ["add", "merge.txt"]);
  await execFileAsync("git", ["commit", "-m", "GitHub merge fixture"], {
    cwd: fixture.repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_COMMITTER_NAME: "GitHub",
      GIT_COMMITTER_EMAIL: GITHUB_AUTOMATION_EMAIL,
    },
  });
  await writeFile(
    path.join(fixture.repositoryRoot, "dependabot.txt"),
    "Dependabot fixture\n",
    "utf8",
  );
  await git(fixture.repositoryRoot, ["add", "dependabot.txt"]);
  await execFileAsync("git", ["commit", "-m", "Dependabot fixture"], {
    cwd: fixture.repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "dependabot[bot]",
      GIT_AUTHOR_EMAIL: DEPENDABOT_AUTOMATION_EMAIL,
      GIT_COMMITTER_NAME: "GitHub",
      GIT_COMMITTER_EMAIL: GITHUB_AUTOMATION_EMAIL,
    },
  });

  const report = await runPreflight(fixture);

  assert.equal(report.status, "pass");
  assert.equal(findCheck(report, "identity-policy").status, "pass");
  assertValueSafe(report, fixture, [
    APPROVED_EMAIL,
    GITHUB_AUTOMATION_EMAIL,
    DEPENDABOT_AUTOMATION_EMAIL,
  ]);
});

test("fails when main is not an ancestor of the candidate", async (t) => {
  const fixture = await createFixture(t);
  await git(fixture.repositoryRoot, ["checkout", "main"]);
  await commitFile(
    fixture.repositoryRoot,
    "main-only.txt",
    "main advanced\n",
    "advance main",
  );

  const report = await runPreflight(fixture);

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "branch-ancestry").status, "fail");
  assertValueSafe(report, fixture);
});

test("finds a private needle in reachable metadata or blobs without echoing it", async (t) => {
  const fixture = await createFixture(t);
  const metadataNeedle = "private-metadata-marker";
  const blobNeedle = "private-blob-marker";
  const privateNeedlesPath = await createNeedlesFile(fixture.repositoryRoot, [
    metadataNeedle,
    blobNeedle,
  ]);
  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await commitFile(
    fixture.repositoryRoot,
    "reachable.txt",
    `${blobNeedle}\n`,
    `fixture ${metadataNeedle}`,
  );

  const report = await runPreflight({ ...fixture, privateNeedlesPath });

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "private-needles").status, "fail");
  assert.equal(report.counts.privateNeedles, 2);
  assertValueSafe(report, fixture, [metadataNeedle, blobNeedle]);
});

test("ignores unreachable objects and scans every retained branch and tag", async (t) => {
  const fixture = await createFixture(t);
  const privateNeedle = "retained-ref-private-marker";
  const privateNeedlesPath = await createNeedlesFile(fixture.repositoryRoot, [
    privateNeedle,
  ]);
  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await git(fixture.repositoryRoot, ["checkout", "-b", "private-topic"]);
  await commitFile(
    fixture.repositoryRoot,
    "retained.txt",
    `${privateNeedle}\n`,
    "retained branch fixture",
  );

  const branchReport = await runPreflight({ ...fixture, privateNeedlesPath });
  assert.equal(findCheck(branchReport, "private-needles").status, "fail");

  await git(fixture.repositoryRoot, ["tag", "private-retained-tag"]);
  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await git(fixture.repositoryRoot, ["branch", "-D", "private-topic"]);
  const tagReport = await runPreflight({ ...fixture, privateNeedlesPath });
  assert.equal(findCheck(tagReport, "private-needles").status, "fail");

  await git(fixture.repositoryRoot, ["tag", "-d", "private-retained-tag"]);
  const unreachableReport = await runPreflight({
    ...fixture,
    privateNeedlesPath,
  });
  assert.equal(unreachableReport.status, "pass");
  assert.equal(unreachableReport.counts.privateNeedles, 0);
  assertValueSafe(unreachableReport, fixture, [privateNeedle]);
});

test("emits deterministic schema-valid JSON with fixed diagnostic text", async (t) => {
  const fixture = await createFixture(t);

  const first = await runPreflight(fixture);
  const second = await runPreflight(fixture);

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, "staledocs.public-beta-preflight.v1");
  assert.equal(first.status, "pass");
  assert.deepEqual(
    first.checks.map((check) => check.id),
    [...first.checks.map((check) => check.id)].sort(),
  );
  for (const check of first.checks) {
    assert.match(check.summary, /^[a-z0-9 ,.:-]+$/i);
  }
  assertValueSafe(first, fixture, [APPROVED_EMAIL]);
});

test("loads an ignored private needles file from the CLI flag or environment", async (t) => {
  const fixture = await createFixture(t);
  const privateNeedlesPath = await createNeedlesFile(fixture.repositoryRoot, [
    "absent-private-marker",
  ]);
  const commonArguments = [
    PREFLIGHT_SCRIPT,
    "--json",
    "--skip-source-artifacts",
    "--repository-root",
    fixture.repositoryRoot,
    "--policy",
    fixture.policyPath,
  ];

  const fromFlag = await execFileAsync(
    process.execPath,
    [...commonArguments, "--private-needles-file", privateNeedlesPath],
    { encoding: "utf8" },
  );
  const flagReport = JSON.parse(fromFlag.stdout);
  assert.equal(flagReport.status, "pass");
  assert.equal(
    findCheck(flagReport, "private-needles").summary,
    "No private needles were found in retained history.",
  );

  const fromEnvironment = await execFileAsync(
    process.execPath,
    commonArguments,
    {
      encoding: "utf8",
      env: {
        ...process.env,
        STALEDOCS_PRIVATE_NEEDLES_FILE: privateNeedlesPath,
      },
    },
  );
  const environmentReport = JSON.parse(fromEnvironment.stdout);
  assert.deepEqual(environmentReport, flagReport);
  assertValueSafe(environmentReport, fixture, ["absent-private-marker"]);
});

test("rejects replacement refs and audits the original retained objects", async (t) => {
  const fixture = await createFixture(t);
  const privateNeedle = "replacement-hidden-private-marker";
  const privateNeedlesPath = await createNeedlesFile(fixture.repositoryRoot, [
    privateNeedle,
  ]);
  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await setIdentity(fixture.repositoryRoot, PRIVATE_EMAIL);
  await commitFile(
    fixture.repositoryRoot,
    "replacement.txt",
    `${privateNeedle}\n`,
    "original private replacement fixture",
  );
  const original = (
    await git(fixture.repositoryRoot, ["rev-parse", "HEAD"])
  ).stdout.trim();

  await git(fixture.repositoryRoot, ["checkout", "main"]);
  await git(fixture.repositoryRoot, ["checkout", "-b", "sanitized-view"]);
  await setIdentity(fixture.repositoryRoot);
  await commitFile(
    fixture.repositoryRoot,
    "replacement.txt",
    "sanitized replacement view\n",
    "sanitized replacement fixture",
  );
  const sanitized = (
    await git(fixture.repositoryRoot, ["rev-parse", "HEAD"])
  ).stdout.trim();
  await git(fixture.repositoryRoot, ["replace", original, sanitized]);
  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await git(fixture.repositoryRoot, ["branch", "-D", "sanitized-view"]);

  const report = await runPreflight({ ...fixture, privateNeedlesPath });

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "replacement-refs").status, "fail");
  assert.equal(findCheck(report, "identity-policy").status, "fail");
  assert.equal(findCheck(report, "private-needles").status, "fail");
  assertValueSafe(report, fixture, [privateNeedle, PRIVATE_EMAIL]);
});

test("ignores ambient Git repository redirection variables", async (t) => {
  const unsafeFixture = await createFixture(t);
  const decoyFixture = await createFixture(t);
  const privateNeedle = "ambient-git-dir-private-marker";
  const privateNeedlesPath = await createNeedlesFile(
    unsafeFixture.repositoryRoot,
    [privateNeedle],
  );
  await git(unsafeFixture.repositoryRoot, [
    "checkout",
    "codex/release-integrity",
  ]);
  await commitFile(
    unsafeFixture.repositoryRoot,
    "ambient.txt",
    `${privateNeedle}\n`,
    "ambient repository fixture",
  );

  const previousGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(decoyFixture.repositoryRoot, ".git");
  let report;
  try {
    report = await runPreflight({
      ...unsafeFixture,
      privateNeedlesPath,
    });
  } finally {
    if (previousGitDir === undefined) {
      delete process.env.GIT_DIR;
    } else {
      process.env.GIT_DIR = previousGitDir;
    }
  }

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "repository-identity").status, "pass");
  assert.equal(findCheck(report, "private-needles").status, "fail");
  assertValueSafe(report, unsafeFixture, [privateNeedle]);
});

test("fails a shallow repository before claiming complete history", async (t) => {
  const sourceFixture = await createFixture(t);
  const privateNeedle = "shallow-parent-private-marker";
  await git(sourceFixture.repositoryRoot, ["checkout", "main"]);
  await setIdentity(sourceFixture.repositoryRoot, PRIVATE_EMAIL);
  await commitFile(
    sourceFixture.repositoryRoot,
    "shallow.txt",
    `${privateNeedle}\n`,
    "private shallow parent",
  );
  await setIdentity(sourceFixture.repositoryRoot);
  await commitFile(
    sourceFixture.repositoryRoot,
    "shallow.txt",
    "sanitized shallow tip\n",
    "sanitized shallow tip",
  );
  await git(sourceFixture.repositoryRoot, [
    "branch",
    "--force",
    "codex/release-integrity",
    "main",
  ]);

  const cloneParent = await mkdtemp(
    path.join(tmpdir(), "staledocs-public-beta-shallow-"),
  );
  t.after(() => rm(cloneParent, { recursive: true, force: true }));
  const repositoryRoot = path.join(cloneParent, "clone");
  await execFileAsync(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      pathToFileURL(sourceFixture.repositoryRoot).href,
      repositoryRoot,
    ],
    { encoding: "utf8" },
  );
  await git(repositoryRoot, [
    "remote",
    "set-url",
    "origin",
    "https://github.com/example/staledocs.git",
  ]);
  await setIdentity(repositoryRoot);
  await git(repositoryRoot, ["branch", "codex/release-integrity"]);
  await writeFile(
    path.join(repositoryRoot, ".gitignore"),
    ".private/\n",
    "utf8",
  );
  const policyPath = path.join(
    repositoryRoot,
    ".github",
    "public-beta-policy.json",
  );
  await mkdir(path.dirname(policyPath), { recursive: true });
  await writeFile(
    policyPath,
    await readFile(sourceFixture.policyPath, "utf8"),
    "utf8",
  );
  const privateNeedlesPath = await createNeedlesFile(repositoryRoot, [
    privateNeedle,
  ]);

  const report = await runPreflight({
    repositoryRoot,
    policyPath,
    privateNeedlesPath,
    mainRef: "main",
    candidateRef: "codex/release-integrity",
  });

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "repository-completeness").status, "fail");
  assert.equal(report.counts.privateNeedles, 0);
  assertValueSafe(report, { repositoryRoot }, [privateNeedle]);
});

test("scans complete nested paths in retained history", async (t) => {
  const fixture = await createFixture(t);
  const privateNeedle = "private-directory/emoji-😀-file.txt";
  const privateNeedlesPath = await createNeedlesFile(fixture.repositoryRoot, [
    privateNeedle,
  ]);
  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await commitFile(
    fixture.repositoryRoot,
    privateNeedle,
    "safe file contents\n",
    "private path fixture",
  );

  const report = await runPreflight({ ...fixture, privateNeedlesPath });

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "private-needles").status, "fail");
  assert.equal(report.counts.privateNeedles, 1);
  assertValueSafe(report, fixture, [privateNeedle]);
});

test("fails when the repository-local identity is not protected", async (t) => {
  const fixture = await createFixture(t);
  await setIdentity(fixture.repositoryRoot, PRIVATE_EMAIL);

  const report = await runPreflight(fixture);

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "local-identity").status, "fail");
  assertValueSafe(report, fixture, [PRIVATE_EMAIL]);
});

test("fails when a retained ref has disconnected history", async (t) => {
  const fixture = await createFixture(t);
  await git(fixture.repositoryRoot, ["switch", "--orphan", "disconnected"]);
  await git(fixture.repositoryRoot, [
    "commit",
    "--allow-empty",
    "-m",
    "disconnected fixture",
  ]);
  await git(fixture.repositoryRoot, ["switch", "codex/release-integrity"]);

  const report = await runPreflight(fixture);

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "ref-topology").status, "fail");
  assertValueSafe(report, fixture);
});

test("scans paths introduced only by a merge result tree", async (t) => {
  const fixture = await createFixture(t);
  const privateNeedle = "merge-private/emoji-😀-file.txt";
  const privateNeedlesPath = await createNeedlesFile(fixture.repositoryRoot, [
    privateNeedle,
  ]);
  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await git(fixture.repositoryRoot, ["checkout", "-b", "merge-left"]);
  await commitFile(
    fixture.repositoryRoot,
    "left.txt",
    "left parent\n",
    "left merge parent",
  );
  await git(fixture.repositoryRoot, ["checkout", "main"]);
  await git(fixture.repositoryRoot, ["checkout", "-b", "merge-right"]);
  await commitFile(
    fixture.repositoryRoot,
    "right.txt",
    "right parent\n",
    "right merge parent",
  );
  await git(fixture.repositoryRoot, ["checkout", "merge-left"]);
  await git(fixture.repositoryRoot, ["merge", "--no-commit", "merge-right"]);
  const mergeOnlyPath = path.join(fixture.repositoryRoot, privateNeedle);
  await mkdir(path.dirname(mergeOnlyPath), { recursive: true });
  await writeFile(mergeOnlyPath, "safe merge-only contents\n", "utf8");
  await git(fixture.repositoryRoot, ["add", privateNeedle]);
  await git(fixture.repositoryRoot, ["commit", "-m", "merge result fixture"]);

  const report = await runPreflight({ ...fixture, privateNeedlesPath });

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "private-needles").status, "fail");
  assert.equal(report.counts.privateNeedles, 1);
  assertValueSafe(report, fixture, [privateNeedle]);
});

test("rejects legacy grafts and audits the ungrafted history", async (t) => {
  const fixture = await createFixture(t);
  const privateNeedle = "legacy-graft-private-marker";
  const privateNeedlesPath = await createNeedlesFile(fixture.repositoryRoot, [
    privateNeedle,
  ]);
  await git(fixture.repositoryRoot, ["checkout", "codex/release-integrity"]);
  await setIdentity(fixture.repositoryRoot, PRIVATE_EMAIL);
  await commitFile(
    fixture.repositoryRoot,
    "graft.txt",
    `${privateNeedle}\n`,
    "private graft parent",
  );
  await setIdentity(fixture.repositoryRoot);
  await commitFile(
    fixture.repositoryRoot,
    "graft.txt",
    "sanitized graft tip\n",
    "sanitized graft tip",
  );
  const tip = (
    await git(fixture.repositoryRoot, ["rev-parse", "HEAD"])
  ).stdout.trim();
  const commonDirectory = (
    await git(fixture.repositoryRoot, ["rev-parse", "--git-common-dir"])
  ).stdout.trim();
  const graftsPath = path.resolve(
    fixture.repositoryRoot,
    commonDirectory,
    "info",
    "grafts",
  );
  await mkdir(path.dirname(graftsPath), { recursive: true });
  await writeFile(graftsPath, `${tip}\n`, "utf8");

  const report = await runPreflight({ ...fixture, privateNeedlesPath });

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "legacy-grafts").status, "fail");
  assert.equal(findCheck(report, "identity-policy").status, "fail");
  assert.equal(findCheck(report, "private-needles").status, "fail");
  assertValueSafe(report, fixture, [privateNeedle, PRIVATE_EMAIL]);
});

test("fails an unsafe worktree-local identity override", async (t) => {
  const fixture = await createFixture(t);
  await git(fixture.repositoryRoot, [
    "config",
    "extensions.worktreeConfig",
    "true",
  ]);
  await git(fixture.repositoryRoot, [
    "config",
    "--worktree",
    "user.email",
    PRIVATE_EMAIL,
  ]);

  const report = await runPreflight(fixture);

  assert.equal(report.status, "fail");
  assert.equal(findCheck(report, "local-identity").status, "fail");
  assertValueSafe(report, fixture, [PRIVATE_EMAIL]);
});

test("detects missing and present beta source artifacts when requested", async (t) => {
  const fixture = await createFixture(t);

  const missingReport = await runPreflight({
    ...fixture,
    includeSourceArtifacts: true,
  });
  assert.equal(missingReport.status, "fail");
  assert.equal(findCheck(missingReport, "codex-plugin-source").status, "fail");
  assert.equal(findCheck(missingReport, "claude-plugin-source").status, "fail");
  assert.equal(
    findCheck(missingReport, "integration-documentation").status,
    "fail",
  );
  assert.equal(
    findCheck(missingReport, "storefront-documentation").status,
    "fail",
  );
  assert.equal(findCheck(missingReport, "hybrid-demo-source").status, "fail");
  assert.equal(findCheck(missingReport, "compiled-mcp").status, "fail");
  assert.equal(findCheck(missingReport, "storefront-static").status, "fail");
  assert.equal(findCheck(missingReport, "storefront-media").status, "fail");
  assertValueSafe(missingReport, fixture);

  await git(fixture.repositoryRoot, ["checkout", fixture.candidateRef]);
  const sourceArtifactPaths = await createSourceArtifacts(
    fixture.repositoryRoot,
  );
  const untrackedReport = await runPreflight({
    ...fixture,
    includeSourceArtifacts: true,
  });
  for (const checkId of [
    "codex-plugin-source",
    "claude-plugin-source",
    "integration-documentation",
    "storefront-documentation",
    "hybrid-demo-source",
    "storefront-static",
    "storefront-media",
  ]) {
    assert.equal(
      findCheck(untrackedReport, checkId).status,
      "fail",
      `${checkId} must ignore untracked worktree files`,
    );
  }
  assert.equal(
    findCheck(untrackedReport, "compiled-mcp").status,
    "pass",
    "ignored compiled outputs are verified from the worktree after build",
  );

  await git(fixture.repositoryRoot, ["add", "--", ...sourceArtifactPaths]);
  await git(fixture.repositoryRoot, [
    "commit",
    "-m",
    "add beta source artifacts",
  ]);
  const modifiedStaticSource =
    "docs/assets/social/staledocs-social-preview-source.png";
  await writeFile(
    path.join(fixture.repositoryRoot, modifiedStaticSource),
    "worktree-only replacement\n",
    "utf8",
  );
  const modifiedReport = await runPreflight({
    ...fixture,
    includeSourceArtifacts: true,
  });
  assert.equal(
    findCheck(modifiedReport, "storefront-static").status,
    "fail",
    "source artifacts must match the selected candidate tree",
  );
  await git(fixture.repositoryRoot, ["restore", "--", modifiedStaticSource]);

  const presentReport = await runPreflight({
    ...fixture,
    includeSourceArtifacts: true,
  });
  assert.equal(findCheck(presentReport, "codex-plugin-source").status, "pass");
  assert.equal(findCheck(presentReport, "claude-plugin-source").status, "pass");
  assert.equal(
    findCheck(presentReport, "integration-documentation").status,
    "pass",
  );
  assert.equal(
    findCheck(presentReport, "storefront-documentation").status,
    "pass",
  );
  assert.equal(findCheck(presentReport, "hybrid-demo-source").status, "pass");
  assert.equal(findCheck(presentReport, "compiled-mcp").status, "pass");
  assert.equal(findCheck(presentReport, "storefront-static").status, "pass");
  assert.equal(findCheck(presentReport, "storefront-media").status, "pass");
  assertValueSafe(presentReport, fixture);
});
