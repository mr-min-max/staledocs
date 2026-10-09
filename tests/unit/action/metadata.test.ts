import * as fs from "fs";
import * as path from "path";

const { load } = require("js-yaml") as {
  load(source: string): unknown;
};

interface CompositeStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface CompositeAction {
  name?: string;
  description?: string;
  inputs?: Record<string, { default?: unknown; description?: string }>;
  runs: { using: string; steps: CompositeStep[] };
}

const metadata = load(
  fs.readFileSync(path.resolve("action.yml"), "utf8"),
) as CompositeAction;

describe("composite Action metadata", () => {
  it("pins setup-node immutably and uses an explicit supported Node floor", () => {
    const setup = metadata.runs.steps.find(
      (step) => step.name === "Setup Node.js",
    );
    if (!setup) throw new Error("Missing Setup Node.js step");
    const nodeVersion = String(setup.with?.["node-version"] ?? "");
    const [major, minor] = nodeVersion.split(".").map(Number);

    expect(metadata.runs.using).toBe("composite");
    expect(setup.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/u);
    expect(major).toBeGreaterThanOrEqual(22);
    expect(major === 22 ? minor : 12).toBeGreaterThanOrEqual(12);
  });

  it("declares review inputs with their locked defaults", () => {
    expect(metadata.inputs?.mode?.default).toBe("review");
    expect(metadata.inputs?.["fail-on"]?.default).toBe("none");
    expect(metadata.inputs?.comment?.default).toBe("true");
    expect(metadata.inputs?.labels?.default).toBe("true");
    expect(metadata.inputs?.["github-token"]?.default).toBe("${{ github.token }}");
    expect(metadata.inputs?.source?.default).toBe("npm");
  });

  it("keeps the Marketplace listing publishable", () => {
    expect(metadata.description ?? "").not.toBe("");
    expect((metadata.description ?? "").length).toBeLessThan(125);
  });
});
