import {
  ArrowFunction,
  ClassDeclaration,
  ConstructorDeclaration,
  EnumDeclaration,
  FunctionDeclaration,
  FunctionExpression,
  GetAccessorDeclaration,
  InterfaceDeclaration,
  MethodSignature,
  Node,
  Project,
  PropertyDeclaration,
  SetAccessorDeclaration,
  SourceFile,
  Scope,
  MethodDeclaration,
  ParameterDeclaration,
  FileSystemRefreshResult,
  SyntaxKind,
  ScriptKind,
  TypeAliasDeclaration,
  VariableDeclaration,
} from "ts-morph";
import { sha256Hex } from "../impact/canonical";
import {
  ContractFacet,
  ParserModuleSnapshot,
  ReexportEdge,
  ParserSymbolSnapshot,
  SymbolKind,
} from "../impact/types";
import {
  LanguageParser,
  ParsedModule,
  FunctionInfo,
  ClassInfo,
  TypeInfo,
  VariableInfo,
  MethodInfo,
  ImportStatement,
  ParameterInfo,
} from "./types";

// One shared Project for the whole process — avoids re-booting the
// TypeScript compiler for every file (was a major perf bottleneck:
// 100 files meant 100 compiler initializations).
let sharedProject: Project | null = null;

/** Parses TypeScript and JavaScript files using ts-morph AST metadata. */
export class TypeScriptParser implements LanguageParser {
  readonly name = "typescript";
  readonly supportedExtensions = [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
  ];

  /** Visible for tests: how many times the Project has been constructed. */
  static sharedProjectCount = 0;

  private getProject(): Project {
    if (!sharedProject) {
      sharedProject = new Project({
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true, allowNonTsExtensions: true },
      });
      TypeScriptParser.sharedProjectCount++;
    }
    return sharedProject;
  }

  /** Parses a source file into exported functions, classes, types, and imports. */
  async parse(filePath: string): Promise<ParsedModule> {
    const project = this.getProject();
    let sourceFile = project.getSourceFile(filePath);
    if (sourceFile) {
      const refreshResult = await sourceFile.refreshFromFileSystem();
      if (refreshResult === FileSystemRefreshResult.Deleted) {
        throw new Error(`File not found: ${filePath}`);
      }
    } else {
      sourceFile = project.addSourceFileAtPath(filePath);
    }

    try {
      this.assertNoSyntacticDiagnostics(project, sourceFile);
    } catch (error: unknown) {
      project.removeSourceFile(sourceFile);
      throw error;
    }

    return this.extractParsedModule(filePath, sourceFile);
  }

  /** Parses supplied source text in an isolated in-memory project. */
  async parseSource(filePath: string, source: string): Promise<ParsedModule> {
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, allowNonTsExtensions: true },
    });
    const sourceFile = project.createSourceFile(filePath, source, {
      scriptKind: /\.(?:mjs|cjs)$/iu.test(filePath) ? ScriptKind.JS : undefined,
    });
    this.assertNoSyntacticDiagnostics(project, sourceFile);

    return this.extractParsedModule(filePath, sourceFile);
  }

  /** Creates a value-free public API snapshot from in-memory source text. */
  async snapshot(
    filePath: string,
    source: string,
  ): Promise<ParserModuleSnapshot> {
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, allowNonTsExtensions: true },
    });
    const sourceFile = project.createSourceFile(filePath, source, {
      scriptKind: /\.(?:mjs|cjs)$/iu.test(filePath) ? ScriptKind.JS : undefined,
    });
    const moduleSystem = detectModuleSystem(sourceFile);
    const diagnostics = project
      .getProgram()
      .getSyntacticDiagnostics(sourceFile);
    if (diagnostics.length > 0) {
      throw new Error("TypeScript syntax error.");
    }

    return {
      language: "typescript",
      dependencyFingerprint: fingerprint(
        sortNormalized([
          ...sourceFile
            .getImportDeclarations()
            .map((declaration) =>
              normalizeAst(declaration.getModuleSpecifier()),
            ),
          ...sourceFile
            .getExportDeclarations()
            .map((declaration) => declaration.getModuleSpecifier())
            .filter(isPresent)
            .map((specifier) => normalizeAst(specifier)),
        ]),
      ),
      symbols:
        moduleSystem === "commonjs" && isJavaScriptModulePath(filePath)
          ? []
          : extractSnapshotSymbols(sourceFile),
      reexports: extractReexports(sourceFile),
      exports:
        moduleSystem === "commonjs" && isJavaScriptModulePath(filePath)
          ? []
          : extractExportNames(sourceFile),
      moduleSystem,
    };
  }

  private assertNoSyntacticDiagnostics(
    project: Project,
    sourceFile: SourceFile,
  ): void {
    const diagnostics = project
      .getProgram()
      .getSyntacticDiagnostics(sourceFile);
    if (diagnostics.length > 0) {
      // Compiler diagnostics can quote source fragments. Keep the parser boundary
      // value-free so analyzer, freshness, CLI, and MCP consumers stay safe.
      throw new Error("TypeScript syntax error.");
    }
  }

  private extractParsedModule(
    filePath: string,
    sourceFile: SourceFile,
  ): ParsedModule {
    return {
      filePath,
      language: "typescript",
      functions: this.extractFunctions(sourceFile),
      classes: this.extractClasses(sourceFile),
      types: this.extractTypes(sourceFile),
      variables: this.extractVariables(sourceFile),
      imports: this.extractImports(sourceFile),
    };
  }

  private extractFunctions(sf: SourceFile): FunctionInfo[] {
    return enumerateExports(sf)
      .filter(isCallableBinding)
      .map(({ exportedName, declaration, statement }) => {
        const params = declaration.getParameters().map(
          (parameter) =>
            ({
              name: parameter.getName(),
              type: parameter.getType().getText(parameter),
              isOptional: parameter.isOptional(),
              defaultValue: parameter.getInitializer()?.getText(),
            }) as ParameterInfo,
        );
        const renderedParameters = declaration
          .getParameters()
          .map((parameter) => parameter.getText())
          .join(", ");
        const returnType = declaration.getReturnType().getText(declaration);
        return {
          name: exportedName,
          parameters: params,
          returnType,
          isAsync: Node.isAsyncable(declaration) && declaration.isAsync(),
          isExported: true,
          lineRange: [
            statement.getStartLineNumber(),
            statement.getEndLineNumber(),
          ] as [number, number],
          existingDoc: getDocDescription(statement),
          signature: `${exportedName}(${renderedParameters}): ${returnType}`,
        };
      });
  }

  private extractClasses(sf: SourceFile): ClassInfo[] {
    return enumerateExports(sf)
      .filter(isClassBinding)
      .map(
        ({ exportedName, declaration, statement }) =>
          ({
            name: exportedName,
            extends: declaration.getExtends()?.getText(),
            implements: declaration
              .getImplements()
              .map((heritage) => heritage.getText()),
            methods: declaration
              .getMethods()
              .map((method) => this.mapMethod(method)),
            properties: declaration.getProperties().map((property) => ({
              name: property.getName(),
              type: property.getType().getText(property),
              visibility: this.getScope(property.getScope()),
              isStatic: property.isStatic(),
              isReadonly: property.isReadonly(),
            })),
            isExported: true,
            lineRange: [
              statement.getStartLineNumber(),
              statement.getEndLineNumber(),
            ] as [number, number],
            existingDoc: getDocDescription(statement),
          }) as ClassInfo,
      );
  }

  private mapMethod(m: MethodDeclaration): MethodInfo {
    return {
      name: m.getName(),
      parameters: m.getParameters().map(
        (p: ParameterDeclaration) =>
          ({
            name: p.getName(),
            type: p.getType().getText(p),
            isOptional: p.isOptional(),
          }) as ParameterInfo,
      ),
      returnType: m.getReturnType().getText(m),
      isAsync: m.isAsync(),
      isExported: true,
      lineRange: [m.getStartLineNumber(), m.getEndLineNumber()] as [
        number,
        number,
      ],
      existingDoc: m.getJsDocs()[0]?.getDescription().trim(),
      signature: m.getText().split("{")[0].trim(),
      visibility: this.getScope(m.getScope()),
      isStatic: m.isStatic(),
    };
  }

  private getScope(scope?: Scope): "public" | "private" | "protected" {
    if (scope === Scope.Private) return "private";
    if (scope === Scope.Protected) return "protected";
    return "public";
  }

  private extractTypes(sf: SourceFile): TypeInfo[] {
    const types: TypeInfo[] = [];
    for (const { exportedName, declaration, statement } of enumerateExports(
      sf,
    )) {
      const existingDoc = getDocDescription(statement);
      if (Node.isInterfaceDeclaration(declaration)) {
        types.push({
          name: exportedName,
          kind: "interface",
          isExported: true,
          properties: declaration.getProperties().map((property) => ({
            name: property.getName(),
            type: property.getType().getText(property),
            isOptional: property.hasQuestionToken(),
          })),
          lineRange: [
            statement.getStartLineNumber(),
            statement.getEndLineNumber(),
          ],
          existingDoc,
        });
      } else if (Node.isTypeAliasDeclaration(declaration)) {
        types.push({
          name: exportedName,
          kind: "type",
          isExported: true,
          properties: [],
          lineRange: [
            statement.getStartLineNumber(),
            statement.getEndLineNumber(),
          ],
          existingDoc,
        });
      } else if (Node.isEnumDeclaration(declaration)) {
        types.push({
          name: exportedName,
          kind: "enum",
          isExported: true,
          properties: declaration.getMembers().map((member) => ({
            name: member.getName(),
            type: member.getValue()?.toString(),
            isOptional: false,
          })),
          lineRange: [
            statement.getStartLineNumber(),
            statement.getEndLineNumber(),
          ],
          existingDoc,
        });
      }
    }
    return types;
  }

  private extractVariables(sf: SourceFile): VariableInfo[] {
    return enumerateExports(sf)
      .filter(
        ({ declaration, callable }) =>
          !callable &&
          (Node.isVariableDeclaration(declaration) ||
            (Node.isExpression(declaration) &&
              declaration.getParentIfKind(SyntaxKind.ExportAssignment) !==
                undefined)),
      )
      .map(({ exportedName, declaration, statement }) => {
        const variable = Node.isVariableDeclaration(declaration)
          ? declaration
          : undefined;
        return {
          name: exportedName,
          type: variable?.getTypeNode()?.getText(),
          declarationKind: getVariableDeclarationKind(statement) ?? "const",
          isExported: true,
          lineRange: [
            statement.getStartLineNumber(),
            statement.getEndLineNumber(),
          ],
          existingDoc: getDocDescription(statement),
        };
      });
  }

  private extractImports(sf: SourceFile): ImportStatement[] {
    return sf.getImportDeclarations().map((imp) => ({
      source: imp.getModuleSpecifierValue(),
      names: imp.getNamedImports().map((n) => n.getName()),
      isDefault: !!imp.getDefaultImport(),
    }));
  }
}
function detectModuleSystem(
  sourceFile: SourceFile,
): NonNullable<ParserModuleSnapshot["moduleSystem"]> {
  if (
    sourceFile.getImportDeclarations().length > 0 ||
    sourceFile.getExportDeclarations().length > 0 ||
    sourceFile.getExportAssignments().length > 0 ||
    sourceFile.getExportedDeclarations().size > 0
  ) {
    return "esm";
  }
  for (const statement of sourceFile.getStatements()) {
    if (!Node.isExpressionStatement(statement)) continue;
    if (isCommonJsExpression(statement.getExpression())) return "commonjs";
    const expression = unwrapParentheses(statement.getExpression());
    if (!Node.isCallExpression(expression)) continue;
    const callee = unwrapParentheses(expression.getExpression());
    if (!Node.isArrowFunction(callee) && !Node.isFunctionExpression(callee)) {
      continue;
    }
    const body = callee.getBody();
    if (!Node.isBlock(body)) continue;
    if (
      body
        .getStatements()
        .some(
          (nested) =>
            Node.isExpressionStatement(nested) &&
            isCommonJsExpression(nested.getExpression()),
        )
    ) {
      return "commonjs";
    }
  }
  return "none";
}

function isCommonJsExpression(expression: Node): boolean {
  const candidate = unwrapParentheses(expression);
  if (Node.isBinaryExpression(candidate)) {
    return (
      candidate.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      isCommonJsAssignmentTarget(candidate.getLeft())
    );
  }
  if (!Node.isCallExpression(candidate)) return false;
  const callee = unwrapParentheses(candidate.getExpression());
  if (
    !Node.isPropertyAccessExpression(callee) ||
    callee.getName() !== "defineProperty" ||
    !Node.isIdentifier(callee.getExpression()) ||
    callee.getExpression().getText() !== "Object"
  ) {
    return false;
  }
  const target = candidate.getArguments()[0];
  return target !== undefined && isCommonJsExportObject(target);
}

function isCommonJsAssignmentTarget(expression: Node): boolean {
  const candidate = unwrapParentheses(expression);
  if (!Node.isPropertyAccessExpression(candidate)) return false;
  const owner = candidate.getExpression();
  return (
    (Node.isIdentifier(owner) && owner.getText() === "exports") ||
    isModuleExports(owner) ||
    isModuleExports(candidate)
  );
}

function isCommonJsExportObject(expression: Node): boolean {
  const candidate = unwrapParentheses(expression);
  return (
    (Node.isIdentifier(candidate) && candidate.getText() === "exports") ||
    isModuleExports(candidate)
  );
}

function isModuleExports(expression: Node): boolean {
  const candidate = unwrapParentheses(expression);
  return (
    Node.isPropertyAccessExpression(candidate) &&
    candidate.getName() === "exports" &&
    Node.isIdentifier(candidate.getExpression()) &&
    candidate.getExpression().getText() === "module"
  );
}

function unwrapParentheses(node: Node): Node {
  let current = node;
  while (Node.isParenthesizedExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

function isJavaScriptModulePath(filePath: string): boolean {
  return /\.(?:js|jsx|mjs|cjs)$/iu.test(filePath);
}

/** Declared members of one exported TypeScript class or interface. */
export interface DeclaredTypeMembers {
  /** The exported name, as snapshots and boundary resolution use it. */
  name: string;
  kind: "class" | "interface";
  /** Every declared member name of any visibility, static or instance. */
  members: string[];
  /**
   * False when members can come from elsewhere: a heritage clause, an index
   * signature, a computed member name, or more than one declaration.
   */
  closed: boolean;
}

/**
 * Lists declared member names of exported classes and interfaces in
 * TypeScript source. JavaScript sources return nothing: their instances gain
 * members through assignments that are not declarations.
 */
export function listDeclaredTypeMembers(
  filePath: string,
  source: string,
): DeclaredTypeMembers[] {
  if (!/\.(?:ts|tsx|mts|cts)$/iu.test(filePath)) return [];
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  const sourceFile = project.createSourceFile(filePath, source);
  if (project.getProgram().getSyntacticDiagnostics(sourceFile).length > 0) {
    throw new Error("TypeScript syntax error.");
  }
  const exportedDeclarations = sourceFile.getExportedDeclarations();
  const byName = new Map<string, DeclaredTypeMembers>();
  for (const binding of enumerateExports(sourceFile)) {
    const declaration = binding.declaration;
    if (
      !Node.isClassDeclaration(declaration) &&
      !Node.isInterfaceDeclaration(declaration)
    ) {
      continue;
    }
    const declarationCount = Math.max(
      exportedDeclarations.get(binding.exportName)?.length ?? 0,
      declaration.getSymbol()?.getDeclarations().length ?? 0,
    );
    const declared = declaredMemberNames(declaration);
    const previous = byName.get(binding.exportedName);
    byName.set(binding.exportedName, {
      name: binding.exportedName,
      kind: Node.isClassDeclaration(declaration) ? "class" : "interface",
      members: [...new Set([...(previous?.members ?? []), ...declared.names])],
      closed:
        previous === undefined && declarationCount <= 1 && declared.closed,
    });
  }
  return [...byName.values()]
    .map((entry) => ({ ...entry, members: [...entry.members].sort(compareText) }))
    .sort((left, right) => compareText(left.name, right.name));
}

function declaredMemberNames(
  declaration: ClassDeclaration | InterfaceDeclaration,
): { names: string[]; closed: boolean } {
  const names: string[] = [];
  // ts-morph omits class index signatures from getMembers(), so read the AST.
  let closed =
    (Node.isClassDeclaration(declaration)
      ? declaration.getExtends() === undefined
      : declaration.getExtends().length === 0) &&
    !declaration.compilerNode.members.some(
      (member) => member.kind === SyntaxKind.IndexSignature,
    );
  for (const member of declaration.getMembers()) {
    if (Node.isConstructorDeclaration(member)) {
      for (const parameter of member.getParameters()) {
        if (parameter.isParameterProperty()) names.push(parameter.getName());
      }
    } else if (Node.isPropertyNamed(member)) {
      const nameNode = member.getNameNode();
      if (Node.isComputedPropertyName(nameNode)) {
        closed = false;
      } else if (
        Node.isStringLiteral(nameNode) ||
        Node.isNoSubstitutionTemplateLiteral(nameNode)
      ) {
        names.push(nameNode.getLiteralValue());
      } else {
        names.push(nameNode.getText());
      }
    }
  }
  return { names, closed };
}
type AstTuple = [kind: number, text: string | null, children: AstTuple[]];
type CallableDeclaration =
  | FunctionDeclaration
  | MethodDeclaration
  | ArrowFunction
  | FunctionExpression;
type OverloadableCallable = FunctionDeclaration | MethodDeclaration;
interface ExportedBinding {
  exportedName: string;
  declaration: Node;
  statement: Node;
  callable: boolean;
  exportName: string;
}
function enumerateExports(sourceFile: SourceFile): ExportedBinding[] {
  const bindings: ExportedBinding[] = [];
  for (const [
    exportedName,
    declarations,
  ] of sourceFile.getExportedDeclarations()) {
    for (const declaration of declarations) {
      if (
        declaration.getSourceFile() !== sourceFile ||
        Node.isSourceFile(declaration) ||
        Node.isModuleDeclaration(declaration)
      )
        continue;
      const variable = Node.isVariableDeclaration(declaration)
        ? declaration
        : undefined;
      const initializer = variable?.getInitializer();
      const statement =
        variable?.getVariableStatement() ??
        (Node.isExpression(declaration)
          ? declaration.getParentIfKind(SyntaxKind.ExportAssignment)
          : undefined) ??
        declaration;
      if (statement === undefined) continue;
      const callable =
        Node.isFunctionDeclaration(declaration) ||
        Node.isArrowFunction(declaration) ||
        Node.isFunctionExpression(declaration) ||
        (initializer !== undefined &&
          (Node.isArrowFunction(initializer) ||
            Node.isFunctionExpression(initializer)));
      const publicName =
        exportedName === "default" &&
        Node.isExportable(declaration) &&
        declaration.hasDefaultKeyword() &&
        Node.hasName(declaration)
          ? (declaration.getName() ?? exportedName)
          : exportedName;
      bindings.push({
        exportName: exportedName,
        exportedName: publicName,
        declaration:
          initializer !== undefined &&
          (Node.isArrowFunction(initializer) ||
            Node.isFunctionExpression(initializer))
            ? initializer
            : declaration,
        statement,
        callable,
      });
    }
  }
  return bindings.sort((left, right) =>
    compareText(left.exportedName, right.exportedName),
  );
}

function extractExportNames(
  sourceFile: SourceFile,
): { exported: string; symbol: string }[] {
  return enumerateExports(sourceFile)
    .map(({ exportName, exportedName }) => ({
      exported: exportName,
      symbol: exportedName,
    }))
    .filter(
      (value, index, values) =>
        index ===
        values.findIndex(
          (candidate) =>
            candidate.exported === value.exported &&
            candidate.symbol === value.symbol,
        ),
    )
    .sort(
      (left, right) =>
        compareText(left.exported, right.exported) ||
        compareText(left.symbol, right.symbol),
    );
}

function extractReexports(sourceFile: SourceFile): ReexportEdge[] {
  return sourceFile
    .getExportDeclarations()
    .flatMap((declaration): ReexportEdge[] => {
      const specifier = declaration.getModuleSpecifierValue();
      if (
        specifier === undefined ||
        (!specifier.startsWith("./") && !specifier.startsWith("../"))
      ) {
        return [];
      }
      const namespace = declaration.getNamespaceExport();
      if (namespace !== undefined) {
        return [
          {
            specifier,
            names: [{ exported: namespace.getName(), local: "*" }],
          },
        ];
      }
      const named = declaration.getNamedExports();
      if (named.length === 0) return [{ specifier }];
      return [
        {
          specifier,
          names: named
            .map((element) => ({
              exported: element.getAliasNode()?.getText() ?? element.getName(),
              local: element.getName(),
            }))
            .sort(
              (left, right) =>
                compareText(left.exported, right.exported) ||
                compareText(left.local, right.local),
            ),
        },
      ];
    })
    .sort(
      (left, right) =>
        compareText(left.specifier, right.specifier) ||
        compareText(JSON.stringify(left.names), JSON.stringify(right.names)),
    );
}
function getDocDescription(node: Node): string | undefined {
  if (!Node.isJSDocable(node)) return undefined;
  const docs = node.getJsDocs();
  return docs.length === 0 ? undefined : docs[0].getDescription().trim();
}
function isCallableBinding(
  binding: ExportedBinding,
): binding is ExportedBinding & { declaration: CallableDeclaration } {
  return binding.callable;
}
function isClassBinding(
  binding: ExportedBinding,
): binding is ExportedBinding & { declaration: ClassDeclaration } {
  return Node.isClassDeclaration(binding.declaration);
}
function asVariableDeclaration(node: Node): VariableDeclaration {
  if (!Node.isVariableDeclaration(node))
    throw new Error("Expected variable declaration");
  return node;
}
function getVariableDeclarationKind(
  node: Node,
): "const" | "let" | "var" | undefined {
  if (!Node.isVariableStatement(node)) return undefined;
  const kind = node.getDeclarationKind();
  return kind === "const" || kind === "let" || kind === "var"
    ? kind
    : undefined;
}

type PublicMethodDeclaration = MethodDeclaration | MethodSignature;
type PublicClassMember =
  | ConstructorDeclaration
  | GetAccessorDeclaration
  | MethodDeclaration
  | PropertyDeclaration
  | SetAccessorDeclaration;
const CONTRACT_FACET_ORDER: ContractFacet[] = [
  "parameters",
  "return",
  "inheritance",
  "members",
  "modifiers",
];
const DOCUMENTATION_EXCLUSIONS = new Set<SyntaxKind>([SyntaxKind.JSDoc]);

function extractSnapshotSymbols(
  sourceFile: SourceFile,
): ParserSymbolSnapshot[] {
  const symbols: ParserSymbolSnapshot[] = [];
  const methodContributions = new Map<string, MethodSnapshotContribution[]>();
  const bindings = enumerateExports(sourceFile);
  const callableGroups = new Map<string, ExportedBinding[]>();
  for (const binding of bindings) {
    if (!binding.callable) continue;
    const group = callableGroups.get(binding.exportedName);
    if (group === undefined)
      callableGroups.set(binding.exportedName, [binding]);
    else group.push(binding);
  }
  for (const [exportedName, group] of callableGroups) {
    symbols.push(
      callableSnapshot(
        "function",
        exportedName,
        group.map(({ declaration }) => declaration as CallableDeclaration),
        {
          documentationNodes: group.map(({ statement }) => statement),
          variableDeclarationKind:
            getVariableDeclarationKind(group[0].statement) ?? null,
        },
      ),
    );
  }
  for (const binding of bindings) {
    if (Node.isClassDeclaration(binding.declaration)) {
      symbols.push(classSnapshot(binding.declaration, binding.exportedName));
      const publicMethods = binding.declaration
        .getMethods()
        .filter(isPublicClassMember);
      for (const [methodIdentity, methods] of groupByMethodIdentity(
        publicMethods,
      )) {
        addMethodContribution(
          methodContributions,
          callableSnapshot(
            "method",
            binding.exportedName + "." + methodIdentity,
            expandCallableDeclarations(methods),
          ),
          true,
        );
      }
    }
  }
  const interfaceGroups = new Map<string, InterfaceDeclaration[]>();
  for (const binding of bindings) {
    if (!Node.isInterfaceDeclaration(binding.declaration)) continue;
    const group = interfaceGroups.get(binding.exportedName);
    if (group === undefined)
      interfaceGroups.set(binding.exportedName, [binding.declaration]);
    else group.push(binding.declaration);
  }
  for (const [exportedName, declarations] of interfaceGroups) {
    symbols.push(interfaceSnapshot(declarations, exportedName));
    for (const [methodIdentity, methods] of groupByMethodIdentity(
      declarations.flatMap((declaration) => declaration.getMethods()),
    )) {
      addMethodContribution(
        methodContributions,
        interfaceMethodSnapshot(exportedName + "." + methodIdentity, methods),
        false,
      );
    }
  }
  const typeAliases = new Set<string>();
  const enumGroups = new Map<string, EnumDeclaration[]>();
  for (const binding of bindings) {
    if (Node.isTypeAliasDeclaration(binding.declaration)) {
      if (!typeAliases.has(binding.exportedName)) {
        symbols.push(
          typeAliasSnapshot(binding.declaration, binding.exportedName),
        );
        typeAliases.add(binding.exportedName);
      }
    } else if (Node.isEnumDeclaration(binding.declaration)) {
      const group = enumGroups.get(binding.exportedName);
      if (group === undefined)
        enumGroups.set(binding.exportedName, [binding.declaration]);
      else group.push(binding.declaration);
    } else if (
      !binding.callable &&
      binding.declaration.getKind() === SyntaxKind.VariableDeclaration
    ) {
      symbols.push(variableSnapshot(binding));
    } else if (
      !binding.callable &&
      !Node.isClassDeclaration(binding.declaration) &&
      !Node.isInterfaceDeclaration(binding.declaration)
    ) {
      symbols.push(variableExpressionSnapshot(binding));
    }
  }
  for (const [exportedName, declarations] of enumGroups)
    symbols.push(enumSnapshot(declarations, exportedName));
  for (const contributions of methodContributions.values())
    symbols.push(mergeMethodContributions(contributions));
  return symbols.sort(
    (left, right) =>
      compareText(left.kind, right.kind) ||
      compareText(left.qualifiedName, right.qualifiedName),
  );
}

interface MethodSnapshotContribution {
  snapshot: ParserSymbolSnapshot;
  hasClassImplementation: boolean;
}

function addMethodContribution(
  contributions: Map<string, MethodSnapshotContribution[]>,
  snapshot: ParserSymbolSnapshot,
  hasClassImplementation: boolean,
): void {
  const contribution = { snapshot, hasClassImplementation };
  const existing = contributions.get(snapshot.qualifiedName);
  if (existing === undefined) {
    contributions.set(snapshot.qualifiedName, [contribution]);
  } else {
    existing.push(contribution);
  }
}

function mergeMethodContributions(
  contributions: MethodSnapshotContribution[],
): ParserSymbolSnapshot {
  if (contributions.length === 1) return contributions[0].snapshot;

  const contractFacets: Partial<Record<ContractFacet, string>> = {};
  for (const facet of CONTRACT_FACET_ORDER) {
    const hashes = uniqueSorted(
      contributions.flatMap(({ snapshot }) => {
        const hash = snapshot.contractFacets[facet];
        return typeof hash === "string" ? [hash] : [];
      }),
    );
    if (hashes.length > 0) {
      contractFacets[facet] =
        hashes.length === 1 ? hashes[0] : fingerprint(hashes);
    }
  }

  const contracts = uniqueSorted(
    contributions.map(({ snapshot }) => snapshot.contractFingerprint),
  );
  const implementations = uniqueSorted(
    contributions
      .filter(({ hasClassImplementation }) => hasClassImplementation)
      .map(({ snapshot }) => snapshot.implementationFingerprint),
  );
  const documentation = uniqueSorted(
    contributions.flatMap(({ snapshot }) =>
      snapshot.documentationFingerprint === null
        ? []
        : [snapshot.documentationFingerprint],
    ),
  );

  const mergedSignatures = uniqueSorted(
    contributions.map(({ snapshot }) => snapshot.signature),
  );
  const arities = contributions
    .map(({ snapshot }) => snapshot.arity)
    .filter(
      (arity): arity is { required: number; total: number } =>
        arity !== undefined,
    );

  return {
    language: "typescript",
    kind: "method",
    qualifiedName: contributions[0].snapshot.qualifiedName,
    signature: renderSignature(mergedSignatures.join(" | ")),
    arity: mergeArities(arities),
    contractFacets,
    contractFingerprint:
      contracts.length === 1
        ? contracts[0]
        : fingerprint(["mergedMethodContracts", contracts]),
    implementationFingerprint:
      implementations.length === 0
        ? fingerprint([])
        : implementations.length === 1
          ? implementations[0]
          : fingerprint(["mergedMethodImplementations", implementations]),
    documentationFingerprint:
      documentation.length === 0
        ? null
        : documentation.length === 1
          ? documentation[0]
          : fingerprint(documentation),
  };
}

function callableSnapshot(
  kind: "function" | "method",
  qualifiedName: string,
  declarations: CallableDeclaration[],
  options: {
    documentationNodes?: Node[];
    variableDeclarationKind?: "const" | "let" | "var" | null;
  } = {},
): ParserSymbolSnapshot {
  const overloadable = declarations.filter(
    (declaration): declaration is OverloadableCallable =>
      Node.isOverloadable(declaration),
  );
  const contractDeclarations = overloadable.some(
    (declaration) =>
      Node.isOverloadable(declaration) && declaration.isOverload(),
  )
    ? overloadable.filter((declaration) => declaration.isOverload())
    : declarations;
  const parameterShapes = sortNormalized(
    contractDeclarations.map((declaration) => [
      declaration
        .getTypeParameters()
        .map((parameter) => normalizeAst(parameter)),
      declaration.getParameters().map((parameter) => normalizeAst(parameter)),
    ]),
  );
  const returnShapes = sortNormalized(
    contractDeclarations.map((declaration) => {
      const returnType = declaration.getReturnTypeNode();
      return returnType === undefined ? null : normalizeAst(returnType);
    }),
  );
  const modifierShapes =
    options.variableDeclarationKind !== undefined &&
    declarations.every(
      (declaration) =>
        Node.isArrowFunction(declaration) ||
        Node.isFunctionExpression(declaration),
    )
      ? declarations.map((declaration) => [
          Node.isAsyncable(declaration) && declaration.isAsync(),
          Node.isGeneratorable(declaration) && declaration.isGenerator(),
          options.variableDeclarationKind,
        ])
      : sortNormalized(
          contractDeclarations.map((declaration) => [
            Node.isModifierable(declaration)
              ? declaration
                  .getModifiers()
                  .map((modifier) => normalizeAst(modifier))
              : [],
            Node.isGeneratorable(declaration) && declaration.isGenerator(),
            Node.isQuestionTokenable(declaration) &&
              declaration.getQuestionTokenNode() !== undefined,
          ]),
        );
  const signatureShapes = sortNormalized(
    contractDeclarations.map(normalizeDeclarationContract),
  );
  const contractFacets: Partial<Record<ContractFacet, string>> = {
    parameters: fingerprint(parameterShapes),
    modifiers: fingerprint(modifierShapes),
  };
  if (
    contractDeclarations.some((declaration) => declaration.getReturnTypeNode())
  ) {
    contractFacets.return = fingerprint(returnShapes);
  }

  return {
    language: "typescript",
    kind,
    qualifiedName,
    signature: renderCallableSignatures(qualifiedName, contractDeclarations),
    arity: mergeArities(contractDeclarations.map(callableArity)),
    contractFacets,
    contractFingerprint: fingerprint(["callable", signatureShapes]),
    implementationFingerprint: fingerprint(
      sortNormalized(
        declarations.flatMap((declaration) => {
          const body = Node.isBodyable(declaration)
            ? declaration.getBody()
            : Node.isArrowFunction(declaration) ||
                Node.isFunctionExpression(declaration)
              ? declaration.getBody()
              : undefined;
          if (body === undefined) return [];
          return [
            [
              contractDeclarations.length === declarations.length
                ? null
                : runtimeCallableDeclarationShape(declaration),
              normalizeAst(body),
            ],
          ];
        }),
      ),
    ),
    documentationFingerprint: documentationFingerprint(
      options.documentationNodes ?? declarations,
    ),
  };
}

function interfaceMethodSnapshot(
  qualifiedName: string,
  declarations: MethodSignature[],
): ParserSymbolSnapshot {
  const parameterShapes = sortNormalized(
    declarations.map((declaration) => [
      declaration
        .getTypeParameters()
        .map((parameter) => normalizeAst(parameter)),
      declaration.getParameters().map((parameter) => normalizeAst(parameter)),
    ]),
  );
  const returnShapes = sortNormalized(
    declarations.map((declaration) => {
      const returnType = declaration.getReturnTypeNode();
      return returnType === undefined ? null : normalizeAst(returnType);
    }),
  );
  const modifierShapes = sortNormalized(
    declarations.map((declaration) => [
      declaration.getQuestionTokenNode() !== undefined,
    ]),
  );
  const signatureShapes = sortNormalized(
    declarations.map(normalizeDeclarationContract),
  );
  const contractFacets: Partial<Record<ContractFacet, string>> = {
    parameters: fingerprint(parameterShapes),
    modifiers: fingerprint(modifierShapes),
  };
  if (declarations.some((declaration) => declaration.getReturnTypeNode())) {
    contractFacets.return = fingerprint(returnShapes);
  }

  return {
    language: "typescript",
    kind: "method",
    qualifiedName,
    signature: renderCallableSignatures(qualifiedName, declarations),
    arity: mergeArities(declarations.map(callableArity)),
    contractFacets,
    contractFingerprint: fingerprint(["callable", signatureShapes]),
    implementationFingerprint: fingerprint([]),
    documentationFingerprint: documentationFingerprint(declarations),
  };
}

function classSnapshot(
  declaration: ClassDeclaration,
  qualifiedName: string,
): ParserSymbolSnapshot {
  const modifierShape = declaration
    .getModifiers()
    .map((modifier) => normalizeAst(modifier));
  const inheritanceShape = declaration
    .getHeritageClauses()
    .map((clause) => normalizeAst(clause));
  const memberShape = publicClassMemberShapes(declaration);
  const contractFacets: Partial<Record<ContractFacet, string>> = {
    members: fingerprint(memberShape),
    modifiers: fingerprint(modifierShape),
  };
  if (inheritanceShape.length > 0) {
    contractFacets.inheritance = fingerprint(inheritanceShape);
  }

  return {
    language: "typescript",
    kind: "class",
    qualifiedName,
    signature: renderClassSignature(declaration, qualifiedName),
    contractFacets,
    contractFingerprint: combinedContractFingerprint("class", contractFacets),
    implementationFingerprint: fingerprint(
      classImplementationShape(declaration),
    ),
    documentationFingerprint: documentationFingerprint([
      declaration,
      ...expandCallableDeclarations(
        declaration.getMethods().filter(isPublicClassMember),
      ),
      ...declaration.getProperties().filter(isPublicClassMember),
      ...declaration.getGetAccessors().filter(isPublicClassMember),
      ...declaration.getSetAccessors().filter(isPublicClassMember),
      ...expandConstructorDeclarations(
        declaration.getConstructors().filter(isPublicClassMember),
      ),
    ]),
  };
}

function interfaceSnapshot(
  declarations: InterfaceDeclaration[],
  qualifiedName: string,
): ParserSymbolSnapshot {
  const modifiers = uniqueNormalized(
    declarations.flatMap((declaration) =>
      declaration.getModifiers().map((modifier) => normalizeAst(modifier)),
    ),
  );
  const inheritance = uniqueNormalized(
    declarations.flatMap((declaration) =>
      declaration
        .getExtends()
        .map((heritageType) => normalizeAst(heritageType)),
    ),
  );
  const typeParameterLists = uniqueNormalized(
    declarations
      .map((declaration) =>
        declaration
          .getTypeParameters()
          .map((parameter) => normalizeAst(parameter)),
      )
      .filter((parameters) => parameters.length > 0),
  );
  const members = uniqueNormalized([
    ...typeParameterLists.map((parameters) => ["typeParameters", parameters]),
    ...declarations.flatMap((declaration) =>
      declaration.getMembers().map(normalizeDeclarationContract),
    ),
  ]);
  const contractFacets: Partial<Record<ContractFacet, string>> = {
    members: fingerprint(members),
    modifiers: fingerprint(modifiers),
  };
  if (inheritance.length > 0) {
    contractFacets.inheritance = fingerprint(inheritance);
  }

  return declarationSnapshot(
    "interface",
    qualifiedName,
    contractFacets,
    documentationFingerprint(
      declarations.flatMap((declaration) => [
        declaration,
        ...declaration.getMembers(),
      ]),
    ),
    renderInterfaceSignature(declarations, qualifiedName),
  );
}

function typeAliasSnapshot(
  declaration: TypeAliasDeclaration,
  qualifiedName: string,
): ParserSymbolSnapshot {
  const contractFacets: Partial<Record<ContractFacet, string>> = {
    members: fingerprint([
      declaration
        .getTypeParameters()
        .map((parameter) => normalizeAst(parameter)),
      normalizeAst(declaration.getTypeNodeOrThrow()),
    ]),
    modifiers: fingerprint(
      declaration.getModifiers().map((modifier) => normalizeAst(modifier)),
    ),
  };
  return declarationSnapshot(
    "type",
    qualifiedName,
    contractFacets,
    documentationFingerprint([declaration]),
    renderSignature(
      `type ${qualifiedName}${
        declaration.getTypeParameters().length === 0
          ? ""
          : `<${declaration
              .getTypeParameters()
              .map((parameter) => parameter.getText())
              .join(", ")}>`
      } = ${declaration.getTypeNodeOrThrow().getText().slice(0, 200)}`,
    ),
  );
}

function enumSnapshot(
  declarations: EnumDeclaration[],
  qualifiedName: string,
): ParserSymbolSnapshot {
  const contractFacets: Partial<Record<ContractFacet, string>> = {
    members: fingerprint(
      sortNormalized(
        declarations.map((declaration) =>
          declaration.getMembers().map(normalizeDeclarationContract),
        ),
      ),
    ),
    modifiers: fingerprint(
      sortNormalized(
        declarations.map((declaration) =>
          declaration.getModifiers().map((modifier) => normalizeAst(modifier)),
        ),
      ),
    ),
  };
  const memberNames = [
    ...new Set(
      declarations.flatMap((declaration) =>
        declaration.getMembers().map((member) => member.getName()),
      ),
    ),
  ].sort(compareText);
  return declarationSnapshot(
    "enum",
    qualifiedName,
    contractFacets,
    documentationFingerprint(
      declarations.flatMap((declaration) => [
        declaration,
        ...declaration.getMembers(),
      ]),
    ),
    renderSignature(`enum ${qualifiedName} { ${memberNames.join(", ")} }`),
  );
}

function variableSnapshot(binding: ExportedBinding): ParserSymbolSnapshot {
  const declaration = asVariableDeclaration(binding.declaration);
  const statement = declaration.getVariableStatement();
  if (statement === undefined) throw new Error("Expected variable statement");
  const initializer = declaration.getInitializer();
  let memberShape: unknown = null;
  if (declaration.getTypeNode() !== undefined)
    memberShape = normalizeAst(declaration.getTypeNode()!);
  else if (
    initializer !== undefined &&
    Node.isObjectLiteralExpression(initializer)
  )
    memberShape = initializer
      .getProperties()
      .map((property) =>
        Node.hasName(property) ? property.getName() : property.getKindName(),
      )
      .sort(compareText);
  const facets: Partial<Record<ContractFacet, string | null>> = {
    modifiers: fingerprint([
      statement.getDeclarationKind(),
      statement.hasDeclareKeyword(),
    ]),
    members: memberShape === null ? null : fingerprint(memberShape),
  };
  return {
    language: "typescript",
    kind: "variable",
    qualifiedName: binding.exportedName,
    signature: renderVariableSignature(
      binding.exportedName,
      declaration,
      statement.getDeclarationKind(),
      initializer,
    ),
    contractFacets: facets,
    contractFingerprint: combinedContractFingerprint("variable", facets),
    implementationFingerprint:
      initializer === undefined
        ? fingerprint([])
        : fingerprint(normalizeAst(initializer)),
    documentationFingerprint: documentationFingerprint([statement]),
  };
}

function variableExpressionSnapshot(
  binding: ExportedBinding,
): ParserSymbolSnapshot {
  const expression = binding.declaration;
  const facets: Partial<Record<ContractFacet, string | null>> = {
    modifiers: fingerprint(["const", false]),
    members: null,
  };
  return {
    language: "typescript",
    kind: "variable",
    qualifiedName: binding.exportedName,
    signature: renderSignature(`const ${binding.exportedName} = ...`),
    contractFacets: facets,
    contractFingerprint: combinedContractFingerprint("variable", facets),
    implementationFingerprint: fingerprint(normalizeAst(expression)),
    documentationFingerprint: documentationFingerprint([binding.statement]),
  };
}

function declarationSnapshot(
  kind: SymbolKind,
  qualifiedName: string,
  contractFacets: Partial<Record<ContractFacet, string>>,
  docs: string | null,
  signature = `${kind} ${qualifiedName}`,
): ParserSymbolSnapshot {
  return {
    language: "typescript",
    kind,
    qualifiedName,
    signature: renderSignature(signature),
    contractFacets,
    contractFingerprint: combinedContractFingerprint(kind, contractFacets),
    implementationFingerprint: fingerprint([]),
    documentationFingerprint: docs,
  };
}

function callableArity(declaration: CallableDeclaration | MethodSignature): {
  required: number;
  total: number;
} {
  const parameters = declaration.getParameters();
  return {
    required: parameters.filter(
      (parameter) =>
        !parameter.isOptional() &&
        parameter.getInitializer() === undefined &&
        !parameter.isRestParameter(),
    ).length,
    total: parameters.length,
  };
}

function mergeArities(
  arities: { required: number; total: number }[],
): { required: number; total: number } | undefined {
  if (arities.length === 0) return undefined;
  return {
    required: Math.min(...arities.map(({ required }) => required)),
    total: Math.max(...arities.map(({ total }) => total)),
  };
}

function renderSignature(value: string): string {
  const codePoints = Array.from(
    value.replace(/\s+/gu, " ").trim(),
    (character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : character;
    },
  );
  return codePoints.length <= 400
    ? codePoints.join("")
    : `${codePoints.slice(0, 397).join("")}...`;
}

function renderParameter(parameter: ParameterDeclaration): string {
  const name = parameter.isRestParameter()
    ? `...${parameter.getName()}`
    : parameter.getName();
  const optional =
    parameter.isOptional() && !parameter.isRestParameter() ? "?" : "";
  const type = parameter.getTypeNode()?.getText();
  const initializer = parameter.getInitializer();
  return `${name}${optional}${type === undefined ? "" : `: ${type}`}${initializer === undefined ? "" : ` = ${initializer.getText()}`}`;
}

function renderCallableSignatures(
  qualifiedName: string,
  declarations: (CallableDeclaration | MethodSignature)[],
): string {
  const name = qualifiedName.split(".").at(-1) ?? qualifiedName;
  return renderSignature(
    declarations
      .map((declaration) => {
        const typeParameters = declaration
          .getTypeParameters()
          .map((parameter) => parameter.getText())
          .join(", ");
        const generic = typeParameters.length > 0 ? `<${typeParameters}>` : "";
        const parameters = declaration
          .getParameters()
          .map(renderParameter)
          .join(", ");
        const returnType = renderCallableReturnType(declaration);
        const asyncPrefix =
          Node.isAsyncable(declaration) && declaration.isAsync()
            ? "async "
            : "";
        return `${asyncPrefix}${name}${generic}(${parameters}): ${returnType}`;
      })
      .join(" | "),
  );
}

function renderCallableReturnType(
  declaration: CallableDeclaration | MethodSignature,
): string {
  const declared = declaration.getReturnTypeNode();
  if (declared !== undefined) return declared.getText();

  const inferred = declaration.getReturnType().getBaseTypeOfLiteralType();
  if (inferred.isString()) return "string";
  if (inferred.isNumber()) return "number";
  if (inferred.isBoolean()) return "boolean";
  if (inferred.isBigInt()) return "bigint";
  if (inferred.isVoid()) return "void";
  if (inferred.isUndefined()) return "undefined";
  if (inferred.isNull()) return "null";
  if (inferred.isNever()) return "never";
  if (inferred.isUnknown()) return "unknown";
  if (inferred.isAny()) return "any";
  return "unknown";
}

function renderClassSignature(
  declaration: ClassDeclaration,
  qualifiedName: string,
): string {
  const typeParameters = declaration
    .getTypeParameters()
    .map((parameter) => parameter.getText())
    .join(", ");
  const generic = typeParameters.length > 0 ? `<${typeParameters}>` : "";
  const extendsType = declaration.getExtends()?.getText();
  const implementsTypes = declaration
    .getImplements()
    .map((heritage) => heritage.getText());
  return renderSignature(
    `class ${qualifiedName}${generic}${extendsType === undefined ? "" : ` extends ${extendsType}`}${implementsTypes.length === 0 ? "" : ` implements ${implementsTypes.join(", ")}`}`,
  );
}
function renderInterfaceSignature(
  declarations: InterfaceDeclaration[],
  qualifiedName: string,
): string {
  const typeParameters = [
    ...new Set(
      declarations.flatMap((declaration) =>
        declaration.getTypeParameters().map((parameter) => parameter.getText()),
      ),
    ),
  ];
  const generic =
    typeParameters.length > 0 ? `<${typeParameters.join(", ")}>` : "";
  const extendsTypes = [
    ...new Set(
      declarations.flatMap((declaration) =>
        declaration.getExtends().map((heritage) => heritage.getText()),
      ),
    ),
  ];
  return renderSignature(
    `interface ${qualifiedName}${generic}${extendsTypes.length === 0 ? "" : ` extends ${extendsTypes.join(", ")}`}`,
  );
}

function renderVariableSignature(
  name: string,
  declaration: VariableDeclaration,
  declarationKind: string,
  initializer: Node | undefined,
): string {
  const type = declaration.getTypeNode()?.getText();
  if (type !== undefined) {
    return renderSignature(`${declarationKind} ${name}: ${type}`);
  }
  if (
    initializer !== undefined &&
    Node.isObjectLiteralExpression(initializer)
  ) {
    const properties = initializer
      .getProperties()
      .map((property) =>
        Node.hasName(property) ? property.getName() : property.getKindName(),
      )
      .join(", ");
    return renderSignature(`${declarationKind} ${name} = { ${properties} }`);
  }
  return renderSignature(`${declarationKind} ${name} = ...`);
}

function publicClassMemberShapes(declaration: ClassDeclaration): unknown[] {
  const shapes: unknown[] = [
    [
      "typeParameters",
      declaration
        .getTypeParameters()
        .map((parameter) => normalizeAst(parameter)),
    ],
  ];

  for (const [methodIdentity, methods] of groupByMethodIdentity(
    declaration.getMethods().filter(isPublicClassMember),
  )) {
    const overloadGroup = expandCallableDeclarations(methods);
    const overloadMethods = overloadGroup.filter(
      (method): method is FunctionDeclaration | MethodDeclaration =>
        Node.isOverloadable(method),
    );
    const contracts = overloadMethods.some((method) => method.isOverload())
      ? overloadMethods.filter((method) => method.isOverload())
      : overloadGroup;
    shapes.push([
      "method",
      methodIdentity,
      sortNormalized(contracts.map(normalizeDeclarationContract)),
    ]);
  }
  for (const property of declaration
    .getProperties()
    .filter(isPublicClassMember)) {
    shapes.push([
      "property",
      normalizeAst(property.getNameNode()),
      property.getTypeNode() === undefined
        ? null
        : normalizeAst(property.getTypeNodeOrThrow()),
      property.getQuestionTokenNode() !== undefined,
      property.getExclamationTokenNode() !== undefined,
      property.getModifiers().map((modifier) => normalizeAst(modifier)),
    ]);
  }
  for (const accessor of [
    ...declaration.getGetAccessors(),
    ...declaration.getSetAccessors(),
  ].filter(isPublicClassMember)) {
    shapes.push([accessor.getKind(), normalizeDeclarationContract(accessor)]);
  }
  const constructors = declaration
    .getConstructors()
    .filter(isPublicClassMember);
  if (constructors.length > 0) {
    const overloadGroup = expandConstructorDeclarations(constructors);
    const contracts = overloadGroup.some((constructor) =>
      constructor.isOverload(),
    )
      ? overloadGroup.filter((constructor) => constructor.isOverload())
      : overloadGroup;
    shapes.push([
      "constructor",
      sortNormalized(contracts.map(normalizeDeclarationContract)),
    ]);
  }

  return sortNormalized(shapes);
}

function classImplementationShape(declaration: ClassDeclaration): unknown[] {
  const parts: unknown[] = [];
  for (const member of declaration.getMembers()) {
    if (Node.isMethodDeclaration(member)) {
      const body = member.getBody();
      if (body === undefined) continue;
      parts.push([
        "method",
        normalizeAst(member.getNameNode()),
        !isPublicClassMember(member) || member.getOverloads().length > 0
          ? runtimeCallableDeclarationShape(member)
          : null,
        normalizeAst(body),
      ]);
      continue;
    }
    if (Node.isConstructorDeclaration(member)) {
      const body = member.getBody();
      if (body === undefined) continue;
      parts.push([
        "constructor",
        !isPublicClassMember(member) || member.getOverloads().length > 0
          ? runtimeCallableDeclarationShape(member)
          : null,
        normalizeAst(body),
      ]);
      continue;
    }
    if (
      Node.isGetAccessorDeclaration(member) ||
      Node.isSetAccessorDeclaration(member)
    ) {
      const body = member.getBody();
      if (body === undefined) continue;
      parts.push([
        member.getKind(),
        normalizeAst(member.getNameNode()),
        isPublicClassMember(member)
          ? null
          : runtimeAccessorDeclarationShape(member),
        normalizeAst(body),
      ]);
      continue;
    }
    if (Node.isPropertyDeclaration(member)) {
      const initializer = member.getInitializer();
      parts.push([
        "property",
        normalizeAst(member.getNameNode()),
        member.isStatic(),
        initializer === undefined ? null : normalizeAst(initializer),
      ]);
      continue;
    }
    if (Node.isClassStaticBlockDeclaration(member)) {
      parts.push(["static", normalizeAst(member.getBody())]);
    }
  }
  return parts;
}

function combinedContractFingerprint(
  kind: SymbolKind,
  facets: Partial<Record<ContractFacet, string | null>>,
): string {
  return fingerprint([
    kind,
    CONTRACT_FACET_ORDER.flatMap((facet) =>
      facets[facet] === undefined ? [] : [[facet, facets[facet]]],
    ),
  ]);
}

function documentationFingerprint(nodes: Node[]): string | null {
  const docs = nodes
    .flatMap((node) => node.getLeadingCommentRanges())
    .map((comment) => comment.getText())
    .sort(compareText);
  return docs.length === 0 ? null : fingerprint(docs);
}

function isPublicClassMember(member: PublicClassMember): boolean {
  const scope = member.getScope();
  if (scope === Scope.Private || scope === Scope.Protected) return false;
  return !(
    Node.hasName(member) && Node.isPrivateIdentifier(member.getNameNode())
  );
}

function groupByMethodIdentity<T extends PublicMethodDeclaration>(
  declarations: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const declaration of declarations) {
    const identity = safeMethodIdentity(declaration);
    const group = groups.get(identity);
    if (group === undefined) groups.set(identity, [declaration]);
    else group.push(declaration);
  }
  return groups;
}

function safeMethodIdentity(declaration: PublicMethodDeclaration): string {
  const name = declaration.getNameNode();
  if (Node.isIdentifier(name)) return name.getText();
  return `[computed:${fingerprint(["methodName", normalizeAst(name)])}]`;
}

function expandCallableDeclarations(
  declarations: CallableDeclaration[],
): CallableDeclaration[] {
  const expanded: CallableDeclaration[] = [];
  for (const declaration of declarations) {
    if (Node.isOverloadable(declaration))
      expanded.push(...declaration.getOverloads());
    expanded.push(declaration);
  }
  return uniqueNodes(expanded);
}

function expandConstructorDeclarations(
  declarations: ConstructorDeclaration[],
): ConstructorDeclaration[] {
  return uniqueNodes(
    declarations.flatMap((declaration) => [
      ...declaration.getOverloads(),
      declaration,
    ]),
  );
}

function uniqueNodes<T extends Node>(nodes: T[]): T[] {
  const unique = new Map<number, T>();
  for (const node of nodes) unique.set(node.getStart(), node);
  return [...unique.values()];
}

function runtimeCallableDeclarationShape(
  declaration: CallableDeclaration | ConstructorDeclaration,
): unknown[] {
  return [
    Node.isAsyncable(declaration) && declaration.isAsync(),
    Node.isGeneratorable(declaration) && declaration.isGenerator(),
    Node.isStaticable(declaration) && declaration.isStatic(),
    Node.isDecoratable(declaration)
      ? declaration.getDecorators().map((decorator) => normalizeAst(decorator))
      : [],
    runtimeParameterShapes(declaration.getParameters()),
  ];
}

function runtimeAccessorDeclarationShape(
  declaration: GetAccessorDeclaration | SetAccessorDeclaration,
): unknown[] {
  return [
    declaration.isStatic(),
    declaration.getDecorators().map((decorator) => normalizeAst(decorator)),
    runtimeParameterShapes(declaration.getParameters()),
  ];
}

function runtimeParameterShapes(parameters: ParameterDeclaration[]): unknown[] {
  return parameters.map((parameter) => {
    const initializer = parameter.getInitializer();
    return [
      normalizeAst(parameter.getNameNode()),
      parameter.isRestParameter(),
      initializer === undefined ? null : normalizeAst(initializer),
      parameter.getDecorators().map((decorator) => normalizeAst(decorator)),
      parameter.isParameterProperty()
        ? parameter.getModifiers().map((modifier) => normalizeAst(modifier))
        : [],
    ];
  });
}

function normalizeDeclarationContract(node: Node): AstTuple {
  const body = Node.isBodyable(node)
    ? node.getBody()
    : Node.isArrowFunction(node) || Node.isFunctionExpression(node)
      ? node.getBody()
      : undefined;
  return normalizeAst(
    node,
    DOCUMENTATION_EXCLUSIONS,
    body === undefined ? new Set() : new Set([body]),
  );
}

function normalizeAst(
  node: Node,
  exclusions: ReadonlySet<SyntaxKind> = new Set(),
  excludedNodes: ReadonlySet<Node> = new Set(),
): AstTuple {
  const candidates = node
    .getChildren()
    .filter(
      (child) =>
        (child.getKind() !== SyntaxKind.SemicolonToken ||
          node.getKind() === SyntaxKind.ForStatement) &&
        !exclusions.has(child.getKind()) &&
        !excludedNodes.has(child),
    );
  const children = candidates
    .filter(
      (child, index) =>
        child.getKind() !== SyntaxKind.CommaToken ||
        index !== candidates.length - 1,
    )
    .map((child) => normalizeAst(child, exclusions, excludedNodes));
  return [
    node.getKind(),
    children.length === 0 ? normalizedLeafText(node) : null,
    children,
  ];
}

function normalizedLeafText(node: Node): string {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.getLiteralText();
  }
  if (Node.isNumericLiteral(node) || Node.isBigIntLiteral(node)) {
    return String(node.getLiteralValue());
  }
  return node.getText();
}

function fingerprint(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

function sortNormalized<T>(values: T[]): T[] {
  return values.sort((left, right) =>
    compareText(JSON.stringify(left), JSON.stringify(right)),
  );
}

function uniqueNormalized<T>(values: T[]): T[] {
  const unique = new Map<string, T>();
  for (const value of values) unique.set(JSON.stringify(value), value);
  return [...unique.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, value]) => value);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
