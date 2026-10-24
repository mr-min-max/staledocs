import type { AuditFindingKind, AuditReport } from "../core/audit";
import { canonicalStringify } from "../impact/canonical";

const KIND_ORDER: readonly AuditFindingKind[] = [
  "script-missing",
  "path-missing",
  "member-missing",
];

/** Serializes an audit report as canonical JSON with sorted object keys. */
export function serializeAuditReport(report: AuditReport): string {
  return canonicalStringify(report);
}

/** Renders one line per finding, grouped by file, followed by a summary line. */
export function renderAuditText(report: AuditReport): string {
  const lines: string[] = [];
  let previousFile: string | undefined;
  for (const finding of report.findings) {
    if (previousFile !== undefined && finding.file !== previousFile) {
      lines.push("");
    }
    previousFile = finding.file;
    lines.push(
      `${finding.file} > ${finding.section}: ${finding.kind} ${JSON.stringify(
        finding.value,
      )}${
        finding.closest === undefined
          ? ""
          : ` (closest: ${finding.closest})`
      }`,
    );
  }
  if (lines.length > 0) lines.push("");

  const files = `${report.summary.files} Markdown file${
    report.summary.files === 1 ? "" : "s"
  }`;
  if (report.summary.findings === 0) {
    lines.push(`No findings across ${files}.`);
  } else {
    const kinds = KIND_ORDER.map(
      (kind) => `${kind} ${report.summary.byKind[kind]}`,
    ).join(", ");
    lines.push(
      `${report.summary.findings} finding${
        report.summary.findings === 1 ? "" : "s"
      } across ${files}: ${kinds}.`,
    );
  }
  if (report.summary.truncated === true) {
    lines.push(`Showing the first ${report.findings.length} findings.`);
  }
  if (report.ignored?.treeLimitReached === true) {
    lines.push(
      "Path rules skipped: the repository tree exceeds the listing bound.",
    );
  }
  if (report.ignored?.documentationLimitReached === true) {
    lines.push("Documentation discovery stopped at its file limit.");
  }
  if (report.ignored?.boundaryLimitReached === true) {
    lines.push(
      "Member rule skipped: the public entry walk exceeded its file or depth bound.",
    );
  }
  return lines.join("\n");
}
