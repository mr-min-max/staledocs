#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promisify } from "node:util";
import { snapshotRepositoryTree } from "./hybrid-beta-snapshot.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(repositoryRoot, "dist", "cli", "index.js");
const DEMO_SCHEMA = "staledocs.hybrid-beta-demo.v1";
// This demo is offline, credential-free, and makes no network request.
const FAKE_SECRET = ["sk", "proj", "M".repeat(32)].join("-");
const CHECK_NAMES = [
  "no_impact_plan_has_no_next_action",
  "one_target_auto_selected_in_mock_dry_run",
  "multiple_targets_require_selection",
  "all_targets_require_explicit_behavior",
  "mcp_prepare_validate_approved",
  "mcp_prepare_validate_did_not_write",
  "prompt_contains_signatures",
  "forged_preparation_blocked",
  "secret_candidate_redacted_or_blocked",
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

async function git(cwd, args) {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...credentialFreeEnv(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

async function commit(cwd, message) {
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "--quiet", "-m", message]);
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

async function createFixture({ documents, noImpact = false }) {
  const cwd = await mkdtemp(path.join(tmpdir(), "staledocs-hybrid-beta-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await git(cwd, ["init", "--quiet", "--initial-branch=main"]);
  await git(cwd, ["config", "user.name", "staledocs hybrid demo"]);
  await git(cwd, ["config", "user.email", "staledocs-demo@example.invalid"]);
  await writeFile(
    path.join(cwd, "src", "index.ts"),
    [
      "export function createUser(email: string): { email: string; role: string } {",
      '  return { email, role: "member" };',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  for (const document of documents) {
    await mkdir(path.dirname(path.join(cwd, document)), { recursive: true });
    await writeFile(
      path.join(cwd, document),
      [
        "# Hybrid fixture",
        "",
        "## API",
        "",
        "Use `createUser(email)` from the source module.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  const base = await commit(cwd, "fixture: baseline");

  if (noImpact) {
    await writeFile(path.join(cwd, "notes.txt"), "No API impact.\n", "utf8");
  } else {
    await writeFile(
      path.join(cwd, "src", "index.ts"),
      [
        "export function createUser(",
        "  email: string,",
        "  role: string,",
        "): { email: string; role: string } {",
        "  return { email, role };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  const head = await commit(
    cwd,
    noImpact ? "fixture: unrelated note" : "fixture: API change",
  );
  return { cwd, base, head };
}

async function runCli(cwd, args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      env: credentialFreeEnv(),
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : "",
    };
  }
}

function parseToolText(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP text result missing");
  return JSON.parse(text);
}

async function runMcpEvidence(fixture) {
  const client = new Client({
    name: "staledocs-hybrid-beta-demo",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--mcp"],
    cwd: fixture.cwd,
    env: credentialFreeEnv(),
  });
  try {
    await client.connect(transport);
    const targets = ["README.md", "docs/API.md"];
    const preparations = [];
    const noWriteChecks = [];
    for (const target of targets) {
      const beforePrepare = await snapshotRepositoryTree(fixture.cwd);
      const preparationResult = await client.callTool({
        name: "prepare_documentation_update",
        arguments: {
          base: fixture.base,
          head: fixture.head,
          target,
        },
      });
      const afterPrepare = await snapshotRepositoryTree(fixture.cwd);
      const unchangedAfterPrepare = beforePrepare === afterPrepare;
      noWriteChecks.push(unchangedAfterPrepare);
      if (preparationResult.isError === true)
        throw new Error("MCP preparation failed");
      if (!unchangedAfterPrepare) {
        throw new Error("MCP preparation wrote the repository");
      }
      const preparation = parseToolText(preparationResult);
      if (
        preparation.schema_version !== "aidoc.mcp-update-preparation.v1" ||
        preparation.target !== target ||
        typeof preparation.preparation_digest !== "string" ||
        typeof preparation.generation?.system_prompt !== "string" ||
        typeof preparation.generation?.prompt !== "string"
      ) {
        throw new Error("MCP preparation shape failed");
      }
      preparations.push(preparation);
      if (
        !preparation.generation.prompt.includes("createUser(email: string)") ||
        !preparation.generation.prompt.includes(
          "createUser(email: string, role: string)",
        )
      ) {
        throw new Error("MCP prompt signatures missing");
      }
    }

    const candidate = [
      "# Hybrid fixture",
      "",
      "## API",
      "",
      "Use `createUser(email, role)` from the source module.",
      "",
    ].join("\n");
    const approvedTargets = [];
    for (const preparation of preparations) {
      const beforeValidation = await snapshotRepositoryTree(fixture.cwd);
      const validationResult = await client.callTool({
        name: "validate_documentation_draft",
        arguments: {
          preparation_digest: preparation.preparation_digest,
          target: preparation.target,
          candidate_markdown: candidate,
        },
      });
      const afterValidation = await snapshotRepositoryTree(fixture.cwd);
      noWriteChecks.push(beforeValidation === afterValidation);
      if (validationResult.isError === true)
        throw new Error("MCP validation failed");
      const validation = parseToolText(validationResult);
      approvedTargets.push(
        validation.valid === true &&
          validation.approved_markdown === candidate &&
          validation.approved_markdown.includes("createUser(email, role)") &&
          !validation.approved_markdown.includes(
            ["Validated by", "the host"].join(" "),
          ),
      );
    }

    const firstPreparation = preparations[0];
    const tamperedDigest = firstPreparation.preparation_digest.endsWith("A")
      ? `${firstPreparation.preparation_digest.slice(0, -1)}B`
      : `${firstPreparation.preparation_digest.slice(0, -1)}A`;
    const beforeForged = await snapshotRepositoryTree(fixture.cwd);
    const forgedResult = await client.callTool({
      name: "validate_documentation_draft",
      arguments: {
        preparation_digest: tamperedDigest,
        target: firstPreparation.target,
        candidate_markdown: candidate,
      },
    });
    const forgedText = forgedResult.content?.find(
      (item) => item.type === "text",
    )?.text;
    const forgedBlocked =
      forgedResult.isError === true &&
      typeof forgedText === "string" &&
      forgedText.startsWith("MCP_INVALID_PREPARATION:");
    const unchangedAfterForged =
      (await snapshotRepositoryTree(fixture.cwd)) === beforeForged;
    noWriteChecks.push(unchangedAfterForged);

    const beforeSecret = await snapshotRepositoryTree(fixture.cwd);
    const secretResult = await client.callTool({
      name: "validate_documentation_draft",
      arguments: {
        preparation_digest: firstPreparation.preparation_digest,
        target: firstPreparation.target,
        candidate_markdown: `# Hybrid fixture\n\nContact: ${FAKE_SECRET}\n`,
      },
    });
    const secretValidation =
      secretResult.isError === true ? undefined : parseToolText(secretResult);
    const secretSafe =
      secretResult.isError === true ||
      (typeof secretValidation?.approved_markdown === "string" &&
        !secretValidation.approved_markdown.includes(FAKE_SECRET)) ||
      ["redacted", "blocked"].includes(secretValidation?.trust?.action);
    const unchangedAfterSecret =
      (await snapshotRepositoryTree(fixture.cwd)) === beforeSecret;
    noWriteChecks.push(unchangedAfterSecret);

    const beforeFreshness = await snapshotRepositoryTree(fixture.cwd);
    const freshnessResult = await client.callTool({
      name: "check_docs_freshness",
      arguments: {
        directory: ".",
        doc_file: "README.md",
        since: fixture.base,
      },
    });
    if (freshnessResult.isError === true)
      throw new Error("MCP freshness check failed");
    const unchangedAfterFreshness =
      (await snapshotRepositoryTree(fixture.cwd)) === beforeFreshness;
    noWriteChecks.push(unchangedAfterFreshness);

    return {
      approved:
        preparations.length === targets.length &&
        targets.every(
          (target, index) => preparations[index]?.target === target,
        ) &&
        approvedTargets.length === targets.length &&
        approvedTargets.every(Boolean),
      noWrite: noWriteChecks.every(Boolean),
      forgedBlocked,
      secretSafe,
    };
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

function emptyChecks() {
  return Object.fromEntries(CHECK_NAMES.map((name) => [name, false]));
}

function parseArguments(args = process.argv.slice(2)) {
  if (args.length === 0) return { presentation: false };
  if (args.length === 1 && args[0] === "--presentation") {
    return { presentation: true };
  }
  throw new Error("Expected no arguments or --presentation");
}

function formatPresentation(report) {
  if (report.status !== "pass") return "StaleDocs storefront demo\nResult: FAIL\n";
  return [
    "StaleDocs storefront demo",
    "Change: createUser(email) -> createUser(email, role)",
    "Impact: README.md, docs/API.md",
    "Host contract: prepare -> host draft -> validate",
    "Provider calls: none",
    "Repository writes: none",
    "Prompt: before/after signatures included",
    "Result: PASS",
    "",
  ].join("\n");
}

async function runDemo() {
  const noImpactFixture = await createFixture({
    documents: ["README.md"],
    noImpact: true,
  });
  const singleTargetFixture = await createFixture({
    documents: ["README.md"],
  });
  const multipleTargetFixture = await createFixture({
    documents: ["README.md", "docs/API.md"],
  });

  try {
    const noImpact = await runCli(noImpactFixture.cwd, [
      "plan",
      "--base",
      noImpactFixture.base,
      "--head",
      noImpactFixture.head,
    ]);
    const noImpactCheck =
      noImpact.code === 0 && !noImpact.stdout.includes("Next: staledocs update");

    const singleBefore = await snapshotRepositoryTree(singleTargetFixture.cwd);
    const singleTarget = await runCli(singleTargetFixture.cwd, [
      "update",
      "--base",
      singleTargetFixture.base,
      "--mock",
      "--dry-run",
    ]);
    const singleAfter = await snapshotRepositoryTree(singleTargetFixture.cwd);
    const singleCheck =
      singleTarget.code === 0 &&
      singleTarget.stdout.includes("Target: README.md") &&
      singleBefore === singleAfter;

    const multiplePlan = await runCli(multipleTargetFixture.cwd, [
      "plan",
      "--base",
      multipleTargetFixture.base,
      "--head",
      multipleTargetFixture.head,
    ]);
    const multiplePlanCheck =
      multiplePlan.code === 0 &&
      multiplePlan.stdout.includes("README.md") &&
      multiplePlan.stdout.includes("docs/API.md");

    const multipleBefore = await snapshotRepositoryTree(
      multipleTargetFixture.cwd,
    );
    const multiple = await runCli(multipleTargetFixture.cwd, [
      "update",
      "--base",
      multipleTargetFixture.base,
      "--mock",
      "--dry-run",
    ]);
    const multipleMessage = `${multiple.stdout}\n${multiple.stderr}`;
    const multipleCheck =
      multiplePlanCheck &&
      multiple.code !== 0 &&
      multipleMessage.includes("Multiple documentation targets") &&
      (await snapshotRepositoryTree(multipleTargetFixture.cwd)) ===
        multipleBefore;

    const allBefore = await snapshotRepositoryTree(multipleTargetFixture.cwd);
    const all = await runCli(multipleTargetFixture.cwd, [
      "update",
      "--base",
      multipleTargetFixture.base,
      "--mock",
      "--dry-run",
      "--all",
    ]);
    const allAfter = await snapshotRepositoryTree(multipleTargetFixture.cwd);
    const allMessage = `${all.stdout}\n${all.stderr}`;
    const allCheck =
      all.code === 0 &&
      allMessage.includes(
        "Update progress: 2 of 2 selected targets processed.",
      ) &&
      allBefore === allAfter &&
      allMessage.includes("Generated README.md") &&
      allMessage.includes("Generated docs/API.md");

    const mcp = await runMcpEvidence(multipleTargetFixture);

    const checks = {
      no_impact_plan_has_no_next_action: noImpactCheck,
      one_target_auto_selected_in_mock_dry_run: singleCheck,
      multiple_targets_require_selection: multipleCheck,
      all_targets_require_explicit_behavior: allCheck,
      mcp_prepare_validate_approved: mcp.approved,
      mcp_prepare_validate_did_not_write: mcp.noWrite,
      prompt_contains_signatures: true,
      forged_preparation_blocked: mcp.forgedBlocked,
      secret_candidate_redacted_or_blocked: mcp.secretSafe,
    };
    return {
      schema_version: DEMO_SCHEMA,
      status: Object.values(checks).every(Boolean) ? "pass" : "fail",
      checks,
      tools: [
        "prepare_documentation_update",
        "validate_documentation_draft",
        "check_docs_freshness",
      ],
      providers: ["none"],
      fixtures: [
        "no-impact",
        "single-target",
        "multiple-targets",
        "provider-free-mcp",
      ],
      counts: {
        affected_targets: 2,
        secret_findings: 1,
      },
    };
  } finally {
    await Promise.all([
      rm(noImpactFixture.cwd, { recursive: true, force: true }),
      rm(singleTargetFixture.cwd, { recursive: true, force: true }),
      rm(multipleTargetFixture.cwd, { recursive: true, force: true }),
    ]);
  }
}

let presentation = false;
try {
  presentation = parseArguments().presentation;
  const report = await runDemo();
  process.stdout.write(
    presentation ? formatPresentation(report) : `${JSON.stringify(report)}\n`,
  );
  process.exitCode = report.status === "pass" ? 0 : 1;
} catch {
  const report = {
    schema_version: DEMO_SCHEMA,
    status: "fail",
    checks: emptyChecks(),
    tools: [],
    providers: ["none"],
    fixtures: [
      "no-impact",
      "single-target",
      "multiple-targets",
      "provider-free-mcp",
    ],
    counts: { affected_targets: 0, secret_findings: 0 },
  };
  process.stdout.write(
    presentation ? formatPresentation(report) : `${JSON.stringify(report)}\n`,
  );
  process.exitCode = 1;
}
