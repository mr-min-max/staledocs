#!/usr/bin/env node
/**
 * Reproducible Codex fix-path check for the StaleDocs MCP workflow.
 *
 * For every fixture and run, this script builds a temporary Git repository in
 * which a documented public API changed on a branch, runs `codex exec` once
 * against this checkout's built MCP server (`dist/cli/index.js --mcp`), or
 * against a published package (`npx --yes staledocs@<version> --mcp`) with
 * `--package`, and
 * records whether the first `validate_documentation_draft` call succeeded,
 * whether the validated Markdown mentions the change, and whether the fixture
 * was modified. The evidence directory receives one JSON record and the raw
 * JSONL stream per run plus `summary.json`; stdout receives per-run counts,
 * byte lengths, and a Markdown table, never Markdown bodies or paths.
 *
 *   npm run build
 *   node scripts/codex-fix-path.mjs --runs 3 --evidence <dir> \
 *     [--fixture ts-function|ts-method|py-init|all] [--model <id>] [--codex <path>] \
 *     [--package staledocs@<version>]
 *
 * The fixture precondition (`review` reports the document as stale) always
 * uses this checkout's build; `--package` changes only the server Codex calls.
 *
 * Every run spends the signed-in Codex account's usage. The script never reads
 * or copies credentials: Codex uses its own login from CODEX_HOME, and
 * OPENAI_API_KEY and CODEX_API_KEY are removed from its environment so a run
 * cannot fall back to API billing. `--ignore-user-config` keeps the user's
 * config.toml out; the StaleDocs server is configured only through `-c`
 * overrides, whose values are TOML (the `args` override is a TOML array).
 * `codex exec` runs with approval policy `never`, which rejects MCP calls that
 * need approval, so the overrides approve exactly the two workflow tools,
 * `prepare_documentation_update` and `validate_documentation_draft`; neither
 * writes files, and every other StaleDocs tool keeps the default policy.
 * It does not run under `npm test` or in CI.
 *
 * Bounds: `--runs` is 1 to 10 per fixture; each run times out after 10
 * minutes; each run's captured stdout and stderr are capped at 4 MB combined.
 * Exit status: 0 when no run modified its fixture, 1 when any run did, 2 on a
 * usage or setup error.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import analysis from "./codex-fix-path/analysis.cjs";

const {
  deriveRunResult,
  firstModel,
  parseJsonLines,
  readFixture,
  renderSummaryTable,
  summarizeRuns,
} = analysis;

const MAX_RUNS = 10;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const STDERR_TAIL_BYTES = 4096;
const FIXED_GIT_DATE = "2026-01-01T00:00:00Z";
const APPROVED_TOOLS = [
  "prepare_documentation_update",
  "validate_documentation_draft",
];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessDirectory = join(repositoryRoot, "scripts", "codex-fix-path");
const cliPath = join(repositoryRoot, "dist", "cli", "index.js");

class UsageError extends Error {}

let activeChild;
let interrupted = false;

function parseArguments(argv) {
  const options = { runs: 3, fixture: "all", codex: "codex" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value.`);
    }
    index += 1;
    if (flag === "--runs") options.runs = Number(value);
    else if (flag === "--evidence") options.evidence = resolve(value);
    else if (flag === "--fixture") options.fixture = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--codex") options.codex = value;
    else if (flag === "--package") options.package = value;
    else throw new UsageError(`Unknown option ${flag}.`);
  }
  if (
    !Number.isInteger(options.runs) ||
    options.runs < 1 ||
    options.runs > MAX_RUNS
  ) {
    throw new UsageError(`--runs must be an integer from 1 to ${MAX_RUNS}.`);
  }
  if (options.evidence === undefined) {
    throw new UsageError("--evidence <dir> is required.");
  }
  if (
    options.model !== undefined &&
    !/^[A-Za-z0-9._:-]+$/u.test(options.model)
  ) {
    throw new UsageError("--model must be a plain model id.");
  }
  if (
    options.package !== undefined &&
    !/^staledocs@[0-9A-Za-z.+-]+$/u.test(options.package)
  ) {
    throw new UsageError("--package must be staledocs@<version>.");
  }
  return options;
}

function loadFixtures(selection) {
  const directory = join(harnessDirectory, "fixtures");
  const fixtures = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      readFixture(JSON.parse(readFileSync(join(directory, name), "utf8"))),
    );
  if (selection === "all") return fixtures;
  const selected = fixtures.filter((fixture) => fixture.name === selection);
  if (selected.length === 0) {
    throw new UsageError(
      `--fixture must be all or one of: ${fixtures.map((fixture) => fixture.name).join(", ")}.`,
    );
  }
  return selected;
}

function codexEnvironment() {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

function runSync(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_CAPTURE_BYTES,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0]} exited with ${result.status ?? result.signal}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function createFixtureRepository(fixture, root) {
  const repository = join(root, "repository");
  const hooks = join(root, "hooks");
  mkdirSync(repository);
  mkdirSync(hooks);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "StaleDocs fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "StaleDocs fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: FIXED_GIT_DATE,
    GIT_COMMITTER_DATE: FIXED_GIT_DATE,
  };
  const git = (...args) =>
    runSync(
      "git",
      ["-c", "commit.gpgSign=false", "-c", `core.hooksPath=${hooks}`, ...args],
      repository,
      env,
    ).trim();
  const writeFiles = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      writeFileSync(join(repository, path), content);
    }
  };

  git("init", "--quiet", "--initial-branch=main");
  writeFiles(fixture.base);
  git("add", "--all");
  git("commit", "--quiet", "--message", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "-b", "feature");
  writeFiles(fixture.head);
  git("add", "--all");
  git("commit", "--quiet", "--message", "head");
  return { repository, base, head: git("rev-parse", "HEAD") };
}

function assertFixtureIsStale(fixture, repository) {
  const output = runSync(
    process.execPath,
    [cliPath, "review", "--format", "json"],
    repository,
    codexEnvironment(),
  );
  const report = JSON.parse(output);
  const stale = (report.documents ?? []).some(
    (document) =>
      document.path === fixture.expect.staleDocument &&
      document.status === "stale",
  );
  if (!stale) {
    throw new UsageError(
      `Fixture ${fixture.name}: StaleDocs does not report ${fixture.expect.staleDocument} as stale, so Codex was not run.`,
    );
  }
}

function fixtureWrites(repository, head) {
  const writes = runSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    repository,
  )
    .split("\n")
    .filter((line) => line.length > 0);
  const current = runSync("git", ["rev-parse", "HEAD"], repository).trim();
  if (current !== head) writes.push(`HEAD moved to ${current}`);
  return writes;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function serverCommand(options) {
  return options.package === undefined
    ? { command: "node", args: [cliPath, "--mcp"] }
    : { command: "npx", args: ["--yes", options.package, "--mcp"] };
}

function codexArguments(options, repository, finalMessagePath) {
  const server = serverCommand(options);
  return [
    "exec",
    "--json",
    "--ignore-user-config",
    "-s",
    "read-only",
    "-C",
    repository,
    "-c",
    `mcp_servers.staledocs.command=${tomlString(server.command)}`,
    "-c",
    `mcp_servers.staledocs.args=[${server.args.map(tomlString).join(",")}]`,
    "-c",
    "mcp_servers.staledocs.required=true",
    ...APPROVED_TOOLS.flatMap((tool) => [
      "-c",
      `mcp_servers.staledocs.tools.${tool}.approval_mode="approve"`,
    ]),
    ...(options.model === undefined
      ? []
      : ["-c", `model=${tomlString(options.model)}`]),
    "--output-schema",
    join(harnessDirectory, "output.schema.json"),
    "-o",
    finalMessagePath,
    "-",
  ];
}

function terminate(child) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The process group already exited.
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process group already exited.
    }
  }, 2000).unref();
}

function runCodex(options, repository, finalMessagePath, prompt) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      options.codex,
      codexArguments(options, repository, finalMessagePath),
      {
        cwd: repository,
        env: codexEnvironment(),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    activeChild = child;
    const stdout = [];
    const stderr = [];
    let captured = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, RUN_TIMEOUT_MS);
    const capture = (chunks) => (chunk) => {
      if (outputLimitExceeded) return;
      captured += chunk.length;
      if (captured > MAX_CAPTURE_BYTES) {
        outputLimitExceeded = true;
        terminate(child);
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      clearTimeout(timer);
      activeChild = undefined;
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      activeChild = undefined;
      resolvePromise({
        exitCode: code,
        signal,
        timedOut,
        outputLimitExceeded,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(prompt);
  });
}

function codexVersion(codex) {
  try {
    return runSync(
      codex,
      ["--version"],
      repositoryRoot,
      codexEnvironment(),
    ).trim();
  } catch (error) {
    throw new UsageError(
      `Codex CLI did not run (${error.code ?? error.message}); pass --codex <path>.`,
    );
  }
}

function serverVersion(options) {
  // Resolving a published package here also fills the npx cache, so Codex does
  // not spend its server startup time on the download. It runs outside this
  // checkout: inside it, npm treats the root `staledocs` package as the match
  // and finds no `staledocs` bin.
  const server = serverCommand(options);
  try {
    return runSync(
      server.command,
      [...server.args.slice(0, -1), "--version"],
      options.package === undefined ? repositoryRoot : tmpdir(),
      codexEnvironment(),
    ).trim();
  } catch (error) {
    throw new UsageError(
      `StaleDocs server did not run (${error.code ?? error.message}).`,
    );
  }
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

function yesNo(value) {
  return value ? "yes" : "no";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/codex-fix-path.mjs --runs 3 --evidence <dir> [--fixture ts-function|ts-method|py-init|all] [--model <id>] [--codex <path>] [--package staledocs@<version>]\n",
    );
    return 0;
  }
  if (!existsSync(cliPath)) {
    throw new UsageError("dist/cli/index.js is missing; run npm run build first.");
  }
  const fixtures = loadFixtures(options.fixture);
  const version = codexVersion(options.codex);
  const server = `${options.package ?? "checkout"} ${serverVersion(options)}`;
  const prompt = readFileSync(join(harnessDirectory, "prompt.md"), "utf8");
  mkdirSync(options.evidence, { recursive: true });
  const startedAt = new Date();
  const stamp = timestamp(startedAt);
  const runs = [];
  const files = [];

  for (const fixture of fixtures) {
    for (let run = 1; run <= options.runs; run += 1) {
      const root = mkdtempSync(join(tmpdir(), "staledocs-codex-fix-path-"));
      try {
        const { repository, base, head } = createFixtureRepository(
          fixture,
          root,
        );
        assertFixtureIsStale(fixture, repository);
        const finalMessagePath = join(root, "final.json");
        const runStartedAt = new Date();
        const started = process.hrtime.bigint();
        const outcome = await runCodex(
          options,
          repository,
          finalMessagePath,
          prompt,
        );
        const durationSeconds =
          Math.round(Number(process.hrtime.bigint() - started) / 1e8) / 10;
        const { events, malformedLines } = parseJsonLines(outcome.stdout);
        const finalMessage = existsSync(finalMessagePath)
          ? readFileSync(finalMessagePath, "utf8")
          : null;
        const result = deriveRunResult({
          events,
          finalMessage,
          expected: fixture.expect,
          writes: fixtureWrites(repository, head),
        });
        const record = {
          schema: "staledocs.codex-fix-path-run.v1",
          fixture: fixture.name,
          run,
          started_at: runStartedAt.toISOString(),
          duration_seconds: durationSeconds,
          codex_version: version,
          server,
          model: firstModel(events) ?? options.model ?? null,
          exit_code: outcome.exitCode,
          signal: outcome.signal,
          timed_out: outcome.timedOut,
          output_limit_exceeded: outcome.outputLimitExceeded,
          base_commit: base,
          head_commit: head,
          events: events.length,
          malformed_lines: malformedLines,
          ...result,
          final_message: finalMessage,
          stderr_tail: outcome.stderr.slice(-STDERR_TAIL_BYTES),
        };
        const name = `${stamp}-${fixture.name}-${run}`;
        writeFileSync(
          join(options.evidence, `${name}.json`),
          `${JSON.stringify(record, null, 2)}\n`,
        );
        writeFileSync(join(options.evidence, `${name}.jsonl`), outcome.stdout);
        files.push(`${name}.json`);
        runs.push({
          ...result,
          fixture: fixture.name,
          durationSeconds,
          model: record.model,
        });
        process.stdout.write(
          `${fixture.name} run ${run}/${options.runs}: first_validate_ok=${yesNo(result.first_validate_ok)} correct=${yesNo(result.correct)} writes=${result.writes.length} validate_calls=${result.validate_calls} digest_relayed=${yesNo(result.digest_relayed)} validated_markdown=${result.validated_markdown_bytes ?? 0} bytes exit=${outcome.exitCode ?? outcome.signal}${outcome.timedOut ? " timed_out" : ""}${outcome.outputLimitExceeded ? " output_limit" : ""} ${durationSeconds.toFixed(1)}s\n`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      if (interrupted) throw new UsageError("Interrupted; summary not written.");
    }
  }

  const rows = summarizeRuns(runs);
  const models = [...new Set(runs.map((run) => run.model))];
  writeFileSync(
    join(options.evidence, "summary.json"),
    `${JSON.stringify(
      {
        schema: "staledocs.codex-fix-path-summary.v1",
        started_at: startedAt.toISOString(),
        codex_version: version,
        server,
        models,
        runs_per_fixture: options.runs,
        fixtures: rows,
        runs: files,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `\n${version}; server ${server}; model ${models.map((model) => model ?? "not reported").join(", ")}\n\n${renderSummaryTable(rows)}\n\nWrote summary.json and ${files.length} run records to the evidence directory.\n`,
  );
  return runs.some((run) => run.writes.length > 0) ? 1 : 0;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    if (activeChild !== undefined) terminate(activeChild);
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(
      `${error instanceof UsageError ? error.message : (error.stack ?? error)}\n`,
    );
    process.exitCode = interrupted ? 130 : 2;
  },
);
