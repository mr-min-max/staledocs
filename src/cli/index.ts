#!/usr/bin/env node
import { Command } from "commander";
import { readmeCommand } from "./commands/readme";
import { apiCommand } from "./commands/api";
import { annotateCommand } from "./commands/annotate";
import { changelogCommand } from "./commands/changelog";
import { diagramCommand } from "./commands/diagram";
import { updateCommand } from "./commands/update";
import { scoreCommand } from "./commands/score";
import { watchCommand } from "./commands/watch";
import { checkCommand } from "./commands/check";
import { planCommand } from "./commands/plan";
import { reviewCommand } from "./commands/review";
import { auditCommand } from "./commands/audit";
import { executeDefaultCommand } from "./commands/default";
import { setLogLevel } from "../core/logger";
import { readPackageVersion } from "../core/package-meta";
import {
  getSafeErrorDiagnostic,
  getTrustErrorExitCode,
} from "../security/diagnostics";

const program = new Command();

program
  .name("staledocs")
  .description(
    "AST-first documentation creation and change-aware updates for codebases.",
  )
  .version(readPackageVersion())
  .option("--verbose", "Enable verbose debug logging")
  .option(
    "--mcp",
    "Start as MCP (Model Context Protocol) server for AI assistant integration",
  )
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) {
      setLogLevel("debug");
    }
  });

program.action(async () => {
  process.exitCode = await executeDefaultCommand();
});

program.addCommand(readmeCommand);
program.addCommand(apiCommand);
program.addCommand(annotateCommand);
program.addCommand(changelogCommand);
program.addCommand(diagramCommand);
program.addCommand(updateCommand);
program.addCommand(scoreCommand);
program.addCommand(watchCommand);
program.addCommand(checkCommand);
program.addCommand(planCommand);
program.addCommand(reviewCommand);
program.addCommand(auditCommand);

// Handle --mcp flag before parsing commands
const args = process.argv.slice(2);
if (args.includes("--mcp")) {
  import("../mcp/server").then(({ startMCPServer }) => {
    startMCPServer().catch((error: unknown) => {
      console.error(getSafeErrorDiagnostic(error).message);
      process.exitCode = getTrustErrorExitCode(error);
    });
  });
} else {
  program.parseAsync().catch((error: unknown) => {
    console.error(getSafeErrorDiagnostic(error).message);
    process.exitCode = getTrustErrorExitCode(error);
  });
}
