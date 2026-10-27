import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseArgs,
  validateManifest,
  deriveOutcome,
  renderMarkdown,
  readComparisonEvidence,
  assertNoLabelRegression,
} from "../../scripts/evaluate-external.mjs";

const CURRENT_PACKAGE = `staledocs@${
  JSON.parse(await readFile(path.resolve("package.json"), "utf8")).version
}`;
const target = {
  repo: "owner/library",
  language: "typescript",
  pr: 1,
  base: "a".repeat(40),
  head: "b".repeat(40),
  expected: {
    label: "DOCS-STALE",
    reason: "Public signature changed without updating its guide.",
  },
};
function result(overrides = {}) {
  return {
    ...target,
    package: CURRENT_PACKAGE,
    status: "OK",
    publicApiChanges: 1,
    staleDocuments: 1,
    coChangedDocuments: 0,
    breaking: 0,
    unmappedSymbols: 0,
    unsupported: 0,
    firstChanges: [],
    staleDetails: [],
    pullRequest: {
      title: "Public API change",
      html_url: "https://github.com/owner/library/pull/1",
    },
    ...overrides,
  };
}

test("selects exact published packages and rejects aliases, paths, and repeated options", () => {
  const args = parseArgs([
    "manifest.json",
    "--package",
    "staledocs@0.3.0-beta.1",
    "--evidence",
    "private",
    "--out",
    "old.md",
  ]);
  assert.equal(args.packageSpec, "staledocs@0.3.0-beta.1");
  assert.equal(args.evidencePath, "private");
  for (const spec of [
    "staledocs@latest",
    "../staledocs",
    "other@0.4.0-beta.1",
  ]) {
    assert.throws(() =>
      parseArgs(["m.json", "--out", "o.md", "--package", spec]),
    );
  }
  assert.throws(() => parseArgs(["m.json", "--out", "a", "--out", "b"]));
});

test("accepts two PRs from a repository but rejects duplicate identities and unexpected label keys", () => {
  const second = { ...target, pr: 2, head: "c".repeat(40) };
  assert.deepEqual(
    validateManifest({ version: 1, targets: [second, target] }).map(
      (x) => x.pr,
    ),
    [1, 2],
  );
  assert.throws(() =>
    validateManifest({ version: 1, targets: [target, target] }),
  );
  for (const expected of [
    null,
    { label: "OTHER", reason: "Reason" },
    { label: "INTERNAL" },
    { ...target.expected, match: true },
    { ...target.expected, document: "../guide.md" },
  ]) {
    assert.throws(() =>
      validateManifest({ version: 1, targets: [{ ...target, expected }] }),
    );
  }
});

test("derives outcomes using public then stale then co-changed precedence", () => {
  assert.deepEqual(
    deriveOutcome(result({ publicApiChanges: 0, coChangedDocuments: 2 })),
    { observed: "NO-PUBLIC-CHANGE", match: false },
  );
  assert.deepEqual(deriveOutcome(result({ coChangedDocuments: 2 })), {
    observed: "DOCS-STALE",
    match: true,
  });
  assert.equal(
    deriveOutcome(result({ staleDocuments: 0, coChangedDocuments: 2 }))
      .observed,
    "DOCS-UPDATED",
  );
  assert.equal(
    deriveOutcome(result({ staleDocuments: 0 })).observed,
    "UNDOCUMENTED",
  );
  assert.deepEqual(deriveOutcome(result({ status: "ERROR" })), {
    observed: "ERROR",
    match: false,
  });
});

test("requires internal evidence in the new version but marks legacy internal observations n/a", () => {
  const expected = { label: "INTERNAL", reason: "Helper is not exported." };
  const internal = result({
    expected,
    publicApiChanges: 0,
    staleDocuments: 0,
    internalChanges: 1,
  });
  assert.equal(deriveOutcome(internal).match, true);
  assert.equal(deriveOutcome({ ...internal, internalChanges: 0 }).match, false);
  assert.equal(
    deriveOutcome({ ...internal, internalChanges: undefined }).match,
    false,
  );
  assert.deepEqual(
    deriveOutcome({
      ...internal,
      package: "staledocs@0.3.0-beta.1",
      internalChanges: undefined,
    }),
    { observed: "n/a", match: true },
  );
});

test("renders sorted comparison matches independently of timings or cached observed outcomes", () => {
  const first = result({
    observed: "UNDOCUMENTED",
    match: false,
    elapsedMs: 12,
  });
  const second = result({
    pr: 2,
    head: "c".repeat(40),
    publicApiChanges: 0,
    pullRequest: {
      title: "Second API change",
      html_url: "https://github.com/owner/library/pull/2",
    },
  });
  const old = [
    result({ package: "staledocs@0.3.0-beta.1", staleDocuments: 0 }),
    { ...second, package: "staledocs@0.3.0-beta.1" },
  ];
  const output = renderMarkdown([second, first], "staledocs@0.4.0-beta.1", old);
  assert.equal(
    output,
    renderMarkdown(
      [{ ...first, elapsedMs: 9000 }, second],
      "staledocs@0.4.0-beta.1",
      [...old].reverse(),
    ),
  );
  assert.match(
    output,
    /\| Expected \| staledocs@0\.3\.0-beta\.1 \| staledocs@0\.4\.0-beta\.1 \| Match \|/u,
  );
  assert.match(output, /Matched expectation: old 0\/2, new 1\/2/u);
  assert.ok(output.indexOf("pull/1)") < output.indexOf("pull/2)"));
});

test("stops a label-class regression even when another class improves", () => {
  const stale = result();
  const control = result({
    pr: 2,
    expected: { label: "NO-PUBLIC-CHANGE", reason: "Control" },
  });
  assert.throws(
    () =>
      assertNoLabelRegression(
        [stale, control],
        [
          { ...stale, staleDocuments: 0 },
          { ...control, publicApiChanges: 0 },
        ],
      ),
    /DOCS-STALE/u,
  );
});

test("rejects old evidence for a different SHA, package, or an oversized metadata file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "staledocs-compare-test-"));
  const dir = path.join(root, "owner-library-pr-1");
  const second = { ...target, pr: 2, head: "c".repeat(40) };
  const secondDir = path.join(root, "owner-library-pr-2");
  try {
    await mkdir(dir);
    await mkdir(secondDir);
    const old = result({ package: "staledocs@0.3.0-beta.1" });
    await writeFile(path.join(dir, "metadata.json"), JSON.stringify(old));
    await writeFile(
      path.join(secondDir, "metadata.json"),
      JSON.stringify({ ...old, pr: 2, head: second.head }),
    );
    assert.deepEqual(
      (await readComparisonEvidence(root, [target, second])).map(
        (entry) => entry.package,
      ),
      ["staledocs@0.3.0-beta.1", "staledocs@0.3.0-beta.1"],
    );
    await writeFile(
      path.join(secondDir, "metadata.json"),
      JSON.stringify({
        ...old,
        pr: 2,
        head: second.head,
        package: "staledocs@0.2.0-beta.6",
      }),
    );
    await assert.rejects(
      readComparisonEvidence(root, [target, second]),
      /immutable target and package/u,
    );
    await writeFile(
      path.join(dir, "metadata.json"),
      JSON.stringify({ ...old, package: CURRENT_PACKAGE }),
    );
    await assert.rejects(
      readComparisonEvidence(root, [target]),
      /immutable target and package/u,
    );
    await writeFile(
      path.join(dir, "metadata.json"),
      JSON.stringify({ ...old, head: "c".repeat(40) }),
    );
    await assert.rejects(
      readComparisonEvidence(root, [target]),
      /immutable target/u,
    );
    await writeFile(
      path.join(dir, "metadata.json"),
      Buffer.alloc(1_048_577, 32),
    );
    await assert.rejects(readComparisonEvidence(root, [target]), /oversized/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not expose absolute paths or credentials in public report details", () => {
  const credential = "ghp_" + "S".repeat(32);
  const output = renderMarkdown(
    [
      result({
        firstChanges: ["/Users/private/project/api.ts"],
        staleDetails: ["/private/tmp/project/README.md > " + credential],
        pullRequest: {
          title: "/home/private/source " + credential,
          html_url: "https://github.com/owner/library/pull/1",
        },
      }),
    ],
    "staledocs@0.4.0-beta.1",
  );
  assert.equal(output.includes("/Users/"), false);
  assert.equal(output.includes("/private/tmp/"), false);
  assert.equal(output.includes("/home/private/"), false);
  assert.equal(output.includes(credential), false);
});

test("uses the selected old package identity for public INTERNAL observations", () => {
  const output = renderMarkdown(
    [
      result({
        package: undefined,
        expected: { label: "INTERNAL", reason: "Private helper" },
        publicApiChanges: 0,
        staleDocuments: 0,
      }),
    ],
    "staledocs@0.3.0-beta.1",
  );
  assert.match(output, /\| INTERNAL \| n\/a \| yes \|/u);
  assert.match(output, /Matched expectation: staledocs@0\.3\.0-beta\.1 1\/1/u);
});
