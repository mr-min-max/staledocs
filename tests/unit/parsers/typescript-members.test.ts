import { listDeclaredTypeMembers } from "../../../src/parsers/typescript";

function members(source: string, filePath = "src/index.ts") {
  return listDeclaredTypeMembers(filePath, source);
}

describe("listDeclaredTypeMembers", () => {
  it("lists every declared class member of any visibility", () => {
    expect(
      members(
        [
          "export class Client {",
          "  static defaults = {};",
          "  static create(): Client { return new Client(1); }",
          "  baseUrl = '';",
          "  #token = '';",
          "  private secret(): void {}",
          "  protected retry(): void {}",
          "  get size(): number { return 0; }",
          "  set size(value: number) {}",
          "  constructor(public readonly timeout: number, private log?: string) {}",
          "  fetch(url: string): string { return url; }",
          "  fetch2(url: string): string;",
          "  fetch2(url: string): string { return url; }",
          "  'quoted-name' = 1;",
          "}",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      {
        name: "Client",
        kind: "class",
        members: [
          "#token",
          "baseUrl",
          "create",
          "defaults",
          "fetch",
          "fetch2",
          "log",
          "quoted-name",
          "retry",
          "secret",
          "size",
          "timeout",
        ],
        closed: true,
      },
    ]);
  });

  it("lists interface properties, methods, and accessors", () => {
    expect(
      members(
        [
          "export interface Options {",
          "  timeout?: number;",
          "  retry(count: number): void;",
          "  get label(): string;",
          "  (input: string): void;",
          "}",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      {
        name: "Options",
        kind: "interface",
        members: ["label", "retry", "timeout"],
        closed: true,
      },
    ]);
  });

  it("marks heritage, index signatures, merges, and computed names as open", () => {
    const listed = members(
      [
        "class Base { inherited(): void {} }",
        "export class Child extends Base {}",
        "export interface Wide extends Options {}",
        "export interface Options { a: number }",
        "export interface Indexed { [key: string]: number; known: number }",
        "export class Bag { [key: string]: unknown; known = 1; }",
        "export interface Merged { first: number }",
        "export interface Merged { second: number }",
        "export class Spaced {}",
        "export namespace Spaced { export const extra = 1; }",
        "const KEY = 'dynamic';",
        "export class Computed { [KEY] = 1; plain = 2; }",
        "",
      ].join("\n"),
    );
    expect(
      listed.map(({ name, kind, closed }) => [name, kind, closed]),
    ).toEqual([
      ["Bag", "class", false],
      ["Child", "class", false],
      ["Computed", "class", false],
      ["Indexed", "interface", false],
      ["Merged", "interface", false],
      ["Options", "interface", true],
      ["Spaced", "class", false],
      ["Wide", "interface", false],
    ]);
  });

  it("uses the exported name of a default-exported or renamed class", () => {
    expect(
      members(
        [
          "class Internal { run(): void {} }",
          "export { Internal as Runner };",
          "export default class Service { stop(): void {} }",
          "",
        ].join("\n"),
      ).map(({ name, members: names }) => [name, names]),
    ).toEqual([
      ["Runner", ["run"]],
      ["Service", ["stop"]],
    ]);
  });

  it("reads TypeScript declaration files and skips JavaScript sources", () => {
    expect(
      members("export declare class Typed { value: number; }\n", "types/index.d.ts"),
    ).toEqual([
      { name: "Typed", kind: "class", members: ["value"], closed: true },
    ]);
    for (const filePath of ["src/legacy.js", "src/legacy.mjs", "src/legacy.cjs", "src/view.jsx"]) {
      expect(
        members(
          "export class Legacy { constructor() { this.cache = {}; } load() {} }\n",
          filePath,
        ),
      ).toEqual([]);
    }
  });

  it("fails closed on syntax errors", () => {
    expect(() => members("export class Broken {\n")).toThrow(
      "TypeScript syntax error.",
    );
  });
});
