#!/usr/bin/env node


import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const POLICY_SCHEMA = "staledocs.public-beta-policy.v1";
const REPORT_SCHEMA = "staledocs.public-beta-preflight.v1";
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;
const CURRENT_PACKAGE_VERSION = JSON.parse(
  readFileSync(path.resolve("package.json"), "utf8"),
).version;
const BETA_SOURCE_ARTIFACTS = Object.freeze({
  codexPlugin: Object.freeze([
    "integrations/codex/staledocs/.codex-plugin/plugin.json",
    "integrations/codex/staledocs/.mcp.json",
    "integrations/codex/staledocs/skills/maintain-documentation/SKILL.md",
  ]),
  claudePlugin: Object.freeze([
    ".claude-plugin/marketplace.json",
    "integrations/claude/staledocs/.claude-plugin/plugin.json",
    "integrations/claude/staledocs/.mcp.json",
    "integrations/claude/staledocs/skills/check/SKILL.md",
    "integrations/claude/staledocs/skills/review/SKILL.md",
    "integrations/claude/staledocs/skills/maintain-documentation/SKILL.md",
    "integrations/claude/staledocs/assets/icon.png",
  ]),
  integrationDocumentation: Object.freeze([
    "README.md",
    "docs/PUBLIC_BETA.md",
    "docs/integrations/codex.md",
    "docs/integrations/claude.md",
    "docs/releases/v0.2.0-beta.4.md",
    "docs/releases/v0.2.0-beta.5.md",
    "docs/releases/v0.3.0-beta.1.md",
    "docs/releases/v0.4.0-beta.1.md",
  ]),
  storefrontDocumentation: Object.freeze([
    "docs/CLI.md",
    "docs/GITHUB_ACTION.md",
    "tests/e2e/storefront-demo.test.mjs",
  ]),
  hybridDemo: Object.freeze([
    "scripts/demo-hybrid-beta.mjs",
    "scripts/hybrid-beta-snapshot.mjs",
    "tests/e2e/hybrid-beta-demo.test.mjs",
  ]),
  compiledMcp: Object.freeze([
    "dist/mcp/server.js",
    "dist/mcp/repository-scope.js",
    "dist/mcp/scoped-config.js",
    "dist/mcp/scoped-freshness.js",
    "dist/mcp/update-workflow.js",
    "dist/mcp/preparation-token.js",
    "dist/core/update-preparation.js",
    "dist/templates/update.hbs",
  ]),
  storefrontStatic: Object.freeze([
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
  ]),
  storefrontMedia: Object.freeze([
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
  ]),
});
const ROOT_POLICY_KEYS = [
  "allowedAutomationEmails",
  "candidateBranch",
  "canonicalRepository",
  "defaultBranch",
  "protectedIdentities",
  "schemaVersion",
];
const IDENTITY_KEYS = ["emails", "name"];

class InvocationError extends Error {}
class GitOperationError extends Error {}

function hasExactKeys(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function isSafeText(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isEmail(value) {
  return isSafeText(value) && /^[^\s@]+@[^\s@]+$/u.test(value);
}

function isUniqueStringArray(value, validator) {
  return (
    Array.isArray(value) &&
    value.every(validator) &&
    new Set(value).size === value.length
  );
}

function validatePolicy(value) {
  if (!hasExactKeys(value, ROOT_POLICY_KEYS)) {
    throw new InvocationError("Invalid policy.");
  }
  if (
    value.schemaVersion !== POLICY_SCHEMA ||
    !isSafeText(value.canonicalRepository) ||
    !/^[^/\s]+\/[^/\s]+$/u.test(value.canonicalRepository) ||
    !isSafeText(value.defaultBranch) ||
    !isSafeText(value.candidateBranch) ||
    !Array.isArray(value.protectedIdentities) ||
    value.protectedIdentities.length === 0 ||
    !isUniqueStringArray(value.allowedAutomationEmails, isEmail)
  ) {
    throw new InvocationError("Invalid policy.");
  }

  const names = new Set();
  const protectedEmails = new Set();
  for (const identity of value.protectedIdentities) {
    if (
      !hasExactKeys(identity, IDENTITY_KEYS) ||
      !isSafeText(identity.name) ||
      !isUniqueStringArray(identity.emails, isEmail) ||
      identity.emails.length === 0 ||
      names.has(identity.name)
    ) {
      throw new InvocationError("Invalid policy.");
    }
    names.add(identity.name);
    for (const email of identity.emails) {
      if (protectedEmails.has(email)) {
        throw new InvocationError("Invalid policy.");
      }
      protectedEmails.add(email);
    }
  }

  for (const email of value.allowedAutomationEmails) {
    if (protectedEmails.has(email)) {
      throw new InvocationError("Invalid policy.");
    }
  }

  return value;
}

async function loadPolicy(policyPath) {
  try {
    const source = await readFile(policyPath, "utf8");
    return validatePolicy(JSON.parse(source));
  } catch (error) {
    if (error instanceof InvocationError) {
      throw error;
    }
    throw new InvocationError("Invalid policy.");
  }
}

function gitEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_GRAFT_FILE: devNull,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function gitBuffer(repositoryRoot, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repositoryRoot,
      encoding: null,
      env: gitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return stdout;
  } catch {
    throw new GitOperationError("Git operation failed.");
  }
}

async function gitText(repositoryRoot, args) {
  return (await gitBuffer(repositoryRoot, args)).toString("utf8");
}

async function gitExitCode(repositoryRoot, args) {
  try {
    await execFileAsync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: gitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return 0;
  } catch (error) {
    if (typeof error?.code === "number") {
      return error.code;
    }
    throw new GitOperationError("Git operation failed.");
  }
}

function normalizeRepositoryUrl(remoteUrl) {
  const trimmed = remoteUrl.trim().replace(/\.git$/u, "");
  if (trimmed.startsWith("git@github.com:")) {
    return trimmed.slice("git@github.com:".length).toLowerCase();
  }
  if (trimmed.startsWith("ssh://git@github.com/")) {
    return trimmed.slice("ssh://git@github.com/".length).toLowerCase();
  }
  if (trimmed.startsWith("https://github.com/")) {
    return trimmed.slice("https://github.com/".length).toLowerCase();
  }
  return "";
}

async function repositoryTopLevelMatches(repositoryRoot) {
  const expected = await realpath(repositoryRoot);
  const reported = (
    await gitText(repositoryRoot, ["rev-parse", "--show-toplevel"])
  ).trim();
  return expected === (await realpath(reported));
}

async function hasReplacementRefs(repositoryRoot) {
  const output = await gitText(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace",
  ]);
  return output.split("\n").some(Boolean);
}

async function hasLegacyGrafts(repositoryRoot) {
  const commonDirectory = (
    await gitText(repositoryRoot, ["rev-parse", "--git-common-dir"])
  ).trim();
  const graftsPath = path.resolve(
    repositoryRoot,
    commonDirectory,
    "info",
    "grafts",
  );
  try {
    return (await readFile(graftsPath)).length > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new GitOperationError("Git graft state could not be read.");
  }
}

async function isCompleteRepository(repositoryRoot) {
  const output = await gitText(repositoryRoot, [
    "rev-parse",
    "--is-shallow-repository",
  ]);
  return output.trim() === "false";
}

async function localIdentityMatches(repositoryRoot, policy) {
  const [name, email] = await Promise.all([
    gitText(repositoryRoot, ["config", "--get", "user.name"]),
    gitText(repositoryRoot, ["config", "--get", "user.email"]),
  ]);
  const identity = policy.protectedIdentities.find(
    (candidate) => candidate.name === name.trim(),
  );
  return identity?.emails.includes(email.trim()) === true;
}

async function enumerateRetainedRefs(repositoryRoot) {
  const output = await gitText(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes/origin",
    "refs/tags",
  ]);
  return [...new Set(output.split("\n").filter(Boolean))].sort();
}

async function enumerateCommits(repositoryRoot, refs) {
  if (refs.length === 0) {
    throw new GitOperationError("No retained refs.");
  }
  const output = await gitText(repositoryRoot, ["rev-list", ...refs]);
  return [...new Set(output.split("\n").filter(Boolean))].sort();
}

async function gitPredicate(repositoryRoot, args) {
  const exitCode = await gitExitCode(repositoryRoot, args);
  if (exitCode === 0) return true;
  if (exitCode === 1) return false;
  throw new GitOperationError("Git predicate failed.");
}

async function retainedRefsShareHistory(repositoryRoot, mainRef, refs) {
  for (const ref of refs) {
    const connected = await gitPredicate(repositoryRoot, [
      "merge-base",
      mainRef,
      ref,
    ]);
    if (!connected) return false;
  }
  return true;
}

function parseIdentityRecords(output) {
  return output
    .split("\0\0")
    .map((record) => record.replace(/^\n+|\n+$/gu, ""))
    .filter(Boolean)
    .map((record) => {
      const fields = record.split("\0");
      if (fields.length !== 5) {
        throw new GitOperationError("Invalid identity record.");
      }
      return {
        commit: fields[0],
        authorName: fields[1],
        authorEmail: fields[2],
        committerName: fields[3],
        committerEmail: fields[4],
      };
    });
}

async function inspectIdentities(repositoryRoot, refs, policy) {
  const output = await gitText(repositoryRoot, [
    "log",
    "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%x00",
    ...refs,
  ]);
  const records = parseIdentityRecords(output);
  const identitiesByName = new Map(
    policy.protectedIdentities.map((identity) => [
      identity.name,
      new Set(identity.emails),
    ]),
  );
  const protectedEmails = new Set(
    policy.protectedIdentities.flatMap((identity) => identity.emails),
  );
  const allowedEmails = new Set([
    ...protectedEmails,
    ...policy.allowedAutomationEmails,
  ]);
  const protectedCommits = new Set();
  let valid = true;

  for (const record of records) {
    for (const [name, email] of [
      [record.authorName, record.authorEmail],
      [record.committerName, record.committerEmail],
    ]) {
      const protectedIdentityEmails = identitiesByName.get(name);
      if (
        !allowedEmails.has(email) ||
        (protectedIdentityEmails && !protectedIdentityEmails.has(email))
      ) {
        valid = false;
      }
      if (protectedIdentityEmails || protectedEmails.has(email)) {
        protectedCommits.add(record.commit);
      }
    }
  }

  return { valid, protectedIdentityCommits: protectedCommits.size };
}

async function loadPrivateNeedles(repositoryRoot, privateNeedlesPath) {
  if (privateNeedlesPath === undefined) {
    return [];
  }
  if (!path.isAbsolute(privateNeedlesPath)) {
    throw new InvocationError("Invalid private needles file.");
  }

  const relativePath = path.relative(repositoryRoot, privateNeedlesPath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new InvocationError("Invalid private needles file.");
  }

  const ignored = await gitExitCode(repositoryRoot, [
    "check-ignore",
    "--quiet",
    "--",
    relativePath,
  ]);
  if (ignored !== 0) {
    throw new InvocationError("Invalid private needles file.");
  }

  let source;
  try {
    source = await readFile(privateNeedlesPath, "utf8");
  } catch {
    throw new InvocationError("Invalid private needles file.");
  }
  const lines = source.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (
    lines.length === 0 ||
    lines.some(
      (needle) =>
        needle.length === 0 ||
        // eslint-disable-next-line no-control-regex
        /[\u0000\r\n]/u.test(needle),
    ) ||
    new Set(lines).size !== lines.length
  ) {
    throw new InvocationError("Invalid private needles file.");
  }
  return lines;
}

async function enumerateReachableObjects(repositoryRoot, refs) {
  const output = await gitText(repositoryRoot, [
    "rev-list",
    "--objects",
    "--no-object-names",
    ...refs,
  ]);
  return [...new Set(output.split("\n").filter(Boolean))].sort();
}

async function scanReachablePaths(repositoryRoot, commits, needles) {
  const matchedIndexes = new Set();
  const needleBuffers = needles.map((needle) => Buffer.from(needle, "utf8"));
  for (const commit of commits) {
    const output = await gitBuffer(repositoryRoot, [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      commit,
    ]);
    needleBuffers.forEach((needle, index) => {
      if (!matchedIndexes.has(index) && output.includes(needle)) {
        matchedIndexes.add(index);
      }
    });
    if (matchedIndexes.size === needles.length) {
      break;
    }
  }
  return matchedIndexes;
}

function scanBatchOutput(output, needles) {
  const needleBuffers = needles.map((needle) => Buffer.from(needle, "utf8"));
  const matchedIndexes = new Set();
  let offset = 0;

  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      throw new GitOperationError("Invalid batch output.");
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const fields = header.split(" ");
    if (fields.length !== 3) {
      throw new GitOperationError("Invalid batch output.");
    }
    const size = Number(fields[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      contentEnd >= output.length ||
      output[contentEnd] !== 0x0a
    ) {
      throw new GitOperationError("Invalid batch output.");
    }
    const content = output.subarray(contentStart, contentEnd);
    for (let index = 0; index < needleBuffers.length; index += 1) {
      if (
        !matchedIndexes.has(index) &&
        content.includes(needleBuffers[index])
      ) {
        matchedIndexes.add(index);
      }
    }
    offset = contentEnd + 1;
  }

  return matchedIndexes;
}

async function scanReachableObjects(repositoryRoot, objectIds, needles) {
  if (objectIds.length === 0 || needles.length === 0) {
    return new Set();
  }

  const output = await new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: repositoryRoot,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let byteLength = 0;
    let exceededLimit = false;

    child.on("error", () =>
      reject(new GitOperationError("Git operation failed.")),
    );
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > MAX_GIT_OUTPUT_BYTES) {
        exceededLimit = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (exceededLimit || code !== 0) {
        reject(new GitOperationError("Git operation failed."));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`${objectIds.join("\n")}\n`);
  });

  return scanBatchOutput(output, needles);
}

function makeCheck(id, status, summary) {
  return { id, status, summary };
}

async function sourceArtifactFilesPresent(
  repositoryRoot,
  candidateRef,
  relativePaths,
  { matchCandidateTree = true } = {},
) {
  const worktreeFilesPresent = relativePaths.every((relativePath) => {
    try {
      const candidate = path.resolve(repositoryRoot, relativePath);
      const relative = path.relative(repositoryRoot, candidate);
      return (
        relative.length > 0 &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        lstatSync(candidate).isFile()
      );
    } catch {
      return false;
    }
  });
  if (!worktreeFilesPresent || !matchCandidateTree) {
    return worktreeFilesPresent;
  }

  let candidatePaths;
  try {
    const treeId = (
      await gitText(repositoryRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${candidateRef}^{tree}`,
      ])
    ).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(treeId)) {
      return false;
    }
    const output = await gitBuffer(repositoryRoot, [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      treeId,
      "--",
      ...relativePaths,
    ]);
    candidatePaths = new Set(
      output.toString("utf8").split("\0").filter(Boolean),
    );
    const worktreeMatchesCandidate =
      (await gitExitCode(repositoryRoot, [
        "diff",
        "--quiet",
        treeId,
        "--",
        ...relativePaths,
      ])) === 0;
    if (!worktreeMatchesCandidate) {
      return false;
    }
  } catch {
    return false;
  }

  return relativePaths.every((relativePath) =>
    candidatePaths.has(relativePath),
  );
}

async function sourceArtifactChecks(repositoryRoot, candidateRef) {
  const codexFilesPresent = await sourceArtifactFilesPresent(
    repositoryRoot,
    candidateRef,
    BETA_SOURCE_ARTIFACTS.codexPlugin,
  );
  let codexShapeValid = false;
  if (codexFilesPresent) {
    try {
      const manifest = JSON.parse(
        await readFile(
          path.resolve(
            repositoryRoot,
            "integrations/codex/staledocs/.codex-plugin/plugin.json",
          ),
          "utf8",
        ),
      );
      const mcp = JSON.parse(
        await readFile(
          path.resolve(repositoryRoot, "integrations/codex/staledocs/.mcp.json"),
          "utf8",
        ),
      );
      const skill = await readFile(
        path.resolve(
          repositoryRoot,
          "integrations/codex/staledocs/skills/maintain-documentation/SKILL.md",
        ),
        "utf8",
      );
      const mcpServer = mcp?.mcpServers?.staledocs;
      const skillOrder = [
        "prepare_documentation_update",
        "generation.system_prompt",
        "generation.prompt",
        "validate_documentation_draft",
        "approved_markdown",
        "check_docs_freshness",
      ];
      codexShapeValid =
        manifest?.name === "staledocs" &&
        manifest?.version === CURRENT_PACKAGE_VERSION &&
        manifest?.skills === "./skills/" &&
        manifest?.mcpServers === "./.mcp.json" &&
        JSON.stringify(Object.keys(mcp)) === JSON.stringify(["mcpServers"]) &&
        JSON.stringify(Object.keys(mcp.mcpServers ?? {})) ===
          JSON.stringify(["staledocs"]) &&
        JSON.stringify(mcpServer) ===
          JSON.stringify({ command: "staledocs", args: ["--mcp"] }) &&
        skillOrder.every((term, index, terms) => {
          const current = skill.indexOf(term);
          const previous = index === 0 ? -1 : skill.indexOf(terms[index - 1]);
          return current > previous;
        });
    } catch {
      codexShapeValid = false;
    }
  }
  const claudeFilesPresent = await sourceArtifactFilesPresent(
    repositoryRoot,
    candidateRef,
    BETA_SOURCE_ARTIFACTS.claudePlugin,
  );


  const docsPresent = await sourceArtifactFilesPresent(
    repositoryRoot,
    candidateRef,
    BETA_SOURCE_ARTIFACTS.integrationDocumentation,
  );
  const storefrontDocumentationPresent = await sourceArtifactFilesPresent(
    repositoryRoot,
    candidateRef,
    BETA_SOURCE_ARTIFACTS.storefrontDocumentation,
  );
  const demoFilesPresent = await sourceArtifactFilesPresent(
    repositoryRoot,
    candidateRef,
    BETA_SOURCE_ARTIFACTS.hybridDemo,
  );
  let demoShapeValid = false;
  if (demoFilesPresent) {
    try {
      const demoSource = await readFile(
        path.resolve(repositoryRoot, "scripts/demo-hybrid-beta.mjs"),
        "utf8",
      );
      demoShapeValid =
        demoSource.includes("staledocs.hybrid-beta-demo.v1") &&
        demoSource.includes("prepare_documentation_update") &&
        demoSource.includes("validate_documentation_draft");
    } catch {
      demoShapeValid = false;
    }
  }
  // dist/ is intentionally ignored and built before this gate, so compiled
  // MCP outputs are worktree evidence rather than candidate-tree sources.
  const compiledMcpPresent = await sourceArtifactFilesPresent(
    repositoryRoot,
    candidateRef,
    BETA_SOURCE_ARTIFACTS.compiledMcp,
    { matchCandidateTree: false },
  );
  const storefrontStaticPresent = await sourceArtifactFilesPresent(
    repositoryRoot,
    candidateRef,
    BETA_SOURCE_ARTIFACTS.storefrontStatic,
  );
  const storefrontMediaPresent = await sourceArtifactFilesPresent(
    repositoryRoot,
    candidateRef,
    BETA_SOURCE_ARTIFACTS.storefrontMedia,
  );

  return [
    makeCheck(
      "codex-plugin-source",
      codexFilesPresent && codexShapeValid ? "pass" : "fail",
      codexFilesPresent && codexShapeValid
        ? "Codex plugin source artifacts are present and shaped."
        : "Codex plugin source artifacts are missing or invalid.",
    ),
    makeCheck(
      "claude-plugin-source",
      claudeFilesPresent ? "pass" : "fail",
      claudeFilesPresent
        ? "Claude Code plugin source artifacts are present."
        : "Claude Code plugin source artifacts are missing.",
    ),
    makeCheck(
      "integration-documentation",
      docsPresent ? "pass" : "fail",
      docsPresent
        ? "Beta integration documentation artifacts are present."
        : "Beta integration documentation artifacts are missing.",
    ),
    makeCheck(
      "storefront-documentation",
      storefrontDocumentationPresent ? "pass" : "fail",
      storefrontDocumentationPresent
        ? "Storefront documentation artifacts are present."
        : "Storefront documentation artifacts are missing.",
    ),
    makeCheck(
      "hybrid-demo-source",
      demoFilesPresent && demoShapeValid ? "pass" : "fail",
      demoFilesPresent && demoShapeValid
        ? "Hybrid beta demo source artifacts are present and shaped."
        : "Hybrid beta demo source artifacts are missing or invalid.",
    ),
    makeCheck(
      "compiled-mcp",
      compiledMcpPresent ? "pass" : "fail",
      compiledMcpPresent
        ? "Compiled provider-free MCP artifacts are present."
        : "Compiled provider-free MCP artifacts are missing.",
    ),
    makeCheck(
      "storefront-static",
      storefrontStaticPresent ? "pass" : "fail",
      storefrontStaticPresent
        ? "Storefront static assets are present."
        : "Storefront static assets are missing.",
    ),
    makeCheck(
      "storefront-media",
      storefrontMediaPresent ? "pass" : "fail",
      storefrontMediaPresent
        ? "Storefront media assets are present."
        : "Storefront media assets are missing.",
    ),
  ];
}

export async function runPreflight({
  repositoryRoot,
  policyPath,
  privateNeedlesPath,
  mainRef,
  candidateRef,
  includeSourceArtifacts = false,
}) {
  if (!path.isAbsolute(repositoryRoot) || !path.isAbsolute(policyPath)) {
    throw new InvocationError("Invalid invocation.");
  }

  const policy = await loadPolicy(policyPath);
  const selectedMainRef = mainRef ?? policy.defaultBranch;
  const selectedCandidateRef = candidateRef ?? policy.candidateBranch;
  if (!isSafeText(selectedMainRef) || !isSafeText(selectedCandidateRef)) {
    throw new InvocationError("Invalid invocation.");
  }
  const privateNeedles = await loadPrivateNeedles(
    repositoryRoot,
    privateNeedlesPath,
  );
  const checks = [];
  let refs = [];
  let commits = [];
  let protectedIdentityCommits = 0;
  let matchedPrivateNeedles = 0;

  try {
    const matches = await repositoryTopLevelMatches(repositoryRoot);
    checks.push(
      makeCheck(
        "repository-identity",
        matches ? "pass" : "fail",
        matches
          ? "The requested repository root was verified."
          : "The requested repository root could not be verified.",
      ),
    );
  } catch {
    checks.push(
      makeCheck(
        "repository-identity",
        "fail",
        "The requested repository root could not be verified.",
      ),
    );
  }

  try {
    const complete = await isCompleteRepository(repositoryRoot);
    checks.push(
      makeCheck(
        "repository-completeness",
        complete ? "pass" : "fail",
        complete
          ? "Repository history is complete."
          : "Repository history is shallow or incomplete.",
      ),
    );
  } catch {
    checks.push(
      makeCheck(
        "repository-completeness",
        "fail",
        "Repository completeness could not be verified.",
      ),
    );
  }

  try {
    const replacementRefs = await hasReplacementRefs(repositoryRoot);
    checks.push(
      makeCheck(
        "replacement-refs",
        replacementRefs ? "fail" : "pass",
        replacementRefs
          ? "Git replacement refs are present."
          : "No Git replacement refs are present.",
      ),
    );
  } catch {
    checks.push(
      makeCheck(
        "replacement-refs",
        "fail",
        "Git replacement refs could not be verified.",
      ),
    );
  }

  try {
    const legacyGrafts = await hasLegacyGrafts(repositoryRoot);
    checks.push(
      makeCheck(
        "legacy-grafts",
        legacyGrafts ? "fail" : "pass",
        legacyGrafts
          ? "Legacy Git grafts are present."
          : "No legacy Git grafts are present.",
      ),
    );
  } catch {
    checks.push(
      makeCheck(
        "legacy-grafts",
        "fail",
        "Legacy Git grafts could not be verified.",
      ),
    );
  }

  try {
    const matches = await localIdentityMatches(repositoryRoot, policy);
    checks.push(
      makeCheck(
        "local-identity",
        matches ? "pass" : "fail",
        matches
          ? "Repository-local commit identity is protected."
          : "Repository-local commit identity is not protected.",
      ),
    );
  } catch {
    checks.push(
      makeCheck(
        "local-identity",
        "fail",
        "Repository-local commit identity could not be verified.",
      ),
    );
  }

  try {
    const remoteUrl = await gitText(repositoryRoot, [
      "remote",
      "get-url",
      "origin",
    ]);
    const matches =
      normalizeRepositoryUrl(remoteUrl) ===
      policy.canonicalRepository.toLowerCase();
    checks.push(
      makeCheck(
        "canonical-remote",
        matches ? "pass" : "fail",
        matches
          ? "Canonical repository remote is configured."
          : "Canonical repository remote is not configured.",
      ),
    );
  } catch {
    checks.push(
      makeCheck(
        "canonical-remote",
        "fail",
        "Canonical repository remote could not be verified.",
      ),
    );
  }

  try {
    refs = await enumerateRetainedRefs(repositoryRoot);
    commits = await enumerateCommits(repositoryRoot, refs);
    checks.push(
      makeCheck(
        "retained-refs",
        "pass",
        `${refs.length} retained Git refs and ${commits.length} commits were enumerated.`,
      ),
    );
  } catch {
    checks.push(
      makeCheck(
        "retained-refs",
        "fail",
        "Retained Git refs could not be enumerated.",
      ),
    );
  }

  try {
    const isAncestor = await gitPredicate(repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      selectedMainRef,
      selectedCandidateRef,
    ]);
    checks.push(
      makeCheck(
        "branch-ancestry",
        isAncestor ? "pass" : "fail",
        isAncestor
          ? "Main is an ancestor of the candidate."
          : "Main is not an ancestor of the candidate.",
      ),
    );
  } catch {
    checks.push(
      makeCheck(
        "branch-ancestry",
        "fail",
        "Branch ancestry could not be verified.",
      ),
    );
  }

  if (refs.length > 0) {
    try {
      const connected = await retainedRefsShareHistory(
        repositoryRoot,
        selectedMainRef,
        refs,
      );
      checks.push(
        makeCheck(
          "ref-topology",
          connected ? "pass" : "fail",
          connected
            ? "Every retained ref shares the approved history."
            : "A retained ref has disconnected history.",
        ),
      );
    } catch {
      checks.push(
        makeCheck(
          "ref-topology",
          "fail",
          "Retained ref topology could not be verified.",
        ),
      );
    }
  } else {
    checks.push(
      makeCheck(
        "ref-topology",
        "fail",
        "Retained ref topology could not be verified.",
      ),
    );
  }

  if (refs.length > 0) {
    try {
      const identityResult = await inspectIdentities(
        repositoryRoot,
        refs,
        policy,
      );
      protectedIdentityCommits = identityResult.protectedIdentityCommits;
      checks.push(
        makeCheck(
          "identity-policy",
          identityResult.valid ? "pass" : "fail",
          identityResult.valid
            ? `${protectedIdentityCommits} commits use an approved protected identity.`
            : "Reachable history contains an unapproved commit identity.",
        ),
      );
    } catch {
      checks.push(
        makeCheck(
          "identity-policy",
          "fail",
          "Commit identities could not be verified.",
        ),
      );
    }
  } else {
    checks.push(
      makeCheck(
        "identity-policy",
        "fail",
        "Commit identities could not be verified.",
      ),
    );
  }

  if (refs.length > 0 && privateNeedles.length > 0) {
    try {
      const objectIds = await enumerateReachableObjects(repositoryRoot, refs);
      const matchedIndexes = await scanReachableObjects(
        repositoryRoot,
        objectIds,
        privateNeedles,
      );
      const matchedPathIndexes = await scanReachablePaths(
        repositoryRoot,
        commits,
        privateNeedles,
      );
      for (const index of matchedPathIndexes) {
        matchedIndexes.add(index);
      }
      const refText = refs.join("\n");
      privateNeedles.forEach((needle, index) => {
        if (refText.includes(needle)) {
          matchedIndexes.add(index);
        }
      });
      matchedPrivateNeedles = matchedIndexes.size;
      checks.push(
        makeCheck(
          "private-needles",
          matchedPrivateNeedles === 0 ? "pass" : "fail",
          matchedPrivateNeedles === 0
            ? "No private needles were found in retained history."
            : `${matchedPrivateNeedles} private needles were found in retained history.`,
        ),
      );
    } catch {
      checks.push(
        makeCheck(
          "private-needles",
          "fail",
          "Private history values could not be verified.",
        ),
      );
    }
  } else {
    checks.push(
      makeCheck(
        "private-needles",
        refs.length > 0 ? "pass" : "fail",
        refs.length > 0
          ? "No private needles were configured."
          : "Private history values could not be verified.",
      ),
    );
  }

  if (includeSourceArtifacts) {
    checks.push(
      ...(await sourceArtifactChecks(repositoryRoot, selectedCandidateRef)),
    );
  }

  checks.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: REPORT_SCHEMA,
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    checks,
    counts: {
      refs: refs.length,
      commits: commits.length,
      protectedIdentityCommits,
      privateNeedles: matchedPrivateNeedles,
      ...(includeSourceArtifacts
        ? {
            sourceArtifacts: Object.values(BETA_SOURCE_ARTIFACTS).reduce(
              (count, paths) => count + paths.length,
              0,
            ),
          }
        : {}),
    },
  };
}

function parseArguments(argv) {
  const options = { json: false, includeSourceArtifacts: true };
  const valueFlags = new Map([
    ["--repository-root", "repositoryRoot"],
    ["--policy", "policyPath"],
    ["--private-needles", "privateNeedlesPath"],
    ["--private-needles-file", "privateNeedlesPath"],
    ["--main-ref", "mainRef"],
    ["--candidate-ref", "candidateRef"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--skip-source-artifacts") {
      options.includeSourceArtifacts = false;
      continue;
    }
    const key = valueFlags.get(argument);
    const value = argv[index + 1];
    if (!key || value === undefined || value.startsWith("--")) {
      throw new InvocationError("Invalid invocation.");
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function printHuman(report) {
  process.stdout.write(
    `Public beta preflight: ${report.status.toUpperCase()}\n`,
  );
  for (const check of report.checks) {
    process.stdout.write(`- ${check.status.toUpperCase()} ${check.summary}\n`);
  }
}

async function main() {
  let options;
  const wantsJson = process.argv.slice(2).includes("--json");
  try {
    options = parseArguments(process.argv.slice(2));
    const repositoryRoot = path.resolve(
      options.repositoryRoot ?? process.cwd(),
    );
    const policyPath = path.resolve(
      repositoryRoot,
      options.policyPath ?? ".github/public-beta-policy.json",
    );
    const defaultNeedlesPath = path.resolve(
      repositoryRoot,
      ".private/public-beta-needles.txt",
    );
    const configuredNeedlesPath =
      options.privateNeedlesPath ?? process.env.STALEDOCS_PRIVATE_NEEDLES_FILE;
    const privateNeedlesPath = configuredNeedlesPath
      ? path.resolve(configuredNeedlesPath)
      : existsSync(defaultNeedlesPath)
        ? defaultNeedlesPath
        : undefined;
    const report = await runPreflight({
      repositoryRoot,
      policyPath,
      privateNeedlesPath,
      mainRef: options.mainRef,
      candidateRef: options.candidateRef,
      includeSourceArtifacts: options.includeSourceArtifacts,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      printHuman(report);
    }
    process.exitCode = report.status === "pass" ? 0 : 1;
  } catch {
    if (wantsJson) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: REPORT_SCHEMA,
          status: "error",
          error: "Public beta preflight invocation is invalid.",
        })}\n`,
      );
    } else {
      process.stderr.write("Public beta preflight invocation is invalid.\n");
    }
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
