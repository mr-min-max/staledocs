import { Command } from "commander";
import { buildReviewReport } from "../../core/review";
import { toPlanError } from "../../impact/canonical";
import {
  renderReviewMarkdown,
  renderReviewText,
  serializeReviewReport,
  type ReviewReport,
} from "../../output/review";

export type ReviewFormat = "text" | "markdown" | "json";
export type ReviewFailOn = "none" | "stale" | "breaking";

export interface ReviewCommandOptions {
  base?: string;
  head?: string;
  format?: ReviewFormat;
  failOn?: ReviewFailOn;
  maxSymbols?: string | number;
}

export interface ReviewCommandIO {
  stdout(value: string): void;
  stderr(value: string): void;
}

const processIO: ReviewCommandIO = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

/** Builds the review report for CLI options in the given working directory. */
export function createReviewReport(
  options: ReviewCommandOptions = {},
  cwd = process.cwd(),
): Promise<ReviewReport> {
  return buildReviewReport({ base: options.base, head: options.head }, cwd);
}

/** Executes review output and applies the opt-in fail-on policy. */
export async function executeReviewCommand(
  options: ReviewCommandOptions,
  io: ReviewCommandIO = processIO,
  cwd = process.cwd(),
): Promise<0 | 1 | 2> {
  const format = options.format ?? "text";
  const failOn = options.failOn ?? "none";
  if (!isReviewFormat(format) || !isReviewFailOn(failOn)) {
    io.stderr("Invalid review options: format or fail-on is not supported.\n");
    return 2;
  }

  let report: ReviewReport;
  try {
    report = await createReviewReport(options, cwd);
  } catch (error: unknown) {
    const planError = toPlanError(error);
    io.stderr(`${planError.code}: ${planError.message}\n`);
    return 2;
  }

  const maxSymbols = parseMaxSymbols(options.maxSymbols);
  const output =
    format === "json"
      ? serializeReviewReport(report)
      : format === "markdown"
        ? renderReviewMarkdown(report, maxSymbols)
        : renderReviewText(report, maxSymbols);
  io.stdout(`${output}\n`);
  if (failOn === "breaking" && report.verdict === "breaking") return 1;
  if (
    failOn === "stale" &&
    (report.verdict === "stale" || report.verdict === "breaking")
  )
    return 1;
  return 0;
}

export const reviewCommand = new Command("review")
  .description("Review pull-request documentation impact")
  .option("--base <ref>", "Comparison base")
  .option("--head <ref>", "Comparison head")
  .option("--format <format>", "Output format: text, markdown, or json", "text")
  .option("--fail-on <verdict>", "Fail on none, stale, or breaking", "none")
  .option(
    "--max-symbols <count>",
    "Maximum symbols in text or Markdown output",
    "30",
  )
  .action(async (options: ReviewCommandOptions) => {
    process.exitCode = await executeReviewCommand(options);
  });

function parseMaxSymbols(value: string | number | undefined): number {
  if (value === undefined) return 30;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 30;
}

function isReviewFormat(value: unknown): value is ReviewFormat {
  return value === "text" || value === "markdown" || value === "json";
}

function isReviewFailOn(value: unknown): value is ReviewFailOn {
  return value === "none" || value === "stale" || value === "breaking";
}
