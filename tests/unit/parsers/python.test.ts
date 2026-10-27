import { PythonParser } from "../../../src/parsers/python";
import type {
  ContractFacet,
  ParserSymbolSnapshot,
} from "../../../src/impact/types";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("PythonParser", () => {
  const parser = new PythonParser();
  const fixturePath = path.resolve(__dirname, "../../fixtures/sample.py");

  async function classSnapshot(source: string): Promise<ParserSymbolSnapshot> {
    const snapshot = await parser.snapshot("src/client.py", source);
    return snapshot.symbols.find(({ kind }) => kind === "class")!;
  }

  function changedFacets(
    before: ParserSymbolSnapshot,
    after: ParserSymbolSnapshot,
  ): string[] {
    return [
      ...new Set([
        ...Object.keys(before.contractFacets),
        ...Object.keys(after.contractFacets),
      ]),
    ]
      .filter(
        (facet) =>
          before.contractFacets[facet as ContractFacet] !==
          after.contractFacets[facet as ContractFacet],
      )
      .sort();
  }

  it("should parse a Python file", async () => {
    const result = await parser.parse(fixturePath);
    expect(result.filePath).toBe(fixturePath);
    expect(result.language).toBe("python");
  });

  it("parses captured Python source without reopening its backing path", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "staledocs-python-captured-"),
    );
    const backingPath = path.join(root, "captured.py");
    const source = `
from collections import Counter

def request(value: str, count: int = 1) -> str:
    """Captured request docs"""
    return value * count

class Service:
    def run(self, value: str) -> str:
        return value
`;
    fs.writeFileSync(backingPath, source);

    try {
      const expected = await parser.parse(backingPath);
      fs.writeFileSync(
        backingPath,
        `def unrelated() -> str:\n    return "backing-path"\n`,
      );
      fs.rmSync(backingPath);

      await expect(parser.parseSource!(backingPath, source)).resolves.toEqual(
        expected,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("should extract exported functions", async () => {
    const result = await parser.parse(fixturePath);
    const funcNames = result.functions.map((f) => f.name);
    expect(funcNames).toContain("greet_user");
    expect(funcNames).toContain("fetch_data");
    // Private functions should not be included
    expect(funcNames).not.toContain("_internal_function");
  });

  it("should extract function parameters and return types", async () => {
    const result = await parser.parse(fixturePath);
    const greet = result.functions.find((f) => f.name === "greet_user");
    expect(greet).toBeDefined();
    expect(greet!.parameters.length).toBe(2);
    expect(greet!.parameters[0].name).toBe("name");
    expect(greet!.parameters[0].type).toBe("str");
    expect(greet!.returnType).toBe("str");
  });

  it("should detect optional parameters", async () => {
    const result = await parser.parse(fixturePath);
    const greet = result.functions.find((f) => f.name === "greet_user");
    expect(greet).toBeDefined();
    // 'greeting' has a default value so should be optional
    const greetingParam = greet!.parameters.find((p) => p.name === "greeting");
    expect(greetingParam).toBeDefined();
    expect(greetingParam!.isOptional).toBe(true);
  });

  it("should detect async functions", async () => {
    const result = await parser.parse(fixturePath);
    const fetchData = result.functions.find((f) => f.name === "fetch_data");
    expect(fetchData).toBeDefined();
    expect(fetchData!.isAsync).toBe(true);
  });

  it("should extract exported classes", async () => {
    const result = await parser.parse(fixturePath);
    const classNames = result.classes.map((c) => c.name);
    expect(classNames).toContain("DataProcessor");
    expect(classNames).toContain("UserService");
  });

  it("should extract class inheritance", async () => {
    const result = await parser.parse(fixturePath);
    const userService = result.classes.find((c) => c.name === "UserService");
    expect(userService).toBeDefined();
    expect(userService!.extends).toBe("DataProcessor");
  });

  it("should extract class methods", async () => {
    const result = await parser.parse(fixturePath);
    const dataProcessor = result.classes.find(
      (c) => c.name === "DataProcessor",
    );
    expect(dataProcessor).toBeDefined();
    expect(dataProcessor!.methods.length).toBeGreaterThanOrEqual(2);
    const methodNames = dataProcessor!.methods.map((m) => m.name);
    expect(methodNames).toContain("__init__");
    expect(methodNames).toContain("process");
  });

  it("should extract existing docstrings", async () => {
    const result = await parser.parse(fixturePath);
    const greet = result.functions.find((f) => f.name === "greet_user");
    expect(greet!.existingDoc).toContain("Creates a greeting message");
  });

  it("should extract imports", async () => {
    const result = await parser.parse(fixturePath);
    expect(result.imports.length).toBeGreaterThanOrEqual(3);
    const sources = result.imports.map((i) => i.source);
    expect(sources).toContain("os");
    expect(sources).toContain("json");
    expect(sources).toContain("typing");
  });

  it("should report supported extensions", () => {
    expect(parser.supportedExtensions).toContain(".py");
  });

  it("should throw on non-existent file", async () => {
    await expect(parser.parse("/nonexistent/file.py")).rejects.toThrow(
      "File not found",
    );
  });

  it("throws a parser-unavailable error when the Python process cannot start", async () => {
    const unavailable = Object.assign(new Error("spawn python3 ENOENT"), {
      code: "ENOENT",
    });
    const unavailableParser = new PythonParser(async () => {
      throw unavailable;
    });

    await expect(unavailableParser.parse(fixturePath)).rejects.toThrow(
      /Python parser unavailable.*python3/i,
    );
  });

  it("includes the local Python version and override hint on parse failure", async () => {
    const original = process.env.STALEDOCS_PYTHON;
    delete process.env.STALEDOCS_PYTHON;
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[1] === "import sys; print(sys.version_info[:2])") {
        return { stdout: "(3, 9)\n", stderr: "" };
      }
      throw new Error("syntax failure");
    };

    try {
      await expect(
        new PythonParser(runner).parseSource("src/broken.py", "def broken(:\n"),
      ).rejects.toThrow(
        "Failed to parse Python source (local python3 is 3.9; the project may need a newer interpreter; set STALEDOCS_PYTHON to choose one).",
      );
      expect(calls.map(({ command }) => command)).toEqual([
        "python3",
        "python3",
      ]);
    } finally {
      if (original === undefined) delete process.env.STALEDOCS_PYTHON;
      else process.env.STALEDOCS_PYTHON = original;
    }
  });

  it("uses STALEDOCS_PYTHON as the Python executable override", async () => {
    const original = process.env.STALEDOCS_PYTHON;
    process.env.STALEDOCS_PYTHON = "/opt/py/bin/python3.12";
    const commands: string[] = [];
    const runner = async (command: string) => {
      commands.push(command);
      return {
        stdout: JSON.stringify({ functions: [], classes: [], imports: [] }),
        stderr: "",
      };
    };

    try {
      await expect(
        new PythonParser(runner).parseSource("src/empty.py", ""),
      ).resolves.toMatchObject({ language: "python" });
      expect(commands).toEqual(["/opt/py/bin/python3.12"]);
    } finally {
      if (original === undefined) delete process.env.STALEDOCS_PYTHON;
      else process.env.STALEDOCS_PYTHON = original;
    }
  });

  it("accepts a genuinely parsed empty Python source file", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "staledocs-python-empty-"),
    );
    const emptyFile = path.join(root, "empty.py");
    fs.writeFileSync(emptyFile, "");

    try {
      await expect(parser.parse(emptyFile)).resolves.toMatchObject({
        filePath: emptyFile,
        language: "python",
        functions: [],
        classes: [],
        imports: [],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not expose malformed Python source through parser diagnostics", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "staledocs-python-error-"),
    );
    const fakeSourceSecret = ["sk", "proj", "Y".repeat(32)].join("-");
    const brokenFile = path.join(root, "broken.py");
    fs.writeFileSync(brokenFile, `def broken(${fakeSourceSecret}:\n`);

    try {
      let thrown: unknown;
      try {
        await parser.parse(brokenFile);
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain(fakeSourceSecret);
      expect((thrown as Error).message).toMatch(
        /^Failed to parse Python source \(local python3 is \d+\.\d+; the project may need a newer interpreter; set STALEDOCS_PYTHON to choose one\)\.$/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects captured syntax diagnostics with a fixed value-free message", async () => {
    const sourceSentinel = ["captured", "python", "Y".repeat(32)].join("-");

    let thrown: unknown;
    try {
      await parser.parseSource!(
        "src/captured.py",
        `def broken(${sourceSentinel}:\n`,
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /^Failed to parse Python source \(local python3 is \d+\.\d+; the project may need a newer interpreter; set STALEDOCS_PYTHON to choose one\)\.$/u,
    );
    expect((thrown as Error).message).not.toContain(sourceSentinel);
  });

  // Break caught: raw defaults or docstrings cross the snapshot boundary.
  it("returns value-free hashes for an in-memory public function", async () => {
    const snapshot = await parser.snapshot(
      "src/client.py",
      `
def request(value: str = "secret-default") -> int:
    """secret docs"""
    return len(value) + 1
`,
    );

    expect(snapshot).toMatchObject({
      language: "python",
      dependencyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      symbols: [
        {
          language: "python",
          kind: "function",
          qualifiedName: "request",
          contractFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          implementationFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          documentationFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      ],
    });
    expect(snapshot.symbols[0].signature).toBe(
      "def request(value: str='secret-default') -> int",
    );
    expect(snapshot.symbols[0].arity).toEqual({ required: 0, total: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("secret docs");
    const repeated = await parser.snapshot(
      "src/client.py",
      `def request(value: str = "secret-default") -> int:
    """secret docs"""
    return len(value) + 1
`,
    );
    expect(repeated.symbols[0].documentationFingerprint).toBe(
      snapshot.symbols[0].documentationFingerprint,
    );
  });

  // Break caught: source positions, comments, or whitespace participate in fingerprints.
  it("snapshots static relative reexports and literal dunder all", async () => {
    const snapshot = await parser.snapshot(
      "pkg/__init__.py",
      `from .core import run as execute, helper
from .sub import *
__all__ = ["execute", "visible"]
`,
    );

    expect(snapshot.reexports).toEqual([
      {
        specifier: ".core",
        names: [
          { exported: "execute", local: "run" },
          { exported: "helper", local: "helper" },
        ],
      },
      { specifier: ".sub" },
    ]);
    expect(snapshot.dunderAll).toEqual(["execute", "visible"]);
  });

  it("deduplicates repeated literal dunder all names", async () => {
    const snapshot = await parser.snapshot(
      "pkg/__init__.py",
      `from .core import run
__all__ = ["run", "run"]
`,
    );

    expect(snapshot.dunderAll).toEqual(["run"]);
  });

  it("treats dynamic dunder all as absent", async () => {
    const snapshot = await parser.snapshot(
      "pkg/__init__.py",
      `from .core import run
__all__ = [name for name in values]
`,
    );

    expect(snapshot.dunderAll).toBeUndefined();
    expect(snapshot.reexports).toEqual([
      {
        specifier: ".core",
        names: [{ exported: "run", local: "run" }],
      },
    ]);
  });

  it("keeps snapshots stable across formatting and line movement", async () => {
    const compact = await parser.snapshot(
      "src/client.py",
      `def request(value: str = "stable") -> int:
    """stable docs"""
    return len(value) + 1
`,
    );
    const moved = await parser.snapshot(
      "src/client.py",
      `
# unrelated comment


def request( value: str="stable" )->int:
    """stable docs"""

    return len(value)+1  # formatting only
`,
    );

    expect(moved).toEqual(compact);
  });

  // Break caught: Python code-point symbol order is rejected using JavaScript UTF-16 order.
  it("accepts Python-sorted BMP and supplementary-plane identifiers", async () => {
    const snapshot = await parser.snapshot(
      "src/unicode.py",
      `def \uFA0E():
    return 1

def \u{10400}():
    return 2
`,
    );

    expect(snapshot.symbols.map(({ qualifiedName }) => qualifiedName)).toEqual([
      "\uFA0E",
      "\u{10400}",
    ]);
  });

  // Break caught: Python argument categories collapse into one positional list.
  it("fingerprints positional-only parameter changes", async () => {
    const positionalOnly = await parser.snapshot(
      "src/client.py",
      `def request(value: int, /, label: str) -> int:
    return 1
`,
    );
    const positionalOrKeyword = await parser.snapshot(
      "src/client.py",
      `def request(value: int, label: str) -> int:
    return 1
`,
    );

    expect(positionalOrKeyword.symbols[0].contractFacets.parameters).not.toBe(
      positionalOnly.symbols[0].contractFacets.parameters,
    );
    expect(positionalOrKeyword.symbols[0].contractFingerprint).not.toBe(
      positionalOnly.symbols[0].contractFingerprint,
    );
    expect(positionalOrKeyword.symbols[0].implementationFingerprint).toBe(
      positionalOnly.symbols[0].implementationFingerprint,
    );
  });

  // Break caught: keyword-only parameters are treated as positional parameters.
  it("fingerprints keyword-only parameter changes", async () => {
    const positional = await parser.snapshot(
      "src/client.py",
      `def request(value: int, label: str) -> int:
    return 1
`,
    );
    const keywordOnly = await parser.snapshot(
      "src/client.py",
      `def request(value: int, *, label: str) -> int:
    return 1
`,
    );

    expect(keywordOnly.symbols[0].contractFacets.parameters).not.toBe(
      positional.symbols[0].contractFacets.parameters,
    );
    expect(keywordOnly.symbols[0].implementationFingerprint).toBe(
      positional.symbols[0].implementationFingerprint,
    );
  });

  // Break caught: variadic parameters are absent from the callable contract.
  it("fingerprints variadic parameter changes", async () => {
    const first = await parser.snapshot(
      "src/client.py",
      `def request(*values: bytes, **options: str) -> int:
    return 1
`,
    );
    const changed = await parser.snapshot(
      "src/client.py",
      `def request(*items: bytes, **metadata: str) -> int:
    return 1
`,
    );

    expect(changed.symbols[0].contractFacets.parameters).not.toBe(
      first.symbols[0].contractFacets.parameters,
    );
    expect(changed.symbols[0].contractFingerprint).not.toBe(
      first.symbols[0].contractFingerprint,
    );
  });

  // Break caught: annotations, defaults, or returns do not reach their matching facets.
  it("separates annotation, default, and return contract changes", async () => {
    const baseline = await parser.snapshot(
      "src/client.py",
      `def request(value: str = "first-default") -> int:
    return 1
`,
    );
    const annotationChanged = await parser.snapshot(
      "src/client.py",
      `def request(value: bytes = "first-default") -> int:
    return 1
`,
    );
    const defaultChanged = await parser.snapshot(
      "src/client.py",
      `def request(value: str = "second-default") -> int:
    return 1
`,
    );
    const returnChanged = await parser.snapshot(
      "src/client.py",
      `def request(value: str = "first-default") -> str:
    return 1
`,
    );

    for (const changed of [annotationChanged, defaultChanged]) {
      expect(changed.symbols[0].contractFacets.parameters).not.toBe(
        baseline.symbols[0].contractFacets.parameters,
      );
      expect(changed.symbols[0].contractFacets.return).toBe(
        baseline.symbols[0].contractFacets.return,
      );
      expect(changed.symbols[0].implementationFingerprint).toBe(
        baseline.symbols[0].implementationFingerprint,
      );
    }
    expect(returnChanged.symbols[0].contractFacets.return).not.toBe(
      baseline.symbols[0].contractFacets.return,
    );
    expect(returnChanged.symbols[0].contractFacets.parameters).toBe(
      baseline.symbols[0].contractFacets.parameters,
    );
    expect(baseline.symbols[0].signature).toContain("first-default");
    expect(defaultChanged.symbols[0].signature).toContain("second-default");
  });

  // Break caught: executable body mutations are mistaken for contract changes.
  it("changes only implementation fingerprints for body mutations", async () => {
    const first = await parser.snapshot(
      "src/client.py",
      `def calculate(value: int) -> int:
    return value + 1
`,
    );
    const changed = await parser.snapshot(
      "src/client.py",
      `def calculate(value: int) -> int:
    return value * 2
`,
    );

    expect(changed.symbols[0].contractFacets).toEqual(
      first.symbols[0].contractFacets,
    );
    expect(changed.symbols[0].contractFingerprint).toBe(
      first.symbols[0].contractFingerprint,
    );
    expect(changed.symbols[0].implementationFingerprint).not.toBe(
      first.symbols[0].implementationFingerprint,
    );
  });

  // Break caught: decorators and async syntax are omitted from the modifiers facet.
  it("fingerprints decorators and callable modifiers", async () => {
    const first = await parser.snapshot(
      "src/client.py",
      `@route("first-route")
def request(value: int) -> int:
    return value
`,
    );
    const decoratorChanged = await parser.snapshot(
      "src/client.py",
      `@route("second-route")
def request(value: int) -> int:
    return value
`,
    );
    const asyncChanged = await parser.snapshot(
      "src/client.py",
      `@route("first-route")
async def request(value: int) -> int:
    return value
`,
    );

    for (const changed of [decoratorChanged, asyncChanged]) {
      expect(changed.symbols[0].contractFacets.modifiers).not.toBe(
        first.symbols[0].contractFacets.modifiers,
      );
      expect(changed.symbols[0].contractFingerprint).not.toBe(
        first.symbols[0].contractFingerprint,
      );
      expect(changed.symbols[0].implementationFingerprint).toBe(
        first.symbols[0].implementationFingerprint,
      );
    }
    expect(JSON.stringify(first)).not.toContain("first-route");
    expect(JSON.stringify(decoratorChanged)).not.toContain("second-route");
  });

  // Break caught: valid Python overload declarations become duplicate snapshot identities.
  it("groups Python overloads into deterministic function and method symbols", async () => {
    const first = await parser.snapshot(
      "src/convert.py",
      `from typing import overload

@overload
def convert(value: str) -> str: ...
@overload
def convert(value: int) -> int: ...
def convert(value):
    return value

class Service:
    @overload
    def run(self, value: str) -> str: ...
    @overload
    def run(self, value: int) -> int: ...
    def run(self, value):
        return value
`,
    );
    const reordered = await parser.snapshot(
      "src/convert.py",
      `from typing import overload

@overload
def convert(value: int) -> int: ...
@overload
def convert(value: str) -> str: ...
def convert(value):
    return value

class Service:
    @overload
    def run(self, value: int) -> int: ...
    @overload
    def run(self, value: str) -> str: ...
    def run(self, value):
        return value
`,
    );
    const changed = await parser.snapshot(
      "src/convert.py",
      `from typing import overload

@overload
def convert(value: bytes) -> str: ...
@overload
def convert(value: int) -> int: ...
def convert(value):
    return value

class Service:
    @overload
    def run(self, value: str) -> str: ...
    @overload
    def run(self, value: int) -> int: ...
    def run(self, value):
        return value
`,
    );

    expect(
      first.symbols.map(({ kind, qualifiedName }) => ({ kind, qualifiedName })),
    ).toEqual([
      { kind: "class", qualifiedName: "Service" },
      { kind: "function", qualifiedName: "convert" },
      { kind: "method", qualifiedName: "Service.run" },
    ]);
    expect(
      reordered.symbols.map(({ kind, qualifiedName }) => ({
        kind,
        qualifiedName,
      })),
    ).toEqual(
      first.symbols.map(({ kind, qualifiedName }) => ({ kind, qualifiedName })),
    );
    for (const kind of ["function", "method"] as const) {
      expect(
        first.symbols.find((symbol) => symbol.kind === kind)?.signature,
      ).toBe(
        kind === "function"
          ? "def convert(value: str) -> str | def convert(value: int) -> int"
          : "def run(value: str) -> str | def run(value: int) -> int",
      );
      expect(
        reordered.symbols.find((symbol) => symbol.kind === kind)?.signature,
      ).toBe(
        kind === "function"
          ? "def convert(value: int) -> int | def convert(value: str) -> str"
          : "def run(value: int) -> int | def run(value: str) -> str",
      );
    }
    for (const kind of ["class", "function", "method"] as const) {
      const original = first.symbols.find((symbol) => symbol.kind === kind);
      const swapped = reordered.symbols.find((symbol) => symbol.kind === kind);
      expect(swapped?.contractFacets).toEqual(original?.contractFacets);
      expect(swapped?.contractFingerprint).toBe(original?.contractFingerprint);
      expect(swapped?.implementationFingerprint).toBe(
        original?.implementationFingerprint,
      );
      expect(swapped?.documentationFingerprint).toBe(
        original?.documentationFingerprint,
      );
    }
    const originalFunction = first.symbols.find(
      ({ kind }) => kind === "function",
    );
    const changedFunction = changed.symbols.find(
      ({ kind }) => kind === "function",
    );
    expect(changedFunction?.contractFacets.parameters).not.toBe(
      originalFunction?.contractFacets.parameters,
    );
    expect(changedFunction?.contractFingerprint).not.toBe(
      originalFunction?.contractFingerprint,
    );
  });

  // Break caught: an overload implementation default is absent from every emitted fingerprint.
  it("fingerprints overload implementation defaults only as implementation details", async () => {
    const first = await parser.snapshot(
      "src/convert.py",
      `from typing import overload

@overload
def convert(value: str) -> str: ...
@overload
def convert(value: int) -> int: ...
def convert(value="first-runtime-default"):
    return value
`,
    );
    const changed = await parser.snapshot(
      "src/convert.py",
      `from typing import overload

@overload
def convert(value: str) -> str: ...
@overload
def convert(value: int) -> int: ...
def convert(value="second-runtime-default"):
    return value
`,
    );

    expect(changed.symbols[0].contractFacets).toEqual(
      first.symbols[0].contractFacets,
    );
    expect(changed.symbols[0].contractFingerprint).toBe(
      first.symbols[0].contractFingerprint,
    );
    expect(changed.symbols[0].implementationFingerprint).not.toBe(
      first.symbols[0].implementationFingerprint,
    );
    for (const sourceValue of [
      "first-runtime-default",
      "second-runtime-default",
    ]) {
      expect(JSON.stringify(first)).not.toContain(sourceValue);
      expect(JSON.stringify(changed)).not.toContain(sourceValue);
    }
  });

  // Break caught: an overload method's body-bearing runtime signature is omitted or made public contract.
  it("fingerprints overload runtime signatures only as implementation details", async () => {
    const first = await parser.snapshot(
      "src/service.py",
      `from typing import overload

class Service:
    @overload
    def run(self, value: str) -> str: ...
    @overload
    def run(self, value: int) -> int: ...
    def run(self, value):
        return value
`,
    );
    const changed = await parser.snapshot(
      "src/service.py",
      `from typing import overload

class Service:
    @overload
    def run(self, value: str) -> str: ...
    @overload
    def run(self, value: int) -> int: ...
    def run(self, value, *, trace=False):
        return value
`,
    );
    const originalClass = first.symbols.find(({ kind }) => kind === "class");
    const changedClass = changed.symbols.find(({ kind }) => kind === "class");
    const originalMethod = first.symbols.find(({ kind }) => kind === "method");
    const changedMethod = changed.symbols.find(({ kind }) => kind === "method");

    expect(changedMethod?.contractFacets).toEqual(
      originalMethod?.contractFacets,
    );
    expect(changedMethod?.contractFingerprint).toBe(
      originalMethod?.contractFingerprint,
    );
    expect(changedMethod?.implementationFingerprint).not.toBe(
      originalMethod?.implementationFingerprint,
    );
    expect(changedClass?.contractFacets).toEqual(originalClass?.contractFacets);
    expect(changedClass?.contractFingerprint).toBe(
      originalClass?.contractFingerprint,
    );
    expect(changedClass?.implementationFingerprint).not.toBe(
      originalClass?.implementationFingerprint,
    );
  });

  // Break caught: same-name property accessors collapse to the setter-only contract.
  it("aggregates property getter and setter contracts", async () => {
    const first = await parser.snapshot(
      "src/service.py",
      `class Service:
    @property
    def value(self) -> int:
        return self._value

    @value.setter
    def value(self, updated: str) -> None:
        self._value = updated
`,
    );
    const getterChanged = await parser.snapshot(
      "src/service.py",
      `class Service:
    @property
    def value(self) -> bytes:
        return self._value

    @value.setter
    def value(self, updated: str) -> None:
        self._value = updated
`,
    );
    const setterChanged = await parser.snapshot(
      "src/service.py",
      `class Service:
    @property
    def value(self) -> int:
        return self._value

    @value.setter
    def value(self, updated: bytes) -> None:
        self._value = updated
`,
    );
    const originalClass = first.symbols.find(({ kind }) => kind === "class");
    const originalMethod = first.symbols.find(({ kind }) => kind === "method");

    for (const changed of [getterChanged, setterChanged]) {
      const changedClass = changed.symbols.find(({ kind }) => kind === "class");
      const changedMethod = changed.symbols.find(
        ({ kind }) => kind === "method",
      );

      expect(changedClass?.contractFacets.members).not.toBe(
        originalClass?.contractFacets.members,
      );
      expect(changedClass?.contractFingerprint).not.toBe(
        originalClass?.contractFingerprint,
      );
      expect(changedClass?.implementationFingerprint).toBe(
        originalClass?.implementationFingerprint,
      );
      expect(changedMethod?.contractFingerprint).not.toBe(
        originalMethod?.contractFingerprint,
      );
      expect(changedMethod?.implementationFingerprint).toBe(
        originalMethod?.implementationFingerprint,
      );
    }
  });

  // Break caught: same-name property accessors collapse to the setter-only implementation.
  it("aggregates property getter and setter implementations", async () => {
    const first = await parser.snapshot(
      "src/service.py",
      `class Service:
    @property
    def value(self) -> str:
        return "first-getter-value"

    @value.setter
    def value(self, updated: str) -> None:
        self._value = "first-setter-value"
`,
    );
    const getterChanged = await parser.snapshot(
      "src/service.py",
      `class Service:
    @property
    def value(self) -> str:
        return "second-getter-value"

    @value.setter
    def value(self, updated: str) -> None:
        self._value = "first-setter-value"
`,
    );
    const setterChanged = await parser.snapshot(
      "src/service.py",
      `class Service:
    @property
    def value(self) -> str:
        return "first-getter-value"

    @value.setter
    def value(self, updated: str) -> None:
        self._value = "second-setter-value"
`,
    );
    const originalClass = first.symbols.find(({ kind }) => kind === "class");
    const originalMethod = first.symbols.find(({ kind }) => kind === "method");

    for (const changed of [getterChanged, setterChanged]) {
      const changedClass = changed.symbols.find(({ kind }) => kind === "class");
      const changedMethod = changed.symbols.find(
        ({ kind }) => kind === "method",
      );

      expect(changedClass?.contractFacets).toEqual(
        originalClass?.contractFacets,
      );
      expect(changedClass?.contractFingerprint).toBe(
        originalClass?.contractFingerprint,
      );
      expect(changedClass?.implementationFingerprint).not.toBe(
        originalClass?.implementationFingerprint,
      );
      expect(changedMethod?.contractFacets).toEqual(
        originalMethod?.contractFacets,
      );
      expect(changedMethod?.contractFingerprint).toBe(
        originalMethod?.contractFingerprint,
      );
      expect(changedMethod?.implementationFingerprint).not.toBe(
        originalMethod?.implementationFingerprint,
      );
    }
    for (const sourceValue of [
      "first-getter-value",
      "second-getter-value",
      "first-setter-value",
      "second-setter-value",
    ]) {
      expect(JSON.stringify(first)).not.toContain(sourceValue);
      expect(JSON.stringify(getterChanged)).not.toContain(sourceValue);
      expect(JSON.stringify(setterChanged)).not.toContain(sourceValue);
    }
  });

  // Break caught: independent accessor contract facets collide when getter and setter returns swap.
  it("preserves accessor roles in aggregated contracts", async () => {
    const first = await parser.snapshot(
      "src/service.py",
      `class Service:
    @property
    def value(self) -> "getter-contract-secret":
        return self._value

    @value.setter
    def value(self, updated: str) -> "setter-contract-secret":
        self._value = updated

    @value.deleter
    def value(self) -> None:
        del self._value
`,
    );
    const swapped = await parser.snapshot(
      "src/service.py",
      `class Service:
    @property
    def value(self) -> "setter-contract-secret":
        return self._value

    @value.setter
    def value(self, updated: str) -> "getter-contract-secret":
        self._value = updated

    @value.deleter
    def value(self) -> None:
        del self._value
`,
    );
    const originalClass = first.symbols.find(({ kind }) => kind === "class");
    const changedClass = swapped.symbols.find(({ kind }) => kind === "class");
    const originalMethod = first.symbols.find(({ kind }) => kind === "method");
    const changedMethod = swapped.symbols.find(({ kind }) => kind === "method");

    expect(swapped).not.toEqual(first);
    expect(changedMethod?.contractFacets).not.toEqual(
      originalMethod?.contractFacets,
    );
    expect(changedMethod?.contractFingerprint).not.toBe(
      originalMethod?.contractFingerprint,
    );
    expect(changedClass?.contractFacets.members).not.toBe(
      originalClass?.contractFacets.members,
    );
    expect(changedClass?.contractFingerprint).not.toBe(
      originalClass?.contractFingerprint,
    );
    expect(changedMethod?.implementationFingerprint).toBe(
      originalMethod?.implementationFingerprint,
    );
    expect(changedClass?.implementationFingerprint).toBe(
      originalClass?.implementationFingerprint,
    );
    expect(changedMethod?.documentationFingerprint).toBe(
      originalMethod?.documentationFingerprint,
    );
    expect(changedClass?.documentationFingerprint).toBe(
      originalClass?.documentationFingerprint,
    );
    expect(originalMethod?.signature).toContain("getter-contract-secret");
    expect(changedMethod?.signature).toContain("setter-contract-secret");
  });

  // Break caught: property accessor aggregation takes precedence over overload declarations.
  it("preserves overload precedence in mixed property accessor chains", async () => {
    const first = await parser.snapshot(
      "src/service.py",
      `from typing import overload

class Service:
    @overload
    @property
    def value(self) -> "overload-int-secret": ...

    @property
    def value(self) -> str:
        return self._value

    @value.setter
    def value(self, updated: str) -> None:
        self._value = updated
`,
    );
    const changed = await parser.snapshot(
      "src/service.py",
      `from typing import overload

class Service:
    @overload
    @property
    def value(self) -> "overload-bytes-secret": ...

    @property
    def value(self) -> str:
        return self._value

    @value.setter
    def value(self, updated: str) -> None:
        self._value = updated
`,
    );
    const originalClass = first.symbols.find(({ kind }) => kind === "class");
    const changedClass = changed.symbols.find(({ kind }) => kind === "class");
    const originalMethod = first.symbols.find(({ kind }) => kind === "method");
    const changedMethod = changed.symbols.find(({ kind }) => kind === "method");

    expect(changed).not.toEqual(first);
    expect(changedMethod?.contractFingerprint).not.toBe(
      originalMethod?.contractFingerprint,
    );
    expect(changedClass?.contractFacets.members).not.toBe(
      originalClass?.contractFacets.members,
    );
    expect(changedClass?.contractFingerprint).not.toBe(
      originalClass?.contractFingerprint,
    );
    expect(changedMethod?.implementationFingerprint).toBe(
      originalMethod?.implementationFingerprint,
    );
    expect(changedClass?.implementationFingerprint).toBe(
      originalClass?.implementationFingerprint,
    );
    expect(changedMethod?.documentationFingerprint).toBe(
      originalMethod?.documentationFingerprint,
    );
    expect(changedClass?.documentationFingerprint).toBe(
      originalClass?.documentationFingerprint,
    );
    expect(originalMethod?.signature).toContain("overload-int-secret");
    expect(changedMethod?.signature).toContain("overload-bytes-secret");
  });

  // Break caught: a shadowed earlier method still contributes to its owning class fingerprints.
  it("ignores shadowed repeated methods in method and class fingerprints", async () => {
    const first = await parser.snapshot(
      "src/service.py",
      `class Service:
    def run(self, obsolete: int = 1) -> int:
        return obsolete + 1

    def run(self, value: str) -> str:
        return value.strip()
`,
    );
    const changed = await parser.snapshot(
      "src/service.py",
      `class Service:
    async def run(self, obsolete: bytes = b"shadowed-secret") -> bytes:
        return obsolete

    def run(self, value: str) -> str:
        return value.strip()
`,
    );
    const originalClass = first.symbols.find(({ kind }) => kind === "class");
    const changedClass = changed.symbols.find(({ kind }) => kind === "class");
    const originalMethod = first.symbols.find(({ kind }) => kind === "method");
    const changedMethod = changed.symbols.find(({ kind }) => kind === "method");

    expect(changedMethod).toEqual(originalMethod);
    expect(changedClass).toEqual(originalClass);
    expect(JSON.stringify(changed)).not.toContain("shadowed-secret");
  });

  // Break caught: shadowed class assignments remain in the class member and
  // implementation payloads even though only the final binding is effective.
  it("ignores shadowed class assignment values", async () => {
    const first = await parser.snapshot(
      "src/service.py",
      `class Service:
    mode = "first-shadowed-assignment-sentinel"
    mode = 1
`,
    );
    const changed = await parser.snapshot(
      "src/service.py",
      `class Service:
    mode = "second-shadowed-assignment-sentinel"
    mode = 1
`,
    );

    expect(changed).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(
      "first-shadowed-assignment-sentinel",
    );
    expect(JSON.stringify(changed)).not.toContain(
      "second-shadowed-assignment-sentinel",
    );
  });

  // Break caught: a method symbol survives after a later assignment replaces
  // that public name in the effective class namespace.
  it("removes methods shadowed by later class assignments", async () => {
    const snapshot = await parser.snapshot(
      "src/service.py",
      `class Service:
    def run(self, value: str) -> str:
        return value

    run = 1
`,
    );

    expect(
      snapshot.symbols.map(({ kind, qualifiedName }) => ({
        kind,
        qualifiedName,
      })),
    ).toEqual([{ kind: "class", qualifiedName: "Service" }]);
  });

  // Break caught: documentation from an ineffective ordinary definition is
  // aggregated into the final symbol's documentation fingerprint.
  it("ignores documentation on shadowed non-overload functions", async () => {
    const first = await parser.snapshot(
      "src/service.py",
      `def request() -> int:
    """first-shadowed-documentation-sentinel"""
    return 1

def request() -> int:
    """effective documentation"""
    return 2
`,
    );
    const changed = await parser.snapshot(
      "src/service.py",
      `def request() -> int:
    """second-shadowed-documentation-sentinel"""
    return 1

def request() -> int:
    """effective documentation"""
    return 2
`,
    );

    expect(changed).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(
      "first-shadowed-documentation-sentinel",
    );
    expect(JSON.stringify(changed)).not.toContain(
      "second-shadowed-documentation-sentinel",
    );
  });

  // Break caught: a valid repeated class identity is rejected as malformed child output.
  it("snapshots the last effective repeated class declaration", async () => {
    const snapshot = await parser.snapshot(
      "src/service.py",
      `class Service:
    def replaced(self) -> int:
        return 1

class Service:
    def current(self) -> int:
        return 2
`,
    );

    expect(
      snapshot.symbols.map(({ kind, qualifiedName }) => ({
        kind,
        qualifiedName,
      })),
    ).toEqual([
      { kind: "class", qualifiedName: "Service" },
      { kind: "method", qualifiedName: "Service.current" },
    ]);
  });

  // Break caught: class bases are omitted from the inheritance facet.
  it("fingerprints class inheritance changes", async () => {
    const first = await parser.snapshot(
      "src/client.py",
      `class Service(Base, Protocol):
    pass
`,
    );
    const changed = await parser.snapshot(
      "src/client.py",
      `class Service(OtherBase, Protocol):
    pass
`,
    );

    expect(changed.symbols[0].kind).toBe("class");
    expect(changed.symbols[0].contractFacets.inheritance).not.toBe(
      first.symbols[0].contractFacets.inheritance,
    );
    expect(changed.symbols[0].contractFingerprint).not.toBe(
      first.symbols[0].contractFingerprint,
    );
    expect(changed.symbols[0].implementationFingerprint).toBe(
      first.symbols[0].implementationFingerprint,
    );
  });

  // Break caught: an added constructor parameter stays out of the class contract.
  it("fingerprints an added constructor parameter as a constructor facet change", async () => {
    const first = await classSnapshot(`class Service:
    def __init__(self, a: int):
        self.a = a
`);
    const changed = await classSnapshot(`class Service:
    def __init__(self, a: int, b: str = ""):
        self.a = a
`);

    expect(changedFacets(first, changed)).toEqual(["constructor"]);
    expect(changed.contractFingerprint).not.toBe(first.contractFingerprint);
    expect(first.arity).toEqual({ required: 1, total: 1 });
    expect(changed.arity).toEqual({ required: 1, total: 2 });
    expect(first.signature).toBe("class Service | __init__(a: int)");
    expect(changed.signature).toBe(
      "class Service | __init__(a: int, b: str='')",
    );
  });

  // Break caught: constructor annotation changes are treated as implementation.
  it("fingerprints a constructor annotation change as a constructor facet change", async () => {
    const first = await classSnapshot(`class HTTPException(Exception):
    def __init__(self, status_code: int, headers: Optional[dict[str, str]] = None) -> None:
        self.headers = headers
`);
    const changed = await classSnapshot(`class HTTPException(Exception):
    def __init__(self, status_code: int, headers: Optional[Mapping[str, str]] = None) -> None:
        self.headers = headers
`);

    expect(changedFacets(first, changed)).toEqual(["constructor"]);
    expect(changed.arity).toEqual(first.arity);
    expect(changed.arity).toEqual({ required: 1, total: 2 });
    expect(changed.signature).toBe(
      "class HTTPException(Exception) | __init__(status_code: int, headers: Optional[Mapping[str, str]]=None) -> None",
    );
  });

  // Break caught: a first explicit constructor leaves the class contract unchanged.
  it("fingerprints a newly declared constructor as a constructor facet change", async () => {
    const first = await classSnapshot(`class Service:
    def run(self):
        return 1
`);
    const changed = await classSnapshot(`class Service:
    def __init__(self, a: int):
        self.a = a

    def run(self):
        return 1
`);

    expect(changedFacets(first, changed)).toEqual(["constructor"]);
    expect(first).not.toHaveProperty("arity");
    expect(first.signature).toBe("class Service");
    expect(changed.arity).toEqual({ required: 1, total: 1 });
  });

  // Break caught: overloaded constructors render the runtime implementation
  // instead of the declared overloads.
  it("renders overloaded constructors and spans their arity", async () => {
    const service = await classSnapshot(`class Service:
    @overload
    def __init__(self, a: int) -> None: ...

    @overload
    def __init__(self, a: str, b: int) -> None: ...

    def __init__(self, a, b=0, c=None):
        self.a = a
`);

    expect(service.signature).toBe(
      "class Service | __init__(a: int) -> None | __init__(a: str, b: int) -> None",
    );
    expect(service.arity).toEqual({ required: 1, total: 2 });
  });

  // Break caught: constructor body edits become class contract changes.
  it("keeps constructor body changes out of the class contract", async () => {
    const first = await classSnapshot(`class Service:
    def __init__(self, a: int):
        self.x = a
`);
    const changed = await classSnapshot(`class Service:
    def __init__(self, a: int):
        self.x = int(a)
`);

    expect(changedFacets(first, changed)).toEqual([]);
    expect(changed.contractFingerprint).toBe(first.contractFingerprint);
    expect(changed.signature).toBe(first.signature);
    expect(changed.implementationFingerprint).not.toBe(
      first.implementationFingerprint,
    );
  });

  // Break caught: a constructor docstring edit becomes a class contract or
  // implementation change.
  it("keeps constructor docstring changes out of contract and implementation", async () => {
    const first = await classSnapshot(`class Service:
    def __init__(self, a: int):
        self.x = a
`);
    const changed = await classSnapshot(`class Service:
    def __init__(self, a: int):
        """Create the service."""
        self.x = a
`);

    expect(changedFacets(first, changed)).toEqual([]);
    expect(changed.contractFingerprint).toBe(first.contractFingerprint);
    expect(changed.implementationFingerprint).toBe(
      first.implementationFingerprint,
    );
  });

  // Break caught: private helpers enter the class contract with the constructor.
  it("keeps added private helpers out of the class contract", async () => {
    const first = await classSnapshot(`class Service:
    def __init__(self, a: int):
        self.x = a
`);
    const changed = await classSnapshot(`class Service:
    def __init__(self, a: int):
        self.x = a

    def _helper(self):
        return self.x
`);

    expect(changedFacets(first, changed)).toEqual([]);
    expect(changed.contractFingerprint).toBe(first.contractFingerprint);
    expect(changed.implementationFingerprint).not.toBe(
      first.implementationFingerprint,
    );
  });

  // Break caught: member or constructor declaration order enters the class contract.
  it("keeps class member and constructor order out of the class contract", async () => {
    const first = await classSnapshot(`class Service:
    def __init__(self, a: int):
        self.x = a

    def run(self) -> int:
        return 1

    def stop(self) -> None:
        return None
`);
    const changed = await classSnapshot(`class Service:
    def stop(self) -> None:
        return None

    def run(self) -> int:
        return 1

    def __init__(self, a: int):
        self.x = a
`);

    expect(changedFacets(first, changed)).toEqual([]);
    expect(changed.contractFingerprint).toBe(first.contractFingerprint);
    expect(changed.signature).toBe(first.signature);
  });

  // Break caught: public class methods lack stable qualified symbol identities.
  it("emits qualified public class methods", async () => {
    const snapshot = await parser.snapshot(
      "src/client.py",
      `class Service:
    def request(self, value: str) -> int:
        """method documentation sentinel"""
        return len(value)
`,
    );

    expect(
      snapshot.symbols.map(({ kind, qualifiedName }) => ({
        kind,
        qualifiedName,
      })),
    ).toEqual([
      { kind: "class", qualifiedName: "Service" },
      { kind: "method", qualifiedName: "Service.request" },
    ]);
    expect(snapshot.symbols[1].documentationFingerprint).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(JSON.stringify(snapshot)).not.toContain(
      "method documentation sentinel",
    );
    expect(snapshot.symbols[0]).toMatchObject({
      signature: "class Service",
    });
    expect(snapshot.symbols[0]).not.toHaveProperty("arity");
    expect(snapshot.symbols[1]).toMatchObject({
      signature: "def request(value: str) -> int",
      arity: { required: 1, total: 1 },
    });
  });

  // Break caught: a static method parameter named self is mistaken for a bound receiver.
  it("preserves every declared static method parameter in contract hashes", async () => {
    const withSelfParameter = await parser.snapshot(
      "src/client.py",
      `class Service:
    @staticmethod
    def request(self: str, value: int) -> int:
        return value
`,
    );
    const withoutSelfParameter = await parser.snapshot(
      "src/client.py",
      `class Service:
    @staticmethod
    def request(value: int) -> int:
        return value
`,
    );
    const originalClass = withSelfParameter.symbols.find(
      ({ kind }) => kind === "class",
    );
    const changedClass = withoutSelfParameter.symbols.find(
      ({ kind }) => kind === "class",
    );
    const originalMethod = withSelfParameter.symbols.find(
      ({ kind }) => kind === "method",
    );
    const changedMethod = withoutSelfParameter.symbols.find(
      ({ kind }) => kind === "method",
    );

    expect(changedMethod?.contractFacets.parameters).not.toBe(
      originalMethod?.contractFacets.parameters,
    );
    expect(changedMethod?.contractFingerprint).not.toBe(
      originalMethod?.contractFingerprint,
    );
    expect(changedClass?.contractFacets.members).not.toBe(
      originalClass?.contractFacets.members,
    );
  });

  // Break caught: renaming a bound instance receiver creates a false API change.
  it("excludes the bound instance receiver regardless of its local name", async () => {
    const first = await parser.snapshot(
      "src/client.py",
      `class Service:
    def request(receiver, value: int) -> int:
        return value
`,
    );
    const renamed = await parser.snapshot(
      "src/client.py",
      `class Service:
    def request(instance, value: int) -> int:
        return value
`,
    );
    const firstClass = first.symbols.find(({ kind }) => kind === "class");
    const renamedClass = renamed.symbols.find(({ kind }) => kind === "class");
    const firstMethod = first.symbols.find(({ kind }) => kind === "method");
    const renamedMethod = renamed.symbols.find(({ kind }) => kind === "method");

    expect(renamedMethod?.contractFingerprint).toBe(
      firstMethod?.contractFingerprint,
    );
    expect(renamedClass?.contractFacets.members).toBe(
      firstClass?.contractFacets.members,
    );
  });

  it("renders async, positional-only, keyword-only, variadic, and class signatures", async () => {
    const snapshot = await parser.snapshot(
      "src/signatures.py",
      `async def request(value: int, /, label: str = "x", *args, trace: bool, **kwargs) -> str:
    return label

class Service(Base, Protocol):
    pass
`,
    );
    const request = snapshot.symbols.find(({ kind }) => kind === "function");
    const service = snapshot.symbols.find(({ kind }) => kind === "class");

    expect(request).toMatchObject({
      signature:
        "async def request(value: int, /, label: str='x', *args, trace: bool, **kwargs) -> str",
      arity: { required: 2, total: 3 },
    });
    expect(service).toMatchObject({
      signature: "class Service(Base, Protocol)",
    });
    expect(service).not.toHaveProperty("arity");
  });

  it("caps Python signatures at 400 characters with an ellipsis", async () => {
    const snapshot = await parser.snapshot(
      "src/long.py",
      `def request(value: "${"x".repeat(500)}") -> None:
    pass
`,
    );

    expect(snapshot.symbols[0].signature).toHaveLength(400);
    expect(snapshot.symbols[0].signature.endsWith("...")).toBe(true);
  });

  it("truncates astral Python signatures by code point", async () => {
    const snapshot = await parser.snapshot(
      "src/astral.py",
      `def request(value: "${"😀".repeat(500)}") -> None:
    pass
`,
    );
    const signature = snapshot.symbols[0].signature;

    expect(Array.from(signature)).toHaveLength(400);
    expect(signature.endsWith("...")).toBe(true);
  });

  // Break caught: starred public assignment targets disappear from class fingerprints.
  it("fingerprints every public name in starred class assignments", async () => {
    const first = await parser.snapshot(
      "src/client.py",
      `class Result:
    head, *tail = values
`,
    );
    const changed = await parser.snapshot(
      "src/client.py",
      `class Result:
    head, *items = values
`,
    );
    const original = first.symbols[0];
    const updated = changed.symbols[0];

    expect(updated.contractFacets.members).not.toBe(
      original.contractFacets.members,
    );
    expect(updated.contractFingerprint).not.toBe(original.contractFingerprint);
    expect(updated.implementationFingerprint).not.toBe(
      original.implementationFingerprint,
    );
    for (const sourceValue of ["values", "tail", "items"]) {
      expect(JSON.stringify(first)).not.toContain(sourceValue);
      expect(JSON.stringify(changed)).not.toContain(sourceValue);
    }
  });

  // Break caught: underscore-prefixed declarations become public symbols.
  it("excludes underscore-prefixed functions, classes, members, and dunder methods", async () => {
    const snapshot = await parser.snapshot(
      "src/client.py",
      `def exposed():
    return 1

def _hidden_function():
    return "hidden-function-value"

class _HiddenClass:
    def visible_inside_private_class(self):
        return "hidden-class-value"

class Visible:
    def public(self):
        return 1

    def _private(self):
        return "private-value"

    def __init__(self):
        self.value = "dunder-init-value"

    def __str__(self):
        return "dunder-str-value"
`,
    );

    expect(
      snapshot.symbols.map(({ kind, qualifiedName }) => ({
        kind,
        qualifiedName,
      })),
    ).toEqual([
      { kind: "class", qualifiedName: "Visible" },
      { kind: "function", qualifiedName: "exposed" },
      { kind: "method", qualifiedName: "Visible.public" },
    ]);
  });

  // Break caught: import module values leak or fail to affect module dependency identity.
  it("isolates import changes to the dependency fingerprint", async () => {
    const first = await parser.snapshot(
      "src/client.py",
      `import first_secret_dependency as dependency
from first_secret_package import Client

def request() -> int:
    return dependency.call()
`,
    );
    const changed = await parser.snapshot(
      "src/client.py",
      `import second_secret_dependency as dependency
from second_secret_package import Client

def request() -> int:
    return dependency.call()
`,
    );

    expect(changed.dependencyFingerprint).not.toBe(first.dependencyFingerprint);
    expect(changed.symbols).toEqual(first.symbols);
    for (const sourceValue of [
      "first_secret_dependency",
      "first_secret_package",
      "second_secret_dependency",
      "second_secret_package",
    ]) {
      expect(JSON.stringify(first)).not.toContain(sourceValue);
      expect(JSON.stringify(changed)).not.toContain(sourceValue);
    }
  });

  // Break caught: imports beneath control flow or private scopes vanish from dependencies.
  it("fingerprints conditional and nested import module specifiers", async () => {
    const first = await parser.snapshot(
      "src/client.py",
      `if TYPE_CHECKING:
    import first_conditional_dependency

class _PrivateService:
    import first_class_dependency

def _private_helper():
    import first_function_dependency

def request() -> int:
    return 1
`,
    );
    const changed = await parser.snapshot(
      "src/client.py",
      `if TYPE_CHECKING:
    import second_conditional_dependency

class _PrivateService:
    import second_class_dependency

def _private_helper():
    import second_function_dependency

def request() -> int:
    return 1
`,
    );

    expect(changed.dependencyFingerprint).not.toBe(first.dependencyFingerprint);
    expect(changed.symbols).toEqual(first.symbols);
    for (const sourceValue of [
      "first_conditional_dependency",
      "first_class_dependency",
      "first_function_dependency",
      "second_conditional_dependency",
      "second_class_dependency",
      "second_function_dependency",
    ]) {
      expect(JSON.stringify(first)).not.toContain(sourceValue);
      expect(JSON.stringify(changed)).not.toContain(sourceValue);
    }
  });

  // Break caught: docstring expressions contaminate contract or implementation hashes.
  it("changes only documentation fingerprints for docstring mutations", async () => {
    const first = await parser.snapshot(
      "src/client.py",
      `def request() -> int:
    """first documentation sentinel"""
    return 1
`,
    );
    const changed = await parser.snapshot(
      "src/client.py",
      `def request() -> int:
    """second documentation sentinel"""
    return 1
`,
    );

    expect(changed.symbols[0].contractFingerprint).toBe(
      first.symbols[0].contractFingerprint,
    );
    expect(changed.symbols[0].implementationFingerprint).toBe(
      first.symbols[0].implementationFingerprint,
    );
    expect(changed.symbols[0].documentationFingerprint).not.toBe(
      first.symbols[0].documentationFingerprint,
    );
    expect(JSON.stringify(first)).not.toContain("first documentation sentinel");
    expect(JSON.stringify(changed)).not.toContain(
      "second documentation sentinel",
    );
  });

  // Break caught: a later class string expression is stripped as an artificial module docstring.
  it("fingerprints non-docstring class string expressions as implementation", async () => {
    const first = await parser.snapshot(
      "src/client.py",
      `class Service:
    """stable class documentation"""
    "first implementation sentinel"
`,
    );
    const changed = await parser.snapshot(
      "src/client.py",
      `class Service:
    """stable class documentation"""
    "second implementation sentinel"
`,
    );

    expect(changed.symbols[0].contractFingerprint).toBe(
      first.symbols[0].contractFingerprint,
    );
    expect(changed.symbols[0].documentationFingerprint).toBe(
      first.symbols[0].documentationFingerprint,
    );
    expect(changed.symbols[0].implementationFingerprint).not.toBe(
      first.symbols[0].implementationFingerprint,
    );
    expect(JSON.stringify(first)).not.toContain(
      "first implementation sentinel",
    );
    expect(JSON.stringify(changed)).not.toContain(
      "second implementation sentinel",
    );
  });

  // Break caught: in-memory syntax diagnostics expose source text.
  it("rejects snapshot syntax errors with a fixed safe message", async () => {
    const sourceSentinel = ["sk", "snapshot", "X".repeat(32)].join("-");

    let thrown: unknown;
    try {
      await parser.snapshot("src/broken.py", `def broken(${sourceSentinel}:\n`);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /^Failed to parse Python source \(local python3 is \d+\.\d+; the project may need a newer interpreter; set STALEDOCS_PYTHON to choose one\)\.$/u,
    );
    expect((thrown as Error).message).not.toContain(sourceSentinel);
    expect((thrown as Error).cause).toEqual(new Error("Python parser failed."));
  });

  // Break caught: snapshot source is placed in argv instead of child stdin.
  it("sends snapshot source through child stdin without placing it in argv", async () => {
    const sourceSentinel = `def request():\n    return "stdin-only-sentinel"\n`;
    let capturedArgs: string[] = [];
    let capturedInput: string | undefined;
    const hash = "0".repeat(64);
    const injectedParser = new PythonParser(async (_command, args, options) => {
      capturedArgs = args;
      capturedInput = (options as typeof options & { input?: string }).input;
      return {
        stdout: JSON.stringify({
          language: "python",
          dependencyFingerprint: hash,
          symbols: [],
        }),
        stderr: "",
      };
    });

    await injectedParser.snapshot("src/client.py", sourceSentinel);

    expect(capturedArgs.slice(2)).toEqual(["snapshot", "src/client.py"]);
    expect(capturedArgs).not.toContain(sourceSentinel);
    expect(capturedArgs.join(" ")).not.toContain("stdin-only-sentinel");
    expect(capturedInput).toBe(sourceSentinel);
  });

  // Break caught: an early-closing real child emits an unhandled stdin EPIPE.
  it("translates default-runner stdin failures without crashing the process", async () => {
    type DefaultRunner = (
      command: string,
      args: string[],
      options: { timeout: number; maxBuffer: number; input?: string },
    ) => Promise<{ stdout: string; stderr: string }>;
    const pythonModule = jest.requireActual(
      "../../../src/parsers/python",
    ) as typeof import("../../../src/parsers/python") & {
      createPythonProcessRunner?: () => DefaultRunner;
    };
    const runnerFactory = pythonModule.createPythonProcessRunner;
    if (runnerFactory === undefined) {
      throw new Error("Default Python process runner factory is unavailable.");
    }
    const defaultRunner = runnerFactory();
    const earlyClosingParser = new PythonParser((_command, _args, options) =>
      defaultRunner("python3", ["-c", "import os; os._exit(0)"], options),
    );
    const sourceSentinel = ["sk", "stdin-lifecycle", "L".repeat(32)].join("-");
    const largeSource = `# ${sourceSentinel}\n${"x".repeat(16 * 1024 * 1024)}`;

    let thrown: unknown;
    try {
      await earlyClosingParser.snapshot("src/client.py", largeSource);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /^Failed to parse Python source(?: \(local python3 is \d+\.\d+; the project may need a newer interpreter; set STALEDOCS_PYTHON to choose one\))?\.$/u,
    );
    expect(String(thrown)).not.toContain(sourceSentinel);
    expect(String((thrown as Error).cause)).not.toContain(sourceSentinel);
  });

  // Break caught: malformed child JSON is trusted as a value-free snapshot.
  it("rejects malformed child snapshots without retaining returned sentinels", async () => {
    const hash = "a".repeat(64);
    const sentinel = ["sk", "invalid-child-json", "J".repeat(32)].join("-");
    const validSymbol = {
      language: "python",
      kind: "function",
      qualifiedName: "request",
      signature: "def request()",
      arity: { required: 0, total: 0 },
      contractFacets: {
        parameters: hash,
        modifiers: hash,
      },
      contractFingerprint: hash,
      implementationFingerprint: hash,
      documentationFingerprint: null,
    };
    const validSnapshot = {
      language: "python",
      dependencyFingerprint: hash,
      symbols: [validSymbol],
    };
    const invalidOutputs: Array<[string, unknown]> = [
      ["unexpected root field", { ...validSnapshot, source: sentinel }],
      ["invalid root language", { ...validSnapshot, language: sentinel }],
      [
        "invalid dependency hash",
        { ...validSnapshot, dependencyFingerprint: sentinel },
      ],
      ["non-array symbols", { ...validSnapshot, symbols: sentinel }],
      [
        "duplicate symbol identities",
        { ...validSnapshot, symbols: [validSymbol, { ...validSymbol }] },
      ],
      [
        "unexpected symbol field",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, source: sentinel }],
        },
      ],
      [
        "invalid symbol language",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, language: sentinel }],
        },
      ],
      [
        "invalid symbol kind",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, kind: sentinel }],
        },
      ],
      [
        "unsafe qualified name",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, qualifiedName: sentinel }],
        },
      ],
      [
        "non-XID qualified name",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, qualifiedName: "\u037A" }],
        },
      ],
      [
        "unsafe signature control",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, signature: "def request(\u0007)" }],
        },
      ],
      [
        "overlong signature",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, signature: "x".repeat(401) }],
        },
      ],
      [
        "missing callable arity",
        {
          ...validSnapshot,
          symbols: [
            Object.fromEntries(
              Object.entries(validSymbol).filter(([key]) => key !== "arity"),
            ),
          ],
        },
      ],
      [
        "extra arity key",
        {
          ...validSnapshot,
          symbols: [
            {
              ...validSymbol,
              arity: { required: 0, total: 0, source: sentinel },
            },
          ],
        },
      ],
      [
        "invalid arity ordering",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, arity: { required: 2, total: 1 } }],
        },
      ],
      [
        "class without constructor facet",
        {
          ...validSnapshot,
          symbols: [
            {
              ...Object.fromEntries(
                Object.entries(validSymbol).filter(([key]) => key !== "arity"),
              ),
              kind: "class",
              qualifiedName: "Service",
              signature: "class Service",
              contractFacets: {
                inheritance: hash,
                members: hash,
                modifiers: hash,
              },
            },
          ],
        },
      ],
      [
        "invalid class arity ordering",
        {
          ...validSnapshot,
          symbols: [
            {
              ...validSymbol,
              kind: "class",
              qualifiedName: "Service",
              signature: "class Service | __init__(a: int)",
              arity: { required: 2, total: 1 },
              contractFacets: {
                constructor: hash,
                inheritance: hash,
                members: hash,
                modifiers: hash,
              },
            },
          ],
        },
      ],
      [
        "unexpected facet",
        {
          ...validSnapshot,
          symbols: [
            {
              ...validSymbol,
              contractFacets: {
                ...validSymbol.contractFacets,
                source: sentinel,
              },
            },
          ],
        },
      ],
      [
        "invalid facet hash",
        {
          ...validSnapshot,
          symbols: [
            {
              ...validSymbol,
              contractFacets: {
                ...validSymbol.contractFacets,
                parameters: sentinel,
              },
            },
          ],
        },
      ],
      [
        "invalid combined hash",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, contractFingerprint: sentinel }],
        },
      ],
      [
        "invalid implementation hash",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, implementationFingerprint: sentinel }],
        },
      ],
      [
        "invalid documentation string",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, documentationFingerprint: sentinel }],
        },
      ],
      [
        "invalid documentation type",
        {
          ...validSnapshot,
          symbols: [{ ...validSymbol, documentationFingerprint: 1 }],
        },
      ],
    ];

    for (const [label, output] of invalidOutputs) {
      const invalidParser = new PythonParser(async () => ({
        stdout: JSON.stringify(output),
        stderr: "",
      }));
      let thrown: unknown;
      try {
        await invalidParser.snapshot("src/client.py", "def request(): pass\n");
      } catch (error: unknown) {
        thrown = error;
      }
      if (thrown === undefined) {
        thrown = new Error(`Accepted ${label}: ${sentinel}`);
      }

      expect((thrown as Error).message).toMatch(
        /^Failed to parse Python source(?: \(local python3 is \d+\.\d+; the project may need a newer interpreter; set STALEDOCS_PYTHON to choose one\))?\.$/u,
      );
      expect(String(thrown)).not.toContain(sentinel);
      expect(String((thrown as Error).cause)).not.toContain(sentinel);
    }
  });

  // Break caught: child stderr or retained process errors expose in-memory source.
  it("sanitizes snapshot runner failures without retaining source or stderr", async () => {
    const sourceSentinel = ["sk", "runner-source", "R".repeat(32)].join("-");
    const stderrSentinel = ["sk", "runner-stderr", "S".repeat(32)].join("-");
    const failingParser = new PythonParser(async () => {
      throw Object.assign(new Error(`failure: ${sourceSentinel}`), {
        stderr: `traceback: ${stderrSentinel}`,
      });
    });

    let thrown: unknown;
    try {
      await failingParser.snapshot(
        "src/client.py",
        `def request():\n    return "${sourceSentinel}"\n`,
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /^Failed to parse Python source(?: \(local python3 is \d+\.\d+; the project may need a newer interpreter; set STALEDOCS_PYTHON to choose one\))?\.$/u,
    );
    expect(String(thrown)).not.toContain(sourceSentinel);
    expect(String(thrown)).not.toContain(stderrSentinel);
    expect(String((thrown as Error).cause)).not.toContain(sourceSentinel);
    expect(String((thrown as Error).cause)).not.toContain(stderrSentinel);
  });
});
