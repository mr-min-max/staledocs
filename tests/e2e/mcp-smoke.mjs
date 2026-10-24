import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getConfiguredSmokeTarball } from "./smoke-tarball.mjs";
import { snapshotRepositoryTree } from "../../scripts/hybrid-beta-snapshot.mjs";

const PACK_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 120_000;
const MCP_OPERATION_TIMEOUT_MS = 5_000;
const fakeProviderKey = ["sk", "proj", "M".repeat(32)].join("-");
const fakeConfigKey = ["sk", "proj", "C".repeat(32)].join("-");
const rawSentinel = "STALEDOCS_MCP_RAW_SOURCE_MUST_NOT_LEAK";
const externalSentinel = "STALEDOCS_EXTERNAL_REPOSITORY_SENTINEL_MUST_NOT_LEAK";
const root = mkdtempSync(join(tmpdir(), "staledocs-mcp-smoke-"));
let originalGitConfig;

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

function runFixtureGit(repository, hooks, ...args) {
  return execFileSync(
    "git",
    ["-c", "commit.gpgSign=false", "-c", `core.hooksPath=${hooks}`, ...args],
    {
      cwd: repository,
      encoding: "utf8",
      env: { ...credentialFreeEnv(), GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function commitFixture(repository, hooks, message) {
  runFixtureGit(repository, hooks, "add", ".");
  runFixtureGit(repository, hooks, "commit", "-m", message);
  return runFixtureGit(repository, hooks, "rev-parse", "HEAD");
}

async function assertRepositoriesUnchanged(
  repositoryA,
  repositoryB,
  snapshotA,
  snapshotB,
) {
  assert.equal(await snapshotRepositoryTree(repositoryA), snapshotA);
  assert.equal(await snapshotRepositoryTree(repositoryB), snapshotB);
}

function assertResponseValueFree(serialized, forbiddenValues, label) {
  for (const forbidden of forbiddenValues) {
    assert.equal(serialized.includes(forbidden), false, label);
  }
}

async function callText(client, name, arguments_, label) {
  const result = await withTimeout(
    client.callTool({ name, arguments: arguments_ }),
    label,
  );
  const text = result.content?.find((item) => item.type === "text");
  assert.ok(text && "text" in text, label);
  return { result, text: text.text };
}

async function runProviderFreeRoundTrip(
  cliPath,
  fixture,
  externalRepository,
  base,
  head,
  label,
  expectedVersion,
) {
  const localClient = new Client({ name: `staledocs-${label}`, version: "1.0.0" });
  const localTransport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--mcp"],
    cwd: fixture,
    env: credentialFreeEnv(),
  });
  try {
    await withTimeout(
      localClient.connect(localTransport),
      `${label} initialization`,
    );
    assert.equal(localClient.getServerVersion()?.version, expectedVersion);
    const before = await snapshotRepositoryTree(fixture);
    const externalBefore = await snapshotRepositoryTree(externalRepository);
    const listed = await withTimeout(
      localClient.listTools(),
      `${label} tools/list`,
    );
    assert.ok(
      listed.tools.some((tool) => tool.name === "prepare_documentation_update"),
    );
    assert.ok(
      listed.tools.some((tool) => tool.name === "validate_documentation_draft"),
    );

    const preparationResult = await withTimeout(
      localClient.callTool({
        name: "prepare_documentation_update",
        arguments: { base, head },
      }),
      `${label} prepare_documentation_update`,
    );
    assert.notEqual(preparationResult.isError, true);
    const preparationText = preparationResult.content.find(
      (item) => item.type === "text",
    );
    assert.ok(preparationText && "text" in preparationText);
    const preparation = JSON.parse(preparationText.text);
    assert.equal(preparation.schema_version, "aidoc.mcp-update-preparation.v1");
    assert.equal(preparation.target, "README.md");
    assert.match(preparation.preparation_digest, /^v1\./u);
    assert.equal(preparation.generation.prompt.includes(rawSentinel), false);
    await assertRepositoriesUnchanged(
      fixture,
      externalRepository,
      before,
      externalBefore,
    );

    const candidate = "# MCP fixture\n\nUpdated by the host.\n";
    const validationResult = await withTimeout(
      localClient.callTool({
        name: "validate_documentation_draft",
        arguments: {
          preparation_digest: preparation.preparation_digest,
          target: preparation.target,
          candidate_markdown: candidate,
        },
      }),
      `${label} validate_documentation_draft`,
    );
    assert.notEqual(validationResult.isError, true);
    const validationText = validationResult.content.find(
      (item) => item.type === "text",
    );
    assert.ok(validationText && "text" in validationText);
    const validation = JSON.parse(validationText.text);
    assert.equal(validation.schema_version, "aidoc.mcp-draft-validation.v1");
    assert.equal(validation.valid, true);
    assert.equal(validation.approved_markdown, candidate);
    await assertRepositoriesUnchanged(
      fixture,
      externalRepository,
      before,
      externalBefore,
    );

    const tampered = preparation.preparation_digest.endsWith("A")
      ? `${preparation.preparation_digest.slice(0, -1)}B`
      : `${preparation.preparation_digest.slice(0, -1)}A`;
    const tamperedResult = await withTimeout(
      localClient.callTool({
        name: "validate_documentation_draft",
        arguments: {
          preparation_digest: tampered,
          target: preparation.target,
          candidate_markdown: candidate,
        },
      }),
      `${label} tampered validation`,
    );
    assert.equal(tamperedResult.isError, true);
    const tamperedText = tamperedResult.content.find(
      (item) => item.type === "text",
    );
    assert.ok(tamperedText && "text" in tamperedText);
    assert.match(tamperedText.text, /^MCP_INVALID_PREPARATION:/u);
    await assertRepositoriesUnchanged(
      fixture,
      externalRepository,
      before,
      externalBefore,
    );
  } finally {
    await localClient.close().catch(() => {});
    await localTransport.close().catch(() => {});
  }
}

async function runRepositoryIsolationRoundTrip(
  cliPath,
  repositoryA,
  repositoryB,
  base,
  head,
  label,
  expectedVersion,
) {
  const localClient = new Client({ name: `staledocs-${label}`, version: "1.0.0" });
  const localTransport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--mcp"],
    cwd: repositoryA,
    env: credentialFreeEnv(),
  });
  const forbiddenValues = Array.from(
    new Set([
      repositoryA,
      repositoryB,
      realpathSync(repositoryA),
      realpathSync(repositoryB),
      externalSentinel,
      rawSentinel,
    ]),
  );
  let executableConfigPath;
  let executableMarkerPath;

  try {
    await withTimeout(
      localClient.connect(localTransport),
      `${label} initialization`,
    );
    assert.equal(localClient.getServerVersion()?.version, expectedVersion);
    const beforeA = await snapshotRepositoryTree(repositoryA);
    const beforeB = await snapshotRepositoryTree(repositoryB);

    const listed = await withTimeout(
      localClient.listTools(),
      `${label} tools/list`,
    );
    assert.ok(listed.tools.some((tool) => tool.name === "analyze_codebase"));
    assert.ok(
      listed.tools.some((tool) => tool.name === "prepare_documentation_update"),
    );
    assert.ok(
      listed.tools.some((tool) => tool.name === "plan_documentation_impact"),
    );
    const freshnessTool = listed.tools.find(
      (tool) => tool.name === "check_docs_freshness",
    );
    assert.ok(freshnessTool);
    assert.match(freshnessTool.description ?? "", /directly mention changed symbols/iu);

    const audit = await callText(
      localClient,
      "audit_documentation",
      {},
      `${label} audit`,
    );
    assert.notEqual(audit.result.isError, true);
    const auditReport = JSON.parse(audit.text);
    assert.deepEqual(audit.result.structuredContent, auditReport);
    assert.equal(auditReport.schema_version, "aidoc.audit.v1");
    assert.deepEqual(auditReport.summary.byKind, {
      "member-missing": 0,
      "path-missing": 0,
      "script-missing": 0,
    });
    assertResponseValueFree(audit.text, forbiddenValues, `${label} audit`);
    await assertRepositoriesUnchanged(repositoryA, repositoryB, beforeA, beforeB);

    for (const directory of [".", "src"]) {
      const { result, text } = await callText(
        localClient,
        "analyze_codebase",
        { directory, include: "**/*.ts", exclude: "" },
        `${label} analyze ${directory}`,
      );
      assert.notEqual(result.isError, true);
      const payload = JSON.parse(text);
      assert.ok(payload.totalModules >= 1);
      assert.deepEqual(
        payload.modules.map((module) => module.filePath),
        ["src/index.ts"],
      );
      assert.ok(
        payload.modules.every(
          (module) =>
            typeof module.filePath === "string" &&
            !module.filePath.startsWith("/") &&
            !module.filePath.includes("\\") &&
            module.filePath === module.filePath.replace(/^\.\//u, ""),
        ),
      );
      assertResponseValueFree(
        text,
        forbiddenValues,
        `${label} analyze ${directory}`,
      );
      await assertRepositoriesUnchanged(
        repositoryA,
        repositoryB,
        beforeA,
        beforeB,
      );
    }

    for (const [directory, deniedLabel] of [
      [repositoryB, "absolute external repository"],
      ["linked-external", "in-repository external symlink"],
    ]) {
      const { result, text } = await callText(
        localClient,
        "analyze_codebase",
        { directory, include: "**/*.ts", exclude: "" },
        `${label} ${deniedLabel}`,
      );
      assert.equal(result.isError, true);
      assert.match(text, /^MCP_DIRECTORY_DENIED:/u);
      assert.equal((text.match(/MCP_DIRECTORY_DENIED:/gu) ?? []).length, 1);
      assertResponseValueFree(text, forbiddenValues, `${label} ${deniedLabel}`);
      await assertRepositoriesUnchanged(
        repositoryA,
        repositoryB,
        beforeA,
        beforeB,
      );
    }

    const cliPlanOutput = execFileSync(
      process.execPath,
      [cliPath, "plan", "--base", base, "--head", head, "--json"],
      {
        cwd: repositoryA,
        encoding: "utf8",
        env: credentialFreeEnv(),
      },
    );
    const cliPlanResult = JSON.parse(cliPlanOutput);
    assert.equal(cliPlanResult.ok, true);
    assert.equal(
      cliPlanResult.plan.changes.filter(
        (change) => change.category === "contract-changed",
      ).length,
      1,
    );
    assert.equal(
      cliPlanResult.plan.changes.filter(
        (change) => change.category === "implementation-changed",
      ).length,
      1,
    );
    assertResponseValueFree(
      cliPlanOutput,
      forbiddenValues,
      `${label} CLI plan`,
    );

    const impact = await callText(
      localClient,
      "plan_documentation_impact",
      { base, head },
      `${label} plan_documentation_impact`,
    );
    assert.notEqual(impact.result.isError, true);
    assert.deepEqual(JSON.parse(impact.text), cliPlanResult.plan);
    assertResponseValueFree(
      impact.text,
      forbiddenValues,
      `${label} impact plan`,
    );
    await assertRepositoriesUnchanged(
      repositoryA,
      repositoryB,
      beforeA,
      beforeB,
    );

    const freshness = await callText(
      localClient,
      "check_docs_freshness",
      { directory: ".", doc_file: "README.md", since: base },
      `${label} check_docs_freshness`,
    );
    assert.notEqual(freshness.result.isError, true);
    assert.equal(JSON.parse(freshness.text).status, "stale");
    assertResponseValueFree(
      freshness.text,
      forbiddenValues,
      `${label} freshness`,
    );
    await assertRepositoriesUnchanged(
      repositoryA,
      repositoryB,
      beforeA,
      beforeB,
    );

    const unknown = await callText(
      localClient,
      `unknown-${fakeProviderKey}`,
      {},
      `${label} sanitized error`,
    );
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.text, /<STALEDOCS_REDACTED:OPENAI_API_KEY:1>/u);
    assertResponseValueFree(
      unknown.text,
      forbiddenValues,
      `${label} sanitized error`,
    );
    assert.equal(unknown.text.includes(fakeProviderKey), false);
    await assertRepositoriesUnchanged(
      repositoryA,
      repositoryB,
      beforeA,
      beforeB,
    );

    executableConfigPath = join(repositoryA, ".staledocsrc.cjs");
    executableMarkerPath = join(
      repositoryA,
      `.mcp-executable-config-marker-${label}`,
    );
    const executableSourceMarker =
      "STALEDOCS_EXECUTABLE_CONFIG_SOURCE_MUST_NOT_LEAK";
    writeFileSync(
      executableConfigPath,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(executableMarkerPath)}, ${JSON.stringify(executableSourceMarker)});`,
        `module.exports = { apiKey: ${JSON.stringify(fakeConfigKey)} };`,
        "",
      ].join("\n"),
    );
    const beforeExecutable = await snapshotRepositoryTree(repositoryA);
    const beforeExecutableB = await snapshotRepositoryTree(repositoryB);
    const executableResult = await callText(
      localClient,
      "generate_readme",
      { directory: "." },
      `${label} executable MCP config`,
    );
    assert.equal(executableResult.result.isError, true);
    assert.equal(
      executableResult.text,
      "MCP_UNSAFE_CONFIGURATION: The MCP project configuration cannot be loaded safely.",
    );
    assert.equal(existsSync(executableMarkerPath), false);
    assertResponseValueFree(
      executableResult.text,
      [
        ...forbiddenValues,
        fakeConfigKey,
        executableSourceMarker,
        executableConfigPath,
        executableMarkerPath,
      ],
      `${label} executable MCP config`,
    );
    await assertRepositoriesUnchanged(
      repositoryA,
      repositoryB,
      beforeExecutable,
      beforeExecutableB,
    );
  } finally {
    if (executableConfigPath) rmSync(executableConfigPath, { force: true });
    if (executableMarkerPath) rmSync(executableMarkerPath, { force: true });
    await localClient.close().catch(() => {});
    await localTransport.close().catch(() => {});
  }
}

function terminateProcessTree(child) {
  if (!child.pid) return;

  if (process.platform === "win32") {
    const taskkill = spawn(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    taskkill.unref();
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The process may have exited between the timeout and this cleanup.
  }

  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process was already terminated.
    }
  }, 1_000).unref();
}

async function runCommand(command, args, options = {}) {
  const { cwd, timeout } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeout);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (timedOut) {
        reject(
          new Error(
            `${command} ${args.join(" ")} timed out after ${timeout}ms${errors ? `: ${errors}` : ""}`,
          ),
        );
      } else if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code ?? signal}${errors ? `: ${errors}` : ""}`,
          ),
        );
      } else {
        resolve(output);
      }
    });
  });
}

async function withTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${label} timed out after ${MCP_OPERATION_TIMEOUT_MS}ms`,
              ),
            ),
          MCP_OPERATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  let tarball = getConfiguredSmokeTarball();
  if (tarball === null) {
    const packOutput = await runCommand(
      "npm",
      ["pack", "--json", "--pack-destination", root],
      { cwd: resolve("."), timeout: PACK_TIMEOUT_MS },
    );
    const [{ filename }] = JSON.parse(packOutput);
    tarball = join(root, filename);
  }

  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "staledocs-mcp-consumer", private: true }),
  );
  await runCommand("npm", ["install", "--ignore-scripts", tarball], {
    cwd: consumer,
    timeout: INSTALL_TIMEOUT_MS,
  });

  const repositoryA = join(root, "repository-a");
  const repositoryB = join(root, "repository-b");
  const emptyGitTemplate = join(root, "empty-git-template");
  const hooks = join(emptyGitTemplate, "hooks");
  const hostileHooks = join(root, "hostile-hooks");
  const hostileGitConfig = join(root, "hostile.gitconfig");
  mkdirSync(hooks, { recursive: true });
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
  mkdirSync(repositoryA, { recursive: true });
  mkdirSync(repositoryB, { recursive: true });
  runFixtureGit(repositoryA, hooks, "init", "--quiet", "--initial-branch=main");
  runFixtureGit(repositoryB, hooks, "init", "--quiet", "--initial-branch=main");
  for (const repository of [repositoryA, repositoryB]) {
    runFixtureGit(repository, hooks, "config", "user.name", "staledocs test");
    runFixtureGit(
      repository,
      hooks,
      "config",
      "user.email",
      "staledocs-test@example.invalid",
    );
  }

  writeFileSync(
    join(repositoryB, "external-sentinel.ts"),
    [
      `export function ${externalSentinel}(): string {`,
      '  return "external-only";',
      "}",
      "",
    ].join("\n"),
  );
  commitFixture(repositoryB, hooks, "external fixture: sentinel");

  mkdirSync(join(repositoryA, "src"), { recursive: true });
  writeFileSync(join(repositoryA, "README.md"), "# MCP fixture\n\n## API\n\n`api` is public.\n");
  writeFileSync(
    join(repositoryA, "src", "index.ts"),
    [
      "export function api(value: number): number {",
      `  return value + 1; // ${rawSentinel}`,
      "}",
      "export function helper(value: number): number {",
      "  return value * 2;",
      "}",
      "",
    ].join("\n"),
  );
  symlinkSync(repositoryB, join(repositoryA, "linked-external"));
  const base = commitFixture(repositoryA, hooks, "fixture: baseline");
  writeFileSync(
    join(repositoryA, "src", "index.ts"),
    [
      "export function api(value: number, scale = 1): number {",
      `  return value + scale; // ${rawSentinel}`,
      "}",
      "export function helper(value: number): number {",
      "  return value * 3;",
      "}",
      "",
    ].join("\n"),
  );
  const head = commitFixture(repositoryA, hooks, "fixture: source change");

  originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = hostileGitConfig;

  const packedCli = join(
    consumer,
    "node_modules",
    "staledocs",
    "dist",
    "cli",
    "index.js",
  );
  const packedPackage = JSON.parse(
    readFileSync(
      join(consumer, "node_modules", "staledocs", "package.json"),
      "utf8",
    ),
  );
  assert.equal(packedPackage.name, "staledocs");
  await runRepositoryIsolationRoundTrip(
    resolve("dist/cli/index.js"),
    repositoryA,
    repositoryB,
    base,
    head,
    "built-mcp",
    packedPackage.version,
  );
  await runRepositoryIsolationRoundTrip(
    packedCli,
    repositoryA,
    repositoryB,
    base,
    head,
    "packed-mcp",
    packedPackage.version,
  );
  await runProviderFreeRoundTrip(
    resolve("dist/cli/index.js"),
    repositoryA,
    repositoryB,
    base,
    head,
    "built-provider-free-mcp",
    packedPackage.version,
  );
  await runProviderFreeRoundTrip(
    packedCli,
    repositoryA,
    repositoryB,
    base,
    head,
    "packed-provider-free-mcp",
    packedPackage.version,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  if (originalGitConfig === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
  }
}
