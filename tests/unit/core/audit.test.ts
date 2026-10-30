import {
  AUDIT_SCHEMA_VERSION,
  assessDocumentationAudit,
  type AuditInput,
} from "../../../src/core/audit";

const TREE = new Set([
  "package.json",
  "README.md",
  "AGENTS.md",
  "config/settings.json",
  "src/index.ts",
  "src/client.ts",
  "docs/guide-v2.md",
  "docs/My Guide.md",
  "docs/assets/a.png",
  "packages/web/package.json",
  "packages/web/README.md",
  "packages/web/src/main.ts",
  "examples/docker/Dockerfile",
]);

function audit(
  docs: Record<string, string>,
  overrides: Partial<AuditInput> = {},
) {
  return assessDocumentationAudit({
    tree: TREE,
    scripts: new Map([[".", ["build", "test"]]]),
    docs: Object.entries(docs).map(([path, content]) => ({ path, content })),
    ...overrides,
  });
}

function compact(docs: Record<string, string>, overrides?: Partial<AuditInput>) {
  return audit(docs, overrides).findings.map(({ file, kind, value, closest }) =>
    closest === undefined ? [file, kind, value] : [file, kind, value, closest],
  );
}

describe("assessDocumentationAudit true positives", () => {
  it("TP1 reports a misspelled npm run script with the closest known name", () => {
    expect(
      audit({ "README.md": "# Lib\n\n## Usage\n\nRun `npm run bulid`.\n" })
        .findings,
    ).toEqual([
      {
        file: "README.md",
        section: "Usage",
        slug: "usage",
        kind: "script-missing",
        value: "npm run bulid",
        closest: "build",
        evidence: "code-span",
      },
    ]);
  });

  it("TP2 maps npm test to the test script", () => {
    expect(
      compact(
        { "README.md": "# Lib\n\nRun `npm test`.\n" },
        { scripts: new Map([[".", ["build"]]]) },
      ),
    ).toEqual([["README.md", "script-missing", "npm test"]]);
  });

  it("TP3 treats a bare pnpm name as a script invocation", () => {
    // Levenshtein("lint:ci", "lint") is 3, above the closest-name bound of 2.
    expect(
      compact(
        { "README.md": "# Lib\n\nRun `pnpm lint:ci`.\n" },
        { scripts: new Map([[".", ["lint"]]]) },
      ),
    ).toEqual([["README.md", "script-missing", "pnpm lint:ci"]]);
  });

  it("TP4 reports a relative link to a missing file", () => {
    expect(
      audit({ "README.md": "# Lib\n\nSee [guide](./docs/guide.md).\n" })
        .findings,
    ).toEqual([
      {
        file: "README.md",
        section: "Lib",
        slug: "lib",
        kind: "path-missing",
        value: "docs/guide.md",
        evidence: "link",
      },
    ]);
  });

  it("TP4 resolves links relative to the document", () => {
    expect(
      compact({ "docs/guide-v2.md": "# Guide\n\nBack to [setup](../SETUP.md).\n" }),
    ).toEqual([["docs/guide-v2.md", "path-missing", "SETUP.md"]]);
  });

  it("TP5 reports a code span repository path absent from the tree", () => {
    expect(
      audit({ "README.md": "# Lib\n\nThe parser lives in `src/core/old.ts`.\n" })
        .findings,
    ).toEqual([
      {
        file: "README.md",
        section: "Lib",
        slug: "lib",
        kind: "path-missing",
        value: "src/core/old.ts",
        evidence: "code-span",
      },
    ]);
  });

  it("TP5 checks extension paths whose first directory exists", () => {
    expect(
      compact({ "README.md": "# Lib\n\nEdit `config/old.json`.\n" }),
    ).toEqual([["README.md", "path-missing", "config/old.json"]]);
  });

  it("TP7 scans fenced blocks in AGENTS.md", () => {
    expect(
      compact({
        "AGENTS.md": [
          "# Agents",
          "",
          "```bash",
          "npm run lint:ci",
          "src/core/old.ts",
          "```",
          "",
        ].join("\n"),
      }),
    ).toEqual([
      ["AGENTS.md", "path-missing", "src/core/old.ts"],
      ["AGENTS.md", "script-missing", "npm run lint:ci"],
    ]);
  });

  it("TP6 reports a member that a closed public class does not declare", () => {
    expect(
      audit(
        { "README.md": "# Lib\n\n## API\n\nCall `Client.fetchAll`.\n" },
        {
          publicSymbols: new Map([
            ["Client", { kind: "class", members: ["fetch"] }],
          ]),
        },
      ).findings,
    ).toEqual([
      {
        file: "README.md",
        section: "API",
        slug: "api",
        kind: "member-missing",
        value: "Client.fetchAll",
        evidence: "code-span",
      },
    ]);
  });

  it("TP7 reports a missing member inside a fenced block in AGENTS.md", () => {
    expect(
      compact(
        { "AGENTS.md": "# Agents\n\n```ts\nOptions.retries\n```\n" },
        {
          publicSymbols: new Map([
            ["Options", { kind: "interface", members: ["timeout"] }],
          ]),
        },
      ),
    ).toEqual([["AGENTS.md", "member-missing", "Options.retries"]]);
  });

  it("checks every document against the scripts of all packages", () => {
    const scripts = new Map<string, readonly string[] | null>([
      [".", ["build"]],
      ["packages/web", ["dev"]],
    ]);
    expect(
      compact(
        {
          "README.md":
            "# Root\n\nIn `packages/web`, run `npm run dev`. Then `npm run serve`.\n",
          "packages/web/README.md":
            "# Web\n\nRun `npm run dev`, `npm run build`, then `npm run serve`.\n",
        },
        { scripts },
      ),
    ).toEqual([
      ["README.md", "script-missing", "npm run serve"],
      ["packages/web/README.md", "script-missing", "npm run serve"],
    ]);
  });

  it("TP11 reports bins under npm run and pnpm run, and bare names nothing declares", () => {
    expect(
      compact(
        {
          "README.md":
            "# Lib\n\n`npm run tsx` `pnpm run vitest` `pnpm jest` `bun run nope`\n",
        },
        { binaries: new Set(["tsx", "vitest"]) },
      ),
    ).toEqual([
      ["README.md", "script-missing", "bun run nope"],
      ["README.md", "script-missing", "npm run tsx", "test"],
      ["README.md", "script-missing", "pnpm jest", "test"],
      ["README.md", "script-missing", "pnpm run vitest", "test"],
    ]);
  });

  it("TP12 reports a path that neither the root nor any package has", () => {
    expect(
      compact(
        { "AGENTS.md": "# Agents\n\n`src/gone.ts` `test/gone.test.ts`\n" },
        {
          tree: new Set([...TREE, "packages/web/test/app.test.ts"]),
          scripts: new Map([
            [".", ["build"]],
            ["packages/web", ["dev"]],
          ]),
          packageRoots: ["src/pkg"],
        },
      ),
    ).toEqual([
      ["AGENTS.md", "path-missing", "src/gone.ts"],
      ["AGENTS.md", "path-missing", "test/gone.test.ts"],
    ]);
  });

  it("TP13 reports extensionless and .html links with no Markdown page", () => {
    expect(
      compact({
        "README.md": "# Lib\n\n[r](./docs/removed) [o](docs/old.html#top)\n",
      }),
    ).toEqual([
      ["README.md", "path-missing", "docs/old.html"],
      ["README.md", "path-missing", "docs/removed"],
    ]);
  });

  it("scans text fences like any other fence", () => {
    expect(
      compact({ "README.md": "# Lib\n\n```text\nnpm run old\n```\n" }),
    ).toEqual([["README.md", "script-missing", "npm run old"]]);
  });

  it("TP8 reports a directory link with a trailing slash that is absent", () => {
    expect(
      compact({
        "README.md": "# Lib\n\nSee [examples](./examples/missing/).\n",
        "docs/guide-v2.md": "# Guide\n\nSee [old](../examples/old/).\n",
      }),
    ).toEqual([
      ["README.md", "path-missing", "examples/missing/"],
      ["docs/guide-v2.md", "path-missing", "examples/old/"],
    ]);
  });

  it("TP9 reports a missing path that carries a line range", () => {
    expect(
      compact({
        "README.md": [
          "# Lib",
          "",
          "`src/core/old.ts:878-898` `src/core/gone.ts#L3-L7`",
          "",
        ].join("\n"),
      }),
    ).toEqual([
      ["README.md", "path-missing", "src/core/gone.ts"],
      ["README.md", "path-missing", "src/core/old.ts"],
    ]);
  });

  it("TP10 still reports a script followed by a placeholder argument", () => {
    expect(
      compact({ "README.md": "# Lib\n\nRun `npm run bulid <target>`.\n" }),
    ).toEqual([["README.md", "script-missing", "npm run bulid", "build"]]);
  });
});

describe("assessDocumentationAudit false positives", () => {
  it("FP1 ignores present scripts and package-manager commands", () => {
    expect(
      compact({
        "README.md": [
          "# Lib",
          "",
          "Run `npm run build`, `npm install`, `npm ci`, `npx jest`, `npm publish`.",
          "Also `npm run`, `npm -v`, `npm --version`, `yarn add left-pad`, `pnpm dlx x`.",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("FP1 ignores npm commands, flags, workspace targets, and bun native commands", () => {
    expect(
      compact(
        {
          "README.md": [
            "# Lib",
            "",
            "`npm uninstall left-pad`, `npm ls`, `npm run-script build`,",
            "`pnpm --filter web build`, `npm run dev -w web`,",
            "`npm run dev --workspace=web`, `yarn workspace web dev`,",
            "`yarn global add x`, `bun test`, `bun build ./src/index.ts`.",
            "",
          ].join("\n"),
        },
        { scripts: new Map([[".", ["lint"]]]) },
      ),
    ).toEqual([]);
  });

  it("FP1 emits no script findings without a readable manifest", () => {
    const docs = { "README.md": "# Lib\n\nRun `npm run build` and `npm test`.\n" };
    expect(compact(docs, { scripts: new Map() })).toEqual([]);
    expect(compact(docs, { scripts: new Map([[".", null]]) })).toEqual([]);
  });

  it("FP2 ignores URLs, fragments, existing directories, and images", () => {
    expect(
      compact({
        "README.md": [
          "# Lib",
          "",
          "[x](https://example.com/docs/x.md) [y](#section) [z](./docs)",
          "[w](mailto:team@example.com) ![](./docs/assets/a.png) ![](./docs/assets/b.png)",
          "[v](docs/guide-v2.md#install) [u](docs/My%20Guide.md)",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("FP2 ignores URL links in documents below the repository root", () => {
    expect(
      compact({
        "docs/guide-v2.md": [
          "# Guide",
          "",
          "[pr](https://github.com/org/repo/pull/1) [mail](mailto:team@example.com)",
          "[ref](HTTPS://example.com/a.md)",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("FP3 ignores build output, home, absolute, glob, and placeholder spans", () => {
    expect(
      compact({
        "README.md": [
          "# Lib",
          "",
          "`dist/cli/index.js` `node_modules/x` `~/.codex/config.toml` `/usr/bin/env`",
          "`src/**/*.ts` `<repo>/docs` `docs/{a,b}.md` `coverage/lcov.info`",
          "`build/out.js` `out/main.js` `.git/config` `$HOME/docs/x.md`",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("FP3 ignores spans that do not name a repository path", () => {
    expect(
      compact({
        "README.md": [
          "# Lib",
          "",
          "`github.com/org/repo/blob/main/README.md` `path/to/file.ts`",
          "`@scope/pkg/index.js` `owner/repo` `https://example.com/a.md`",
          "`src/index.ts:12` `src/client.ts:3:7` `./src/index.ts` `src/`",
          "`node dist/cli/index.js review --base main`",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("FP3 resolves spans in package documents against the package directory", () => {
    expect(
      compact({
        "packages/web/README.md": "# Web\n\nEntry: `src/main.ts`.\n",
      }),
    ).toEqual([]);
  });

  it("FP4 ignores declared members, lowercase receivers, short roots, and unknown roots", () => {
    expect(
      compact(
        {
          "README.md": [
            "# Lib",
            "",
            "`Client.fetch` `client.fetch(url)` `Client.fetch(url)` `Ky.get`",
            "`Foo.bar` `Client.fetchAll()` `Client.fetch.all`",
            "",
          ].join("\n"),
        },
        {
          publicSymbols: new Map([
            ["Client", { kind: "class", members: ["fetch"] }],
            ["Ky", { kind: "class", members: ["post"] }],
          ]),
        },
      ),
    ).toEqual([]);
  });

  it("FP5 skips changelog-style files entirely", () => {
    const stale = [
      "# Changelog",
      "",
      "Run `npm run bulid`, see [guide](./docs/guide.md) and `src/core/old.ts`.",
      "Call `Client.fetchAll`.",
      "",
    ].join("\n");
    expect(
      compact(
        {
          "CHANGELOG.md": stale,
          "docs/HISTORY.md": stale,
          "RELEASES.md": stale,
        },
        {
          publicSymbols: new Map([
            ["Client", { kind: "class", members: ["fetch"] }],
          ]),
        },
      ),
    ).toEqual([]);
  });

  it("FP7 accepts directory links with a trailing slash", () => {
    expect(
      compact({
        "README.md": [
          "# Lib",
          "",
          "[docker](./examples/docker/) [web](packages/web/) [src](src/)",
          "[docker again](examples/docker/#usage)",
          "",
        ].join("\n"),
        "docs/guide-v2.md": "# Guide\n\n[web](../packages/web/src/)\n",
      }),
    ).toEqual([]);
  });

  it("FP8 strips line numbers and ranges from existing paths", () => {
    expect(
      compact({
        "README.md": [
          "# Lib",
          "",
          "`src/client.ts:878-898` `src/client.ts:1-2` `src/index.ts:3:7-3:9`",
          "`src/client.ts#L10` `src/client.ts#L10-L20`",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("FP9 ignores script names that continue into a placeholder", () => {
    expect(
      compact({
        "README.md": [
          "# Lib",
          "",
          "`pnpm server:<folder-name>` `npm run test:{unit,e2e}`",
          "`yarn build:$TARGET` `npm run <script>` `bun run lint:[name]`",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("FP10 accepts local bins and file runs that need no script", () => {
    expect(
      compact(
        {
          "README.md": [
            "# Lib",
            "",
            "`pnpm tsx scripts/x.ts` `pnpm vitest` `yarn eslint .` `yarn run eslint .`",
            "`bun vitest` `bun run vitest` `pnpm changeset` `pnpm tsc --noEmit`",
            "`bun run server.ts` `bun bench.mts` `bun ./scripts/x.js` `bun src/cli.ts`",
            "",
          ].join("\n"),
        },
        { binaries: new Set(["changeset", "eslint", "tsc", "tsx", "vitest"]) },
      ),
    ).toEqual([]);
  });

  it("FP11 resolves spans against workspace and Python packages", () => {
    expect(
      compact(
        {
          "AGENTS.md": [
            "# Agents",
            "",
            "`src/main.ts` `test/app.test.ts` `src/` `test/` `lib/_hooks.py`",
            "`widgets/old.ts`",
            "",
          ].join("\n"),
        },
        {
          tree: new Set([
            ...TREE,
            "packages/web/test/app.test.ts",
            "packages/web/widgets/new.ts",
            "src/pkg/__init__.py",
            "src/pkg/lib/_hooks.py",
          ]),
          scripts: new Map([
            [".", ["build"]],
            ["packages/web", ["dev"]],
          ]),
          packageRoots: ["src/pkg"],
        },
      ),
    ).toEqual([]);
  });

  it("FP12 resolves extensionless and .html links to Markdown pages", () => {
    expect(
      compact({
        "README.md": [
          "# Lib",
          "",
          "[g](./docs/guide-v2) [h](docs/guide-v2.html#install) [m](docs/My%20Guide)",
          "",
        ].join("\n"),
        "docs/guide-v2.md": "# Guide\n\n[readme](../README) [self](./guide-v2#top)\n",
      }),
    ).toEqual([]);
  });

  it("FP13 ignores package-manager built-in commands", () => {
    expect(
      compact(
        {
          "README.md": [
            "# Lib",
            "",
            "`pnpm patch left-pad` `pnpm patch-commit ./tmp` `pnpm patch-remove x`",
            "`yarn patch left-pad` `yarn patch-commit -s ./tmp` `bun patch left-pad`",
            "`pnpm import` `pnpm fetch` `pnpm deploy out` `pnpm env use 22`",
            "`pnpm approve-builds` `pnpm licenses list` `pnpm root` `pnpm bin`",
            "`pnpm setup` `pnpm doctor` `pnpm self-update` `pnpm catalog`",
            "`yarn unplug x` `yarn constraints` `yarn explain x` `yarn node x`",
            "`yarn npm publish` `yarn set version stable` `yarn plugin import x`",
            "`yarn search x` `yarn stage` `yarn bin` `bun pm ls` `bun upgrade`",
            "",
          ].join("\n"),
        },
        { scripts: new Map([[".", ["lint"]]]) },
      ),
    ).toEqual([]);
  });

  it("FP6 skips removed lines in diff and patch fences", () => {
    expect(
      compact({
        "README.md": [
          "# Lib",
          "",
          "```diff",
          "-npm run old",
          "-src/core/removed.ts",
          "+src/index.ts",
          "```",
          "",
          "```patch",
          "-src/core/removed.ts",
          "```",
          "",
          "```text",
          "-npm run old",
          "```",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });
});

describe("assessDocumentationAudit report", () => {
  const docs = {
    "README.md": [
      "# Lib",
      "",
      "## Usage",
      "",
      "Run `npm run bulid`, then see [the guide](./docs/guide.md) and `src/core/old.ts`.",
      "",
    ].join("\n"),
    "AGENTS.md": "# Agents\n\n```bash\nnpm run lint:ci\n```\n",
  };

  it("summarizes findings by kind with the versioned schema", () => {
    const report = audit(docs);
    expect(report.schema_version).toBe(AUDIT_SCHEMA_VERSION);
    expect(report.schema_version).toBe("aidoc.audit.v1");
    expect(report.revision).toBe("working-tree");
    expect(report.summary).toEqual({
      findings: 4,
      files: 2,
      byKind: { "member-missing": 0, "path-missing": 2, "script-missing": 2 },
    });
    expect(report.ignored).toBeUndefined();
  });

  it("sorts findings by file, slug, kind, and value", () => {
    expect(
      audit(docs).findings.map(({ file, slug, kind, value }) => [
        file,
        slug,
        kind,
        value,
      ]),
    ).toEqual([
      ["AGENTS.md", "agents", "script-missing", "npm run lint:ci"],
      ["README.md", "usage", "path-missing", "docs/guide.md"],
      ["README.md", "usage", "path-missing", "src/core/old.ts"],
      ["README.md", "usage", "script-missing", "npm run bulid"],
    ]);
  });

  it("returns deep-equal output for the same input regardless of order", () => {
    const first = audit(docs);
    const reversed = assessDocumentationAudit({
      tree: new Set([...TREE].reverse()),
      scripts: new Map([[".", ["test", "build"]]]),
      docs: Object.entries(docs)
        .reverse()
        .map(([path, content]) => ({ path, content })),
    });
    expect(reversed).toEqual(first);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(first));
  });

  it("reports one finding for a repeated reference in a section", () => {
    expect(
      compact({ "README.md": "# Lib\n\n`npm run bulid` and `npm run bulid`.\n" }),
    ).toEqual([["README.md", "script-missing", "npm run bulid", "build"]]);
  });

  it("skips path rules and says so when the tree is unavailable", () => {
    const report = audit(docs, { tree: undefined });
    expect(report.findings.map(({ kind }) => kind)).toEqual([
      "script-missing",
      "script-missing",
    ]);
    expect(report.ignored).toEqual({ treeLimitReached: true });
  });

  it("skips script rules and says so when the manifest listing exceeds its bound", () => {
    const report = audit(docs, { manifestLimitReached: true });
    expect(report.findings.map(({ kind }) => kind)).toEqual([
      "path-missing",
      "path-missing",
    ]);
    expect(report.ignored).toEqual({ manifestLimitReached: true });
  });

  it("carries the documentation and boundary limit flags", () => {
    expect(audit(docs, { documentationLimitReached: true }).ignored).toEqual({
      documentationLimitReached: true,
    });
    expect(audit(docs, { boundaryLimitReached: true }).ignored).toEqual({
      boundaryLimitReached: true,
    });
  });

  it("caps findings at 500 and marks the summary truncated", () => {
    const lines = Array.from(
      { length: 501 },
      (_, index) => `\`src/missing/file-${String(index).padStart(3, "0")}.ts\``,
    );
    const report = audit({ "README.md": `# Lib\n\n${lines.join("\n")}\n` });
    expect(report.findings).toHaveLength(500);
    expect(report.summary.findings).toBe(501);
    expect(report.summary.truncated).toBe(true);
    expect(report.findings[499]?.value).toBe("src/missing/file-499.ts");
  });

  it("counts audited files without changelog files", () => {
    expect(
      audit({
        "README.md": "# Lib\n\nNothing stale.\n",
        "CHANGELOG.md": "# Changelog\n",
      }).summary,
    ).toEqual({
      findings: 0,
      files: 1,
      byKind: { "member-missing": 0, "path-missing": 0, "script-missing": 0 },
    });
  });
});
