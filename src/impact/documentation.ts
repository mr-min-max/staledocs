import { posix as pathPosix } from "node:path";
import { sanitizeDiagnostic } from "../security/scanner";
import { compareChangeKeys } from "./canonical";
import type {
  DocumentationImpact,
  DocumentationReference,
  SymbolChange,
} from "./types";

export interface DocumentationFile {
  path: string;
  content: string;
}

export interface DocumentationSection {
  file: string;
  heading: string;
  slug: string;
  body: string;
}

/** One code span or fenced line; `fence` is the enclosing fence's info-string language. */
export interface DocumentationCodeEvidence {
  text: string;
  fence?: string;
}

/** A section with its sanitized heading, code evidence, and normalized link targets. */
export interface DocumentationEvidenceSection {
  file: string;
  section: string;
  slug: string;
  codeEvidence: DocumentationCodeEvidence[];
  linkTargets: string[];
}

interface ScannedSection extends DocumentationSection {
  codeSpans: string[];
  codeEvidence: DocumentationCodeEvidence[];
  linkTargets: string[];
}

interface MutableSection {
  file: string;
  heading: string;
  slug: string;
  lines: string[];
}

const GENERIC_HEADING_NAMES = new Set(["get", "set", "run", "main", "open"]);
const API_CATEGORIES = new Set([
  "added",
  "exposed",
  "removed",
  "hidden",
  "contract-changed",
]);
const CHANGELOG_BASENAME =
  /^(changelog|changes|history|news|releases?)(\.md)?$/iu;

/** Indexes Markdown headings and their normalized repository-relative evidence. */
export function indexDocumentation(
  files: DocumentationFile[],
): DocumentationSection[] {
  return scanDocumentation(files).map(({ file, heading, slug, body }) => ({
    file,
    heading,
    slug,
    body,
  }));
}

/** Returns whether a documentation path is a changelog-style file. */
export function isChangelogDocument(path: string): boolean {
  return CHANGELOG_BASENAME.test(pathPosix.basename(path));
}

/** Scans Markdown into sections with code spans, fenced lines, and link targets. */
export function scanDocumentationEvidence(
  files: DocumentationFile[],
): DocumentationEvidenceSection[] {
  return scanDocumentation(files).map((section) => {
    const label = sectionLabel(section);
    return {
      file: section.file,
      section: label.section,
      slug: label.slug,
      codeEvidence: section.codeEvidence,
      linkTargets: section.linkTargets,
    };
  });
}

/** Maps symbol changes to direct and recommended documentation sections. */
export function mapDocumentationImpact(
  changes: SymbolChange[],
  files: DocumentationFile[],
): DocumentationImpact[] {
  const sections = scanDocumentation(files);
  const apiSection = selectSection(sections, apiSectionScore);
  const changelogSection = selectSection(sections, changelogSectionScore);
  const rootReadmeSection = selectSection(sections, (section) =>
    pathPosix.basename(section.file).toLowerCase() === "readme.md" &&
    pathPosix.dirname(section.file) === "."
      ? 0
      : undefined,
  );
  const architectureSection = selectSection(sections, architectureSectionScore);

  return [...changes].sort(compareChangeKeys).map((change) => {
    const directReferences: DocumentationReference[] = [];
    const qualifiedName = change.qualifiedName;
    const sourcePath = normalizeRepositoryPath(change.path);
    const readmeSection =
      selectSection(sections, (section) =>
        readmeSectionScore(section, change.path),
      ) ?? rootReadmeSection;

    for (const section of sections) {
      if (CHANGELOG_BASENAME.test(pathPosix.basename(section.file))) continue;
      if (
        qualifiedName !== undefined &&
        section.codeSpans.some((span) => containsExactName(span, qualifiedName))
      ) {
        directReferences.push(toReference(section, "code-span"));
      }
      if (
        sourcePath !== undefined &&
        section.linkTargets.includes(sourcePath)
      ) {
        directReferences.push(toReference(section, "source-link"));
      }
      if (
        qualifiedName !== undefined &&
        isEligibleHeadingName(qualifiedName) &&
        containsExactName(section.heading, qualifiedName)
      ) {
        directReferences.push(toReference(section, "heading"));
      }
    }

    const recommendations: DocumentationReference[] = [];
    if (
      change.scope === "symbol" &&
      API_CATEGORIES.has(change.category) &&
      apiSection !== undefined
    ) {
      recommendations.push(toReference(apiSection, "api-documentation"));
    }
    if (
      change.risk === "potentially-breaking" &&
      changelogSection !== undefined
    ) {
      recommendations.push(toReference(changelogSection, "changelog"));
    }
    if (isEntrypoint(change.path)) {
      const entrypointSection = readmeSection ?? architectureSection;
      if (entrypointSection !== undefined) {
        recommendations.push(toReference(entrypointSection, "entrypoint"));
      }
    }
    if (change.category === "dependency-changed") {
      const dependencySection = readmeSection ?? architectureSection;
      if (dependencySection !== undefined) {
        recommendations.push(toReference(dependencySection, "architecture"));
      }
    }

    const direct = sortAndDeduplicate(directReferences);
    const recommended = sortAndDeduplicate(recommendations);
    return {
      changeId: change.id,
      directReferences: direct,
      recommendations: recommended,
      unmapped: direct.length === 0 && recommended.length === 0,
    };
  });
}

function scanDocumentation(files: DocumentationFile[]): ScannedSection[] {
  const sections: ScannedSection[] = [];
  const normalizedFiles = files
    .map((file) => ({
      path: normalizeRepositoryPath(file.path),
      content: file.content,
    }))
    .filter(
      (file): file is { path: string; content: string } =>
        file.path !== undefined,
    )
    .sort((left, right) => compareStrings(left.path, right.path));

  for (const file of normalizedFiles) {
    for (const section of splitSections(file.path, file.content)) {
      const headingEvidence = scanInlineEvidence(section.file, section.heading);
      const bodyEvidence = scanSectionEvidence(section.file, section.body);
      sections.push({
        ...section,
        codeSpans: [...headingEvidence.codeSpans, ...bodyEvidence.codeSpans],
        codeEvidence: [
          ...headingEvidence.codeEvidence,
          ...bodyEvidence.codeEvidence,
        ],
        linkTargets: [
          ...headingEvidence.linkTargets,
          ...bodyEvidence.linkTargets,
        ],
      });
    }
  }

  return sections.sort(
    (left, right) =>
      compareStrings(left.file, right.file) ||
      compareStrings(left.slug, right.slug) ||
      compareStrings(left.heading, right.heading),
  );
}

function splitSections(file: string, content: string): DocumentationSection[] {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const usedSlugs = new Set<string>();
  const sections: DocumentationSection[] = [];
  let current: MutableSection | undefined;
  let fence: { marker: "`" | "~"; length: number } | undefined;

  const finish = (): void => {
    if (current === undefined) return;
    sections.push({
      file: current.file,
      heading: current.heading,
      slug: current.slug,
      body: current.lines.join("\n").trim(),
    });
  };

  const begin = (heading: string): void => {
    finish();
    const baseSlug = githubSlug(heading);
    let slug = baseSlug;
    let duplicateIndex = 1;
    while (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${duplicateIndex}`;
      duplicateIndex += 1;
    }
    usedSlugs.add(slug);
    current = {
      file,
      heading,
      slug,
      lines: [],
    };
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceBoundary = readFenceBoundary(line);
    if (fence !== undefined) {
      current?.lines.push(line);
      if (
        fenceBoundary !== undefined &&
        fenceBoundary.marker === fence.marker &&
        fenceBoundary.length >= fence.length &&
        fenceBoundary.closing
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fenceBoundary !== undefined) {
      current?.lines.push(line);
      fence = fenceBoundary;
      continue;
    }

    const atxHeading = readAtxHeading(line);
    if (atxHeading !== undefined) {
      begin(atxHeading);
      continue;
    }

    const nextLine = lines[index + 1];
    if (
      line.trim().length > 0 &&
      nextLine !== undefined &&
      /^ {0,3}(?:=+|-+)\s*$/u.test(nextLine)
    ) {
      begin(line.trim());
      index += 1;
      continue;
    }

    current?.lines.push(line);
  }
  finish();
  return sections;
}

function scanSectionEvidence(
  file: string,
  body: string,
): Pick<ScannedSection, "codeSpans" | "codeEvidence" | "linkTargets"> {
  const codeSpans: string[] = [];
  const codeEvidence: DocumentationCodeEvidence[] = [];
  const linkTargets: string[] = [];
  let fence: { marker: "`" | "~"; length: number; language: string } | undefined;

  for (const line of body.split("\n")) {
    const fenceBoundary = readFenceBoundary(line);
    if (fence !== undefined) {
      if (
        fenceBoundary !== undefined &&
        fenceBoundary.marker === fence.marker &&
        fenceBoundary.length >= fence.length &&
        fenceBoundary.closing
      ) {
        fence = undefined;
      } else {
        codeSpans.push(line);
        codeEvidence.push({ text: line, fence: fence.language });
      }
      continue;
    }
    if (fenceBoundary !== undefined) {
      fence = {
        marker: fenceBoundary.marker,
        length: fenceBoundary.length,
        language: fenceBoundary.info.split(/\s/u, 1)[0].toLowerCase(),
      };
      continue;
    }

    const inlineEvidence = scanInlineEvidence(file, line);
    codeSpans.push(...inlineEvidence.codeSpans);
    codeEvidence.push(...inlineEvidence.codeEvidence);
    linkTargets.push(...inlineEvidence.linkTargets);
  }

  return { codeSpans, codeEvidence, linkTargets };
}

function readAtxHeading(line: string): string | undefined {
  const match = /^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/u.exec(line);
  if (match === null) return undefined;
  return match[1].replace(/[ \t]+#+[ \t]*$/u, "").trim();
}

function readFenceBoundary(
  line: string,
):
  | { marker: "`" | "~"; length: number; closing: boolean; info: string }
  | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match === null) return undefined;
  const marker = match[1][0] as "`" | "~";
  const info = match[2].trim();
  return {
    marker,
    length: match[1].length,
    closing: info.length === 0,
    info,
  };
}

function scanInlineEvidence(
  file: string,
  line: string,
): Pick<ScannedSection, "codeSpans" | "codeEvidence" | "linkTargets"> {
  const spans: string[] = [];
  const outsideCode = [...line];
  let cursor = 0;
  while (cursor < line.length) {
    if (line[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let delimiterEnd = cursor + 1;
    while (line[delimiterEnd] === "`") delimiterEnd += 1;
    const delimiterLength = delimiterEnd - cursor;
    const closing = findBacktickRun(line, delimiterEnd, delimiterLength);
    if (closing < 0) break;
    spans.push(line.slice(delimiterEnd, closing));
    const closingEnd = closing + delimiterLength;
    outsideCode.fill(" ", cursor, closingEnd);
    cursor = closingEnd;
  }

  const linkTargets: string[] = [];
  for (const target of readLinkDestinations(outsideCode.join(""))) {
    const normalized = normalizeLinkTarget(file, target);
    if (normalized !== undefined) linkTargets.push(normalized);
  }
  return {
    codeSpans: spans,
    codeEvidence: spans.map((text) => ({ text })),
    linkTargets,
  };
}

function findBacktickRun(
  line: string,
  start: number,
  expectedLength: number,
): number {
  let cursor = start;
  while (cursor < line.length) {
    const opening = line.indexOf("`", cursor);
    if (opening < 0) return -1;
    let end = opening + 1;
    while (line[end] === "`") end += 1;
    if (end - opening === expectedLength) return opening;
    cursor = end;
  }
  return -1;
}

function readLinkDestinations(line: string): string[] {
  const targets: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const opening = line.indexOf("](", cursor);
    if (opening < 0) break;
    const labelOpening = line.lastIndexOf("[", opening);
    if (labelOpening > 0 && line[labelOpening - 1] === "!") {
      cursor = opening + 2;
      continue;
    }
    let index = opening + 2;
    while (line[index] === " " || line[index] === "\t") index += 1;
    if (line[index] === "<") {
      const end = line.indexOf(">", index + 1);
      if (end >= 0) targets.push(line.slice(index + 1, end));
      cursor = end >= 0 ? end + 1 : index + 1;
      continue;
    }

    const start = index;
    let depth = 0;
    let escaped = false;
    while (index < line.length) {
      const character = line[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if ((character === " " || character === "\t") && depth === 0) {
        break;
      }
      index += 1;
    }
    if (index > start) targets.push(line.slice(start, index));
    cursor = Math.max(index + 1, opening + 2);
  }
  return targets;
}

function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, "")
    .replace(/ /gu, "-");
}

function normalizeRepositoryPath(value: string): string | undefined {
  if (value.length === 0 || hasControlCharacter(value)) return undefined;
  const slashPath = value.replace(/\\/gu, "/");
  if (
    slashPath.startsWith("/") ||
    /^[A-Za-z]:\//u.test(slashPath) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(slashPath)
  ) {
    return undefined;
  }
  const normalized = pathPosix.normalize(slashPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeLinkTarget(file: string, target: string): string | undefined {
  const withoutFragment = target.split("#", 1)[0];
  if (withoutFragment.length === 0 || withoutFragment.startsWith("/")) {
    return undefined;
  }
  const resolved = pathPosix.join(pathPosix.dirname(file), withoutFragment);
  return normalizeRepositoryPath(resolved);
}

function containsExactName(text: string, name: string): boolean {
  let offset = text.indexOf(name);
  while (offset >= 0) {
    const before = offset === 0 ? undefined : text[offset - 1];
    const after = text[offset + name.length];
    if (!isNameCharacter(before) && !isNameCharacter(after)) return true;
    offset = text.indexOf(name, offset + 1);
  }
  return false;
}

function isNameCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{M}\p{N}_$.]/u.test(character);
}

function isEligibleHeadingName(name: string): boolean {
  return name.length >= 4 && !GENERIC_HEADING_NAMES.has(name.toLowerCase());
}

function isEntrypoint(path: string): boolean {
  const normalized = normalizeRepositoryPath(path);
  if (normalized === undefined) return false;
  const basename = pathPosix.basename(normalized).toLowerCase();
  return (
    /^(?:index|main)\.[^.]+$/u.test(basename) ||
    (!normalized.includes("/") && /\.(?:[cm]?tsx?|py)$/u.test(basename))
  );
}

function toReference(
  section: DocumentationSection,
  reason: DocumentationReference["reason"],
): DocumentationReference {
  return { file: section.file, ...sectionLabel(section), reason };
}

function sectionLabel(section: DocumentationSection): {
  section: string;
  slug: string;
} {
  const safeHeading = sanitizeDiagnostic(section.heading);
  return {
    section: safeHeading,
    slug:
      safeHeading === section.heading ? section.slug : githubSlug(safeHeading),
  };
}

function sortAndDeduplicate(
  references: DocumentationReference[],
): DocumentationReference[] {
  const byKey = new Map<string, DocumentationReference>();
  for (const reference of references) {
    const key = `${reference.file}#${reference.slug}#${reference.reason}`;
    if (!byKey.has(key)) byKey.set(key, reference);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      compareStrings(left.file, right.file) ||
      compareStrings(left.slug, right.slug) ||
      compareStrings(left.reason, right.reason),
  );
}

function selectSection(
  sections: ScannedSection[],
  score: (section: ScannedSection) => number | undefined,
): ScannedSection | undefined {
  let selected: { section: ScannedSection; score: number } | undefined;
  for (const section of sections) {
    const candidateScore = score(section);
    if (
      candidateScore !== undefined &&
      (selected === undefined || candidateScore < selected.score)
    ) {
      selected = { section, score: candidateScore };
    }
  }
  return selected?.section;
}

function apiSectionScore(section: ScannedSection): number | undefined {
  const basename = pathPosix.basename(section.file).toLowerCase();
  if (basename === "api.md") return 0;
  if (/(?:^|[-_.])api(?:[-_.]|$)/u.test(basename)) return 1;
  return /\bapi\b|application programming interface/iu.test(section.heading)
    ? 2
    : undefined;
}

function changelogSectionScore(section: ScannedSection): number | undefined {
  return CHANGELOG_BASENAME.test(pathPosix.basename(section.file))
    ? 0
    : undefined;
}

function readmeSectionScore(
  section: ScannedSection,
  sourcePath: string,
): number | undefined {
  if (pathPosix.basename(section.file).toLowerCase() !== "readme.md") {
    return undefined;
  }
  const source = normalizeRepositoryPath(sourcePath);
  if (source === undefined) return undefined;
  const directory = pathPosix.dirname(section.file);
  if (directory === ".") return undefined;
  return source.startsWith(`${directory}/`)
    ? -directory.split("/").length
    : undefined;
}

function architectureSectionScore(section: ScannedSection): number | undefined {
  const basename = pathPosix.basename(section.file).toLowerCase();
  if (/architecture/u.test(basename)) return 0;
  return /\b(?:architecture|system design)\b/iu.test(section.heading)
    ? 1
    : undefined;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
