import * as fs from "fs";
import * as path from "path";

interface ServerArgument {
  type: string;
  value?: string;
}

interface ServerPackage {
  registryType: string;
  identifier: string;
  version: string;
  transport: { type: string };
  runtimeHint?: string;
  packageArguments?: ServerArgument[];
}

interface ServerJson {
  $schema: string;
  name: string;
  description: string;
  version: string;
  repository?: { url: string; source: string };
  packages: ServerPackage[];
}

const root = path.resolve(".");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
  mcpName?: string;
  repository: { url: string };
};
const serverJson = JSON.parse(
  fs.readFileSync(path.join(root, "server.json"), "utf8"),
) as ServerJson;

describe("MCP Registry server metadata", () => {
  it("names the npm package of this release and proves its ownership", () => {
    expect(serverJson.name).toBe("io.github.mr-min-max/staledocs");
    expect(packageJson.mcpName).toBe(serverJson.name);
    expect(serverJson.version).toBe(packageJson.version);
    expect(serverJson.packages).toHaveLength(1);

    const [npmPackage] = serverJson.packages;
    expect(npmPackage.registryType).toBe("npm");
    expect(npmPackage.identifier).toBe(packageJson.name);
    expect(npmPackage.version).toBe(packageJson.version);
  });

  it("starts the published executable as a local stdio MCP server", () => {
    const [npmPackage] = serverJson.packages;
    expect(npmPackage.transport).toEqual({ type: "stdio" });
    expect(npmPackage.runtimeHint).toBe("npx");
    expect(npmPackage.packageArguments).toEqual([
      { type: "positional", value: "--mcp" },
    ]);
  });

  it("stays within the registry schema limits it is published under", () => {
    expect(serverJson.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/u,
    );
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
    expect(serverJson.repository).toEqual({
      url: packageJson.repository.url.replace(/\.git$/u, ""),
      source: "github",
    });
  });
});
