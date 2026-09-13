import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";

const { load } = require("js-yaml") as { load(source: string): unknown };
const root = path.resolve(".");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  files: string[];
};

interface DependabotUpdate {
  "package-ecosystem": string;
  directory: string;
  schedule: Record<string, string>;
  "open-pull-requests-limit": number;
  labels: string[];
  groups?: Record<
    string,
    { "dependency-type": string; "update-types": string[] }
  >;
}

describe("public beta repository configuration", () => {
  it("bounds weekly npm and Actions dependency updates", () => {
    const dependabot = load(
      fs.readFileSync(path.join(root, ".github/dependabot.yml"), "utf8"),
    ) as {
      version: number;
      updates: DependabotUpdate[];
      registries?: unknown;
    };
    expect(dependabot.version).toBe(2);
    expect(dependabot.updates).toHaveLength(2);
    expect(
      dependabot.updates.map((entry) => entry["package-ecosystem"]).sort(),
    ).toEqual(["github-actions", "npm"]);
    expect(
      dependabot.updates.every((entry) => entry.schedule.interval === "weekly"),
    ).toBe(true);
    expect(dependabot.registries).toBeUndefined();
  });

  it("keeps private publication material outside tracked Git", () => {
    const result = spawnSync(
      "git",
      ["check-ignore", "--quiet", ".private/probe"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("keeps candidate and published-version verification explicit", () => {
    const source = fs.readFileSync(
      path.join(root, "scripts/public-beta-preflight.mjs"),
      "utf8",
    );
    const script = packageJson.scripts["test:npm-published"];
    expect(packageJson.version).toBe("0.4.0-beta.1");
    expect(script).toContain("--version 0.4.0-beta.1");
    expect(script).not.toContain("--latest");
    expect(packageJson.scripts["test:storefront"]).toBe(
      "node --test tests/e2e/storefront-demo.test.mjs tests/e2e/storefront-assets.test.mjs",
    );
    expect(source).toContain("const CURRENT_PACKAGE_VERSION");
    expect(source).toContain("manifest?.version === CURRENT_PACKAGE_VERSION");
  });

  it("keeps the structured issue route and required current documentation", () => {
    const issueConfig = load(
      fs.readFileSync(
        path.join(root, ".github/ISSUE_TEMPLATE/config.yml"),
        "utf8",
      ),
    ) as { blank_issues_enabled?: boolean };
    const question = load(
      fs.readFileSync(
        path.join(root, ".github/ISSUE_TEMPLATE/question.yml"),
        "utf8",
      ),
    ) as { labels?: string[]; body?: unknown[] };
    const support = fs.readFileSync(path.join(root, "SUPPORT.md"), "utf8");
    expect(issueConfig).toEqual({ blank_issues_enabled: false });
    expect(question.labels).toContain("question");
    expect(question.body?.length).toBeGreaterThan(0);
    expect(support).toContain(
      "https://github.com/mr-min-max/staledocs/issues/new?template=question.yml",
    );
    expect(support).not.toContain("/discussions");
    for (const file of [
      "README.md",
      "docs/LIMITATIONS.md",
      "docs/PUBLIC_BETA.md",
      "docs/CLI.md",
      "docs/GITHUB_ACTION.md",
      "docs/RELEASING.md",
      "docs/releases/v0.4.0-beta.1.md",
    ]) {
      expect(fs.existsSync(path.join(root, file))).toBe(true);
    }
  });

  it("keeps package identity, scripts, engines, files, and Action pins", () => {
    const lock = JSON.parse(
      fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
    ) as {
      name: string;
      version: string;
      packages: Record<string, { name?: string; version?: string }>;
    };
    expect(packageJson.name).toBe("staledocs");
    expect(packageJson.version).toMatch(/^[0-9A-Za-z][0-9A-Za-z._-]*$/u);
    expect(lock.name).toBe(packageJson.name);
    expect(lock.version).toBe(packageJson.version);
    expect(lock.packages[""]?.name).toBe(packageJson.name);
    expect(lock.packages[""]?.version).toBe(packageJson.version);
    expect(packageJson.engines).toEqual({ node: ">=22.12.0" });
    expect(packageJson.files).toEqual(["dist/"]);
    expect(packageJson.bin).toEqual({ staledocs: "dist/cli/index.js" });
    expect(packageJson.scripts["test:npm-published"]).toContain(
      "node --test tests/e2e/npm-published.test.mjs",
    );
    expect(packageJson.scripts["test:public-beta"]).toContain(
      "npm run test:npm-published",
    );
    const action = fs.readFileSync(path.join(root, "action.yml"), "utf8");
    const releaseWorkflow = fs.readFileSync(
      path.join(root, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(action).toContain('name: "StaleDocs: documentation drift check"');
    expect(releaseWorkflow).toMatch(/uses:\s+[^\s]+@[0-9a-f]{40}/u);
  });

  it("keeps renamed source artifacts and current release paths", () => {
    const preflight = fs.readFileSync(
      path.join(root, "scripts/public-beta-preflight.mjs"),
      "utf8",
    );
    for (const artifact of [
      "integrations/codex/staledocs/.codex-plugin/plugin.json",
      "integrations/codex/staledocs/.mcp.json",
      "docs/assets/brand/staledocs-mark.svg",
      "docs/assets/demo/staledocs-flow-poster.svg",
      "docs/assets/social/staledocs-social-preview.svg",
      "docs/assets/demo/staledocs-flow.gif",
      "docs/demo/staledocs-walkthrough-script.md",
    ]) {
      expect(preflight).toContain(artifact);
      expect(fs.existsSync(path.join(root, artifact))).toBe(true);
    }
    expect(preflight).toContain("tests/e2e/storefront-demo.test.mjs");
    expect(preflight).not.toContain("tests/e2e/storefront-readme.test.mjs");
    expect(preflight).not.toContain(
      "tests/unit/release/storefront-copy.test.ts",
    );
  });

  it("scans the public corpus for private paths, secrets, and em dashes", () => {
    const corpus = [
      "README.md",
      "ROADMAP.md",
      "CHANGELOG.md",
      "docs/LIMITATIONS.md",
      "docs/PUBLIC_BETA.md",
      "docs/CLI.md",
      "docs/GITHUB_ACTION.md",
      "docs/RELEASING.md",
      "docs/releases/v0.4.0-beta.1.md",
    ]
      .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
      .join("\n");
    expect(corpus).not.toMatch(/\/Users\/|\/home\/[^\s/]+/u);
    expect(corpus).not.toContain("\u2014");
    expect(corpus).not.toMatch(/(?:sk|pk|ghp|github_pat)_[A-Za-z0-9_-]{20,}/u);
  });
});
