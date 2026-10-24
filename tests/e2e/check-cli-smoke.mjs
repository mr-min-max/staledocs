import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const cli = resolve("dist/cli/index.js");
const repo = mkdtempSync(join(tmpdir(), "staledocs-check-cli-"));
const fakePolicySecret = ["sk", "proj", "X".repeat(32)].join("-");
const fakeParserSecret = ["sk", "proj", "J".repeat(32)].join("-");
const emptyGitTemplate = join(repo, "empty-git-template");
const hostileHooks = join(repo, "hostile-hooks");
const hostileGitConfig = join(repo, "hostile.gitconfig");
const originalGitConfig = process.env.GIT_CONFIG_GLOBAL;

mkdirSync(join(emptyGitTemplate, "hooks"), { recursive: true });
mkdirSync(hostileHooks);
writeFileSync(
  join(hostileHooks, "pre-commit"),
  "#!/usr/bin/env bash\nexit 1\n",
);
chmodSync(join(hostileHooks, "pre-commit"), 0o755);
writeFileSync(
  hostileGitConfig,
  `[commit]\n\tgpgSign = true\n[core]\n\thooksPath = ${hostileHooks}\n`,
);
process.env.GIT_CONFIG_GLOBAL = hostileGitConfig;

function git(...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      `core.hooksPath=${join(emptyGitTemplate, "hooks")}`,
      ...args,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function commit(message) {
  git("add", ".");
  git("commit", "-m", message);
}

function check(target, since) {
  const args = [cli, "check"];
  if (target !== undefined) args.push("--target", target);
  args.push("--since", since, "--json");
  const result = spawnSync(process.execPath, args, {
    cwd: repo,
    encoding: "utf8",
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line: ${result.stdout}`);
  return { status: result.status, report: JSON.parse(lines[0]) };
}

try {
  git("init", "--quiet", `--template=${emptyGitTemplate}`);
  git("config", "user.name", "staledocs test");
  git("config", "user.email", "staledocs-test@example.invalid");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "README.md"), "# Fixture\n\n## API\n\n`api` is public.\n");
  writeFileSync(
    join(repo, "src", "index.ts"),
    "export function api(): number { return 1; }\n",
  );
  commit("fixture: baseline");
  const base = git("rev-parse", "HEAD");

  writeFileSync(join(repo, "notes.txt"), "non-source change\n");
  commit("fixture: non-source");
  assert.deepEqual(check("README.md", base), {
    status: 0,
    report: {
      status: "clean",
      target: "README.md",
      targetChanged: false,
      referencedSymbols: [],
      sections: [],
      unmappedSymbols: [],
      sourceFiles: [],
      message: "No changed public symbol is mentioned in README.md",
    },
  });

  writeFileSync(
    join(repo, "src", "index.ts"),
    "export function api(): number { return 2; }\n",
  );
  commit("fixture: implementation-only change");
  const implementationOnly = check("README.md", base);
  assert.equal(implementationOnly.status, 0);
  assert.equal(implementationOnly.report.status, "clean");
  assert.deepEqual(implementationOnly.report.referencedSymbols, []);

  writeFileSync(
    join(repo, "src", "index.ts"),
    'export function api(): string { return "2"; }\n',
  );
  commit("fixture: contract change");
  const stale = check("README.md", base);
  assert.equal(stale.status, 1);
  assert.equal(stale.report.status, "stale");

  const missing = check("MISSING.md", base);
  assert.equal(missing.status, 1);
  assert.equal(missing.report.status, "missing");

  const unknown = check("README.md", "missing-ref");
  assert.equal(unknown.status, 2);
  assert.equal(unknown.report.status, "unknown");

  writeFileSync(
    join(repo, "README.md"),
    "# Fixture updated\n\n## API\n\n`api` changed.\n",
  );
  commit("fixture: docs co-change");
  const coChanged = check("README.md", base);
  assert.equal(coChanged.status, 0);
  assert.equal(coChanged.report.status, "co-changed");

  writeFileSync(
    join(repo, "src", "index.ts"),
    "export function api(value: string): number { return value.length; }\n",
  );
  writeFileSync(
    join(repo, "README.md"),
    "# Fixture updated\n\n## API\n\n`api(value)` changed again.\n",
  );
  git("mv", "README.md", "readme.md");
  const lowercaseBase = git("rev-parse", "HEAD");
  commit("fixture: lowercase README co-change");
  const lowercaseCoChanged = check(undefined, lowercaseBase);
  assert.equal(lowercaseCoChanged.status, 0);
  assert.equal(lowercaseCoChanged.report.status, "co-changed");
  assert.equal(lowercaseCoChanged.report.target, "readme.md");

  writeFileSync(join(repo, "readme.md"), "# Fixture updated\n");
  commit("fixture: unrelated documentation baseline");
  writeFileSync(
    join(repo, "src", "other.ts"),
    "function helper() { return 1; }\nexport function other() { return helper(); }\n",
  );
  const unrelatedBase = git("rev-parse", "HEAD");
  commit("fixture: unrelated public helper");
  const unrelatedClean = check(undefined, unrelatedBase);
  assert.equal(unrelatedClean.status, 0);
  assert.equal(unrelatedClean.report.status, "clean");
  assert.deepEqual(unrelatedClean.report.unmappedSymbols, ["other"]);

  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "staledocs-policy-fixture",
      description: fakePolicySecret,
    }),
  );
  const strictResult = spawnSync(
    process.execPath,
    [cli, "readme", "--output", "STRICT.md", "--yes", "--strict-output"],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        STALEDOCS_PROVIDER: "openai",
        STALEDOCS_MODEL: "gpt-5.6-luna",
        STALEDOCS_TRUST_POLICY: "strict",
        OPENAI_API_KEY: ["runtime", "provider", "credential"].join("-"),
      },
    },
  );
  assert.equal(
    strictResult.status,
    2,
    `strict output status mismatch\nstdout: ${strictResult.stdout.replaceAll(fakePolicySecret, "<redacted>")}\nstderr: ${strictResult.stderr.replaceAll(fakePolicySecret, "<redacted>")}`,
  );
  assert.equal(
    `${strictResult.stdout}${strictResult.stderr}`.includes(fakePolicySecret),
    false,
  );

  writeFileSync(
    join(repo, "src", "broken.py"),
    `def broken(${fakeParserSecret}:\n`,
  );
  commit("fixture: malformed python");
  const parserFailure = check("README.md", base);
  assert.equal(parserFailure.status, 2);
  assert.equal(parserFailure.report.status, "unknown");
  assert.equal(parserFailure.report.message.includes(fakeParserSecret), false);
} finally {
  rmSync(repo, { recursive: true, force: true });
  if (originalGitConfig === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
  }
}
