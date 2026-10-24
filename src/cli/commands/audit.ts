import { Command } from "commander";
import { auditRepository, type AuditReport } from "../../core/audit";
import { toPlanError } from "../../impact/canonical";
import { renderAuditText, serializeAuditReport } from "../../output/audit";

export interface AuditCommandOptions {
  json?: boolean;
  failOn?: string;
  path?: string[];
}

export interface AuditCommandIO {
  stdout(value: string): void;
  stderr(value: string): void;
}

const processIO: AuditCommandIO = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

/** Runs the repository audit; exit 1 only with `--fail-on findings`, 2 on failure. */
export async function executeAuditCommand(
  options: AuditCommandOptions,
  io: AuditCommandIO = processIO,
  cwd = process.cwd(),
): Promise<0 | 1 | 2> {
  if (options.failOn !== undefined && options.failOn !== "findings") {
    io.stderr("Invalid audit options: fail-on supports only findings.\n");
    return 2;
  }

  let report: AuditReport;
  try {
    report = await auditRepository({ cwd, paths: options.path });
  } catch (error: unknown) {
    const planError = toPlanError(error);
    io.stderr(`${planError.code}: ${planError.message}\n`);
    return 2;
  }

  io.stdout(
    `${options.json ? serializeAuditReport(report) : renderAuditText(report)}\n`,
  );
  return options.failOn === "findings" && report.summary.findings > 0 ? 1 : 0;
}

export const auditCommand = new Command("audit")
  .description(
    "Find Markdown references to scripts, paths, and class members that no longer exist",
  )
  .option("--json", "Print the versioned JSON report")
  .option("--fail-on <condition>", "Exit 1 on findings")
  .option(
    "--path <file...>",
    "Audit only these repository-relative Markdown files",
  )
  .action(async (options: AuditCommandOptions) => {
    process.exitCode = await executeAuditCommand(options);
  });
