import {
  LanguageParser,
  ParsedModule,
  FunctionInfo,
  ClassInfo,
  ImportStatement,
  MethodInfo,
} from "./types";
import { execFile } from "child_process";
import * as fs from "fs";
import { isAbsolute } from "node:path";
import { getSafeAllowlistedErrorCode } from "../security/diagnostics";
import {
  ContractFacet,
  ParserModuleSnapshot,
  ParserSymbolSnapshot,
  ReexportEdge,
} from "../impact/types";

const PYTHON_UNAVAILABLE_CODES = new Set(["ENOENT"]);
const DEFAULT_PYTHON_EXECUTABLE = "python3";
const PYTHON_VERSION_SCRIPT = "import sys; print(sys.version_info[:2])";
const PYTHON_EXECUTION_TIMEOUT = 15000;
const PYTHON_EXECUTION_MAX_BUFFER = 10 * 1024 * 1024;
const SNAPSHOT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PYTHON_IDENTIFIER_PATTERN = /^(?:_|\p{ID_Start})(?:_|\p{ID_Continue})*$/u;
const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);
const SNAPSHOT_SYMBOL_KEYS = [
  "language",
  "kind",
  "qualifiedName",
  "signature",
  "arity",
  "contractFacets",
  "contractFingerprint",
  "implementationFingerprint",
  "documentationFingerprint",
] as const;

interface PythonProcessOptions {
  timeout: number;
  maxBuffer: number;
  input?: string;
}

type PythonProcessRunner = (
  command: string,
  args: string[],
  options: PythonProcessOptions,
) => Promise<{ stdout: string; stderr: string }>;

interface PythonVersion {
  major: number;
  minor: number;
}

const pythonVersionCache = new WeakMap<
  PythonProcessRunner,
  Map<string, Promise<PythonVersion | undefined>>
>();

function resolvePythonExecutable(): string {
  const configured = process.env.STALEDOCS_PYTHON;
  if (configured === undefined || configured.length === 0) {
    return DEFAULT_PYTHON_EXECUTABLE;
  }

  const hasUnsafeCharacter = /[\s\p{Cc}]/u.test(configured);
  const isBareExecutable =
    !configured.includes("/") && !configured.includes("\\");
  if (hasUnsafeCharacter || (!isBareExecutable && !isAbsolute(configured))) {
    throw createSafeParserError(
      "Invalid STALEDOCS_PYTHON value.",
      "Invalid Python executable override.",
    );
  }

  return configured;
}

function readPythonVersion(
  executePython: PythonProcessRunner,
  executable: string,
): Promise<PythonVersion | undefined> {
  let executableCache = pythonVersionCache.get(executePython);
  if (executableCache === undefined) {
    executableCache = new Map();
    pythonVersionCache.set(executePython, executableCache);
  }

  const cached = executableCache.get(executable);
  if (cached !== undefined) return cached;

  const version = executePython(executable, ["-c", PYTHON_VERSION_SCRIPT], {
    timeout: PYTHON_EXECUTION_TIMEOUT,
    maxBuffer: PYTHON_EXECUTION_MAX_BUFFER,
  })
    .then(({ stdout }) => {
      const match = /^\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*$/u.exec(stdout.trim());
      if (match === null) return undefined;
      return { major: Number(match[1]), minor: Number(match[2]) };
    })
    .catch(() => undefined);
  executableCache.set(executable, version);
  return version;
}

/** Creates the process runner used by the parser's production constructor. */
export function createPythonProcessRunner(): PythonProcessRunner {
  return (command, args, options) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        command,
        args,
        {
          timeout: options.timeout,
          maxBuffer: options.maxBuffer,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      if (child.stdin !== null) {
        child.stdin.once("error", reject);
        try {
          child.stdin.end(options.input);
        } catch (error: unknown) {
          reject(error);
        }
      }
    });
}

/** Creates a safe parse-failure diagnostic with an optional interpreter version. */
async function createParseFailure(
  executePython: PythonProcessRunner,
  executable: string,
): Promise<Error> {
  const version = await readPythonVersion(executePython, executable);
  const message = version
    ? `Failed to parse Python source (local ${executable === DEFAULT_PYTHON_EXECUTABLE ? DEFAULT_PYTHON_EXECUTABLE : "configured Python"} is ${version.major}.${version.minor}; the project may need a newer interpreter; set STALEDOCS_PYTHON to choose one).`
    : "Failed to parse Python source.";
  return createSafeParserError(message, "Python parser failed.");
}

/** Creates a fixed parser error without retaining untrusted process stderr as its cause. */
function createSafeParserError(message: string, causeMessage: string): Error {
  return new Error(message, { cause: new Error(causeMessage) });
}

const runPythonProcess = createPythonProcessRunner();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actualKeys.length === expected.length &&
    actualKeys.every((key, index) => key === expected[index])
  );
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, expectedKeys);
}

function isSnapshotHash(value: unknown): value is string {
  return typeof value === "string" && SNAPSHOT_HASH_PATTERN.test(value);
}

function isSafeSnapshotSignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const codePoints = Array.from(value);
  if (codePoints.length > 400) return false;
  for (const character of codePoints) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 31 ||
      codePoint === 127 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return false;
    }
  }
  return true;
}

function isPythonIdentifier(value: string): boolean {
  return (
    value.normalize("NFKC") === value &&
    PYTHON_IDENTIFIER_PATTERN.test(value) &&
    !PYTHON_KEYWORDS.has(value)
  );
}

function isPublicPythonIdentifier(value: string): boolean {
  return !value.startsWith("_") && isPythonIdentifier(value);
}

function isSafeQualifiedName(
  kind: "function" | "class" | "method",
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (kind === "method") {
    return parts.length === 2 && parts.every(isPublicPythonIdentifier);
  }
  return parts.length === 1 && isPublicPythonIdentifier(parts[0]);
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0)!,
  );
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] < rightPoints[index] ? -1 : 1;
    }
  }
  if (leftPoints.length === rightPoints.length) return 0;
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

function compareSnapshotSymbolIdentity(
  left: ParserSymbolSnapshot,
  right: ParserSymbolSnapshot,
): number {
  return (
    compareUnicodeCodePoints(left.kind, right.kind) ||
    compareUnicodeCodePoints(left.qualifiedName, right.qualifiedName)
  );
}

function invalidSnapshotOutput(): Error {
  return new Error("Invalid Python snapshot output.");
}

/**
 * Python AST analysis script.
 * Uses Python's built-in `ast` module for real AST parsing — no heavy native dependencies.
 * This follows the AGENTS.md principle: "AST First, LLM Second".
 */
const PYTHON_AST_SCRIPT = `
import ast
import copy
import hashlib
import json
import sys

CALLABLE_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)

def ast_payload(node):
    return ast.dump(node, annotate_fields=True, include_attributes=False)

def hash_payload(payload):
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':')
    )
    return hashlib.sha256(serialized.encode('utf-8')).hexdigest()

def is_docstring_statement(node):
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    )

class DocumentationStripper(ast.NodeTransformer):
    def strip_body(self, node):
        self.generic_visit(node)
        if node.body and is_docstring_statement(node.body[0]):
            node.body = node.body[1:]
        return node

    def visit_Module(self, node):
        return self.strip_body(node)

    def visit_FunctionDef(self, node):
        return self.strip_body(node)

    def visit_AsyncFunctionDef(self, node):
        return self.strip_body(node)

    def visit_ClassDef(self, node):
        return self.strip_body(node)

def body_payload(statements):
    module = ast.Module(body=copy.deepcopy(statements), type_ignores=[])
    stripped = DocumentationStripper().visit(module)
    return ast_payload(stripped)

def node_without_documentation_payload(node):
    stripped = DocumentationStripper().visit(copy.deepcopy(node))
    return ast_payload(stripped)

def documentation_fingerprint(node):
    documentation = ast.get_docstring(node, clean=False)
    if documentation is None:
        return None
    return hash_payload({'documentation': documentation})

def drop_bound_method_receiver(arguments):
    positional = arguments.posonlyargs + arguments.args
    if not positional:
        return arguments

    default_start = len(positional) - len(arguments.defaults)
    if default_start == 0 and arguments.defaults:
        arguments.defaults = arguments.defaults[1:]
    if arguments.posonlyargs:
        arguments.posonlyargs = arguments.posonlyargs[1:]
    else:
        arguments.args = arguments.args[1:]
    return arguments

def decorator_terminal_name(decorator):
    if isinstance(decorator, ast.Name):
        return decorator.id
    if isinstance(decorator, ast.Attribute):
        return decorator.attr
    return None

def is_static_method(node):
    return any(
        decorator_terminal_name(decorator) == 'staticmethod'
        for decorator in node.decorator_list
    )

def is_overload_declaration(node):
    return any(
        decorator_terminal_name(decorator) == 'overload'
        for decorator in node.decorator_list
    )

def property_accessor_kind(node):
    for decorator in node.decorator_list:
        if decorator_terminal_name(decorator) == 'property':
            return 'property'
        if (
            isinstance(decorator, ast.Attribute)
            and decorator.attr in ('getter', 'setter', 'deleter')
            and decorator_terminal_name(decorator.value) == node.name
        ):
            return decorator.attr
    return None

def effective_property_accessors(nodes):
    accessors = {}
    for node in nodes:
        kind = property_accessor_kind(node)
        if kind == 'property':
            accessors = {'getter': node}
        elif kind in ('getter', 'setter', 'deleter'):
            accessors[kind] = node
        else:
            accessors = {}
    return [
        (kind, accessors[kind])
        for kind in ('getter', 'setter', 'deleter')
        if kind in accessors
    ]

def callable_contract_payloads(node, is_method=False):
    arguments = copy.deepcopy(node.args)
    if is_method and not is_static_method(node):
        arguments = drop_bound_method_receiver(arguments)

    payloads = {
        'parameters': ast_payload(arguments),
        'modifiers': {
            'async': isinstance(node, ast.AsyncFunctionDef),
            'decorators': [ast_payload(item) for item in node.decorator_list],
            'typeComment': getattr(node, 'type_comment', None),
            'typeParameters': [
                ast_payload(item) for item in getattr(node, 'type_params', [])
            ],
        },
    }
    if node.returns is not None:
        payloads['return'] = ast_payload(node.returns)
    return payloads

def render_signature(value):
    collapsed = ' '.join(value.split())
    return collapsed if len(collapsed) <= 400 else collapsed[:397] + '...'

def callable_signature_and_arity(node, is_method=False):
    arguments = copy.deepcopy(node.args)
    if is_method and not is_static_method(node):
        arguments = drop_bound_method_receiver(arguments)
    prefix = 'async def' if isinstance(node, ast.AsyncFunctionDef) else 'def'
    if hasattr(ast, 'unparse'):
        rendered_args = ast.unparse(arguments)
        rendered_returns = ast.unparse(node.returns) if node.returns is not None else ''
    else:
        rendered_args = '...'
        rendered_returns = ''
    result = f'{prefix} {node.name}({rendered_args})'
    if rendered_returns:
        result += f' -> {rendered_returns}'
    positional = arguments.posonlyargs + arguments.args
    required = len(positional) - len(arguments.defaults)
    required += sum(1 for default in arguments.kw_defaults if default is None)
    total = len(positional) + len(arguments.kwonlyargs)
    return render_signature(result), {'required': required, 'total': total}

def constructor_signature_and_arity(node):
    signature, arity = callable_signature_and_arity(node, True)
    prefix = 'async def ' if isinstance(node, ast.AsyncFunctionDef) else 'def '
    return signature[len(prefix):], arity

def class_signature(node, constructor_signatures):
    if not node.bases or not hasattr(ast, 'unparse'):
        segments = ['class ' + node.name]
    else:
        segments = [
            'class ' + node.name + '(' + ', '.join(
                ast.unparse(base) for base in node.bases
            ) + ')'
        ]
    return render_signature(' | '.join(segments + constructor_signatures))

def build_symbol(kind, qualified_name, contract_payloads, implementation, node, signature=None, arity=None):
    contract_facets = {
        name: hash_payload(payload)
        for name, payload in contract_payloads.items()
    }
    result = {
        'language': 'python',
        'kind': kind,
        'qualifiedName': qualified_name,
        'contractFacets': contract_facets,
        'contractFingerprint': hash_payload(contract_payloads),
        'implementationFingerprint': hash_payload(implementation),
        'documentationFingerprint': documentation_fingerprint(node),
    }
    if signature is not None:
        result['signature'] = signature
    if arity is not None:
        result['arity'] = arity
    return result



def canonical_payload(payload):
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':')
    )

def sorted_unique_payloads(payloads):
    unique = {}
    for payload in payloads:
        unique[canonical_payload(payload)] = payload
    return [unique[key] for key in sorted(unique)]

def callable_group_contract_nodes(nodes, is_method=False):
    overloads = [node for node in nodes if is_overload_declaration(node)]
    if overloads:
        return overloads
    if is_method:
        accessors = effective_property_accessors(nodes)
        if len(accessors) > 1:
            return [node for _, node in accessors]
    return [nodes[-1]]

def property_contract_payloads(accessors, is_method=False):
    contributions = [
        (kind, callable_contract_payloads(node, is_method))
        for kind, node in accessors
    ]
    contract_payloads = {
        name: sorted_unique_payloads([
            {
                'accessor': kind,
                'value': contribution[name],
            }
            for kind, contribution in contributions
        ])
        for name in ('parameters', 'modifiers')
    }
    if any('return' in contribution for _, contribution in contributions):
        contract_payloads['return'] = sorted_unique_payloads([
            {
                'accessor': kind,
                'value': contribution['return'],
            }
            for kind, contribution in contributions
            if 'return' in contribution
        ])
    return contract_payloads

def callable_group_contract_payloads(nodes, is_method=False):
    if len(nodes) == 1:
        return callable_contract_payloads(nodes[0], is_method)

    if is_method and not any(
        is_overload_declaration(node) for node in nodes
    ):
        accessors = effective_property_accessors(nodes)
        if len(accessors) > 1:
            return property_contract_payloads(accessors, is_method)

    contract_nodes = callable_group_contract_nodes(nodes, is_method)
    contributions = [
        callable_contract_payloads(node, is_method)
        for node in contract_nodes
    ]
    contract_payloads = {
        'parameters': sorted_unique_payloads([
            contribution['parameters'] for contribution in contributions
        ]),
        'modifiers': sorted_unique_payloads([
            contribution['modifiers'] for contribution in contributions
        ]),
    }
    if any('return' in contribution for contribution in contributions):
        contract_payloads['return'] = sorted_unique_payloads([
            contribution.get('return') for contribution in contributions
        ])
    return contract_payloads

def callable_group_implementation_payload(nodes, is_method=False):
    overloads = [node for node in nodes if is_overload_declaration(node)]
    if is_method and not overloads:
        accessors = effective_property_accessors(nodes)
        if len(accessors) > 1:
            return [
                {
                    'accessor': kind,
                    'body': body_payload(node.body),
                }
                for kind, node in accessors
            ]

    implementations = [
        node for node in nodes if not is_overload_declaration(node)
    ]
    if not implementations:
        return []

    implementation = implementations[-1]
    body = body_payload(implementation.body)
    if not overloads:
        return body
    return {
        'signature': callable_contract_payloads(implementation, is_method),
        'body': body,
    }

def callable_group_symbol(nodes, kind, qualified_name, is_method=False):
    if len(nodes) == 1:
        node = nodes[0]
        signature, arity = callable_signature_and_arity(node, is_method)
        return build_symbol(
            kind,
            qualified_name,
            callable_contract_payloads(node, is_method),
            body_payload(node.body),
            node,
            signature,
            arity,
        )
    contract_nodes = callable_group_contract_nodes(nodes, is_method)
    symbol = build_symbol(
        kind,
        qualified_name,
        callable_group_contract_payloads(nodes, is_method),
        callable_group_implementation_payload(nodes, is_method),
        contract_nodes[0],
    )
    overloads = [node for node in nodes if is_overload_declaration(node)]
    if overloads:
        implementations = [
            node for node in nodes if not is_overload_declaration(node)
        ]
        documentation_nodes = overloads + implementations[-1:]
    elif is_method:
        accessors = effective_property_accessors(nodes)
        documentation_nodes = (
            [node for _, node in accessors]
            if len(accessors) > 1 else [nodes[-1]]
        )
    else:
        documentation_nodes = [nodes[-1]]
    documentation = sorted_unique_payloads([
        value
        for value in (
            ast.get_docstring(node, clean=False)
            for node in documentation_nodes
        )
        if value is not None
    ])
    symbol['documentationFingerprint'] = (
        hash_payload({'documentation': documentation})
        if documentation else None
    )
    signatures = [
        callable_signature_and_arity(node, is_method)
        for node in contract_nodes
    ]
    symbol['signature'] = render_signature(
        ' | '.join(item[0] for item in signatures)
    )
    symbol['arity'] = {
        'required': min(item[1]['required'] for item in signatures),
        'total': max(item[1]['total'] for item in signatures),
    }
    return symbol

def group_public_callables(nodes):
    groups = {}
    for node in nodes:
        if isinstance(node, CALLABLE_NODES) and not node.name.startswith('_'):
            groups.setdefault(node.name, []).append(node)
    return groups

def group_public_classes(nodes):
    groups = {}
    for node in nodes:
        if isinstance(node, ast.ClassDef) and not node.name.startswith('_'):
            groups.setdefault(node.name, []).append(node)
    return groups

def public_assignment_names(target):
    if isinstance(target, ast.Name) and not target.id.startswith('_'):
        return [target.id]
    if isinstance(target, ast.Starred):
        return public_assignment_names(target.value)
    if isinstance(target, (ast.Tuple, ast.List)):
        names = []
        for item in target.elts:
            names.extend(public_assignment_names(item))
        return names
    return []

def assignment_public_names(node):
    if isinstance(node, ast.AnnAssign):
        return public_assignment_names(node.target)
    if isinstance(node, ast.Assign):
        names = []
        for target in node.targets:
            names.extend(public_assignment_names(target))
        return names
    return []

def extends_callable_group(nodes, node):
    if is_overload_declaration(node):
        return bool(nodes) and all(
            is_overload_declaration(item) for item in nodes
        )

    if any(is_overload_declaration(item) for item in nodes):
        if all(is_overload_declaration(item) for item in nodes):
            return True
        accessor_kind = property_accessor_kind(node)
        runtime_nodes = [
            item for item in nodes if not is_overload_declaration(item)
        ]
        return (
            accessor_kind in ('getter', 'setter', 'deleter')
            and bool(effective_property_accessors(runtime_nodes))
        )

    accessor_kind = property_accessor_kind(node)
    return (
        accessor_kind in ('getter', 'setter', 'deleter')
        and bool(effective_property_accessors(nodes))
    )

def constructor_nodes(body):
    nodes = []
    for item in body:
        if isinstance(item, CALLABLE_NODES) and item.name == '__init__':
            nodes = (
                nodes + [item]
                if extends_callable_group(nodes, item)
                else [item]
            )
    return nodes

def effective_class_bindings(body):
    bindings = {}
    for index, item in enumerate(body):
        if isinstance(item, CALLABLE_NODES) and not item.name.startswith('_'):
            previous = bindings.get(item.name)
            nodes = (
                previous['nodes'] + [item]
                if previous is not None
                and previous['kind'] == 'method'
                and extends_callable_group(previous['nodes'], item)
                else [item]
            )
            bindings[item.name] = {
                'kind': 'method',
                'nodes': nodes,
                'index': index,
            }
            continue

        for name in assignment_public_names(item):
            bindings[name] = {
                'kind': 'property',
                'node': item,
                'index': index,
            }
    return bindings

def class_member_contracts(node):
    members = []
    for name, binding in effective_class_bindings(node.body).items():
        if binding['kind'] == 'method':
            members.append({
                'kind': 'method',
                'name': name,
                'contract': callable_group_contract_payloads(
                    binding['nodes'], True
                ),
            })
        else:
            item = binding['node']
            if isinstance(item, ast.AnnAssign):
                members.append({
                    'kind': 'property',
                    'name': name,
                    'annotation': ast_payload(item.annotation),
                    'default': (
                        ast_payload(item.value) if item.value is not None else None
                    ),
                })
            else:
                members.append({
                    'kind': 'property',
                    'name': name,
                    'annotation': None,
                    'default': ast_payload(item.value),
                })

    return sorted(
        members,
        key=lambda item: json.dumps(
            item,
            ensure_ascii=False,
            sort_keys=True,
            separators=(',', ':')
        )
    )

def class_implementation_payload(node):
    entries = []
    body = node.body[1:] if node.body and is_docstring_statement(node.body[0]) else node.body
    bindings = effective_class_bindings(body)

    for index, item in enumerate(body):
        if isinstance(item, CALLABLE_NODES) and not item.name.startswith('_'):
            binding = bindings.get(item.name)
            if (
                binding is not None
                and binding['kind'] == 'method'
                and binding['index'] == index
            ):
                entries.append({
                    'kind': 'method',
                    'name': item.name,
                    'body': callable_group_implementation_payload(
                        binding['nodes'], True
                    ),
                })
        elif isinstance(item, ast.AnnAssign):
            names = [
                name for name in assignment_public_names(item)
                if bindings.get(name, {}).get('kind') == 'property'
                and bindings[name]['index'] == index
            ]
            if names:
                entries.append({
                    'kind': 'property',
                    'names': names,
                    'value': ast_payload(item.value) if item.value is not None else None,
                })
            elif not assignment_public_names(item):
                entries.append(node_without_documentation_payload(item))
        elif isinstance(item, ast.Assign):
            names = [
                name for name in assignment_public_names(item)
                if bindings.get(name, {}).get('kind') == 'property'
                and bindings[name]['index'] == index
            ]
            if names:
                entries.append({
                    'kind': 'property',
                    'names': names,
                    'value': ast_payload(item.value),
                })
            elif not assignment_public_names(item):
                entries.append(node_without_documentation_payload(item))
        else:
            entries.append(node_without_documentation_payload(item))
    return entries

def class_symbol(node):
    init_nodes = constructor_nodes(node.body)
    contract_payloads = {
        'constructor': (
            callable_group_contract_payloads(init_nodes, True)
            if init_nodes else None
        ),
        'inheritance': {
            'bases': [ast_payload(item) for item in node.bases],
            'keywords': [ast_payload(item) for item in node.keywords],
        },
        'members': class_member_contracts(node),
        'modifiers': {
            'decorators': [ast_payload(item) for item in node.decorator_list],
            'typeParameters': [
                ast_payload(item) for item in getattr(node, 'type_params', [])
            ],
        },
    }
    constructors = [
        constructor_signature_and_arity(item)
        for item in (
            callable_group_contract_nodes(init_nodes, True) if init_nodes else []
        )
    ]
    arity = {
        'required': min(item[1]['required'] for item in constructors),
        'total': max(item[1]['total'] for item in constructors),
    } if constructors else None
    return build_symbol(
        'class',
        node.name,
        contract_payloads,
        class_implementation_payload(node),
        node,
        class_signature(node, [item[0] for item in constructors]),
        arity,
    )


def dependency_modules(tree):
    modules = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            modules.append('.' * node.level + (node.module or ''))
    return sorted(modules)

def module_reexports(tree):
    edges = []
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.level >= 1:
            names = None if any(alias.name == '*' for alias in node.names) else [
                {
                    'exported': alias.asname or alias.name,
                    'local': alias.name,
                }
                for alias in node.names
            ]
            edges.append({
                'specifier': '.' * node.level + (node.module or ''),
                'names': names,
            })
    return edges

def dunder_all(tree):
    for node in tree.body:
        targets = (
            node.targets
            if isinstance(node, ast.Assign)
            else ([node.target] if isinstance(node, ast.AnnAssign) else [])
        )
        if any(
            isinstance(target, ast.Name) and target.id == '__all__'
            for target in targets
        ):
            value = node.value
            if (
                isinstance(value, (ast.List, ast.Tuple))
                and all(
                    isinstance(element, ast.Constant)
                    and isinstance(element.value, str)
                    for element in value.elts
                )
            ):
                return sorted({element.value for element in value.elts})
            return None
    return None

def snapshot_source(filepath, source):
    tree = ast.parse(source, filename=filepath)
    symbols = []
    for name, nodes in group_public_callables(tree.body).items():
        symbols.append(callable_group_symbol(nodes, 'function', name))

    for class_nodes in group_public_classes(tree.body).values():
        effective_class = class_nodes[-1]
        symbols.append(class_symbol(effective_class))
        for name, binding in effective_class_bindings(
            effective_class.body
        ).items():
            if binding['kind'] == 'method':
                symbols.append(
                    callable_group_symbol(
                        binding['nodes'],
                        'method',
                        effective_class.name + '.' + name,
                        True,
                    )
                )

    symbols.sort(key=lambda item: (item['kind'], item['qualifiedName']))
    return {
        'language': 'python',
        'dependencyFingerprint': hash_payload(dependency_modules(tree)),
        'symbols': symbols,
        'reexports': module_reexports(tree),
        'dunderAll': dunder_all(tree),
    }

def analyze_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as source_file:
        source = source_file.read()
    return analyze_source(filepath, source)

def analyze_source(filepath, source):
    tree = ast.parse(source, filename=filepath)
    result = {
        'functions': [],
        'classes': [],
        'imports': []
    }

    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.FunctionDef) or isinstance(node, ast.AsyncFunctionDef):
            if node.name.startswith('_'):
                continue
            func = extract_function(node)
            func['isAsync'] = isinstance(node, ast.AsyncFunctionDef)
            result['functions'].append(func)

        elif isinstance(node, ast.ClassDef):
            if node.name.startswith('_'):
                continue
            result['classes'].append(extract_class(node))

        elif isinstance(node, ast.Import):
            for alias in node.names:
                result['imports'].append({
                    'source': alias.name,
                    'names': [alias.asname or alias.name],
                    'isDefault': True
                })

        elif isinstance(node, ast.ImportFrom):
            module = node.module or ''
            names = [alias.name for alias in node.names]
            result['imports'].append({
                'source': module,
                'names': names,
                'isDefault': False
            })

    return result

def extract_function(node):
    params = []
    for arg in node.args.args:
        if arg.arg == 'self':
            continue
        param = {
            'name': arg.arg,
            'type': '',
            'isOptional': False
        }
        if arg.annotation:
            param['type'] = ast.unparse(arg.annotation)
        params.append(param)

    # Check for defaults (optional params)
    num_defaults = len(node.args.defaults)
    if num_defaults > 0:
        for i in range(num_defaults):
            idx = len(params) - num_defaults + i
            if 0 <= idx < len(params):
                params[idx]['isOptional'] = True
                params[idx]['defaultValue'] = ast.unparse(node.args.defaults[i])

    return_type = ''
    if node.returns:
        return_type = ast.unparse(node.returns)

    docstring = ast.get_docstring(node) or ''

    return {
        'name': node.name,
        'parameters': params,
        'returnType': return_type,
        'isAsync': False,
        'isExported': not node.name.startswith('_'),
        'lineRange': [node.lineno, node.end_lineno or node.lineno],
        'existingDoc': docstring if docstring else None,
        'signature': f"def {node.name}({', '.join(p['name'] for p in params)})"
    }

def extract_class(node):
    bases = [ast.unparse(b) for b in node.bases]
    docstring = ast.get_docstring(node) or ''

    methods = []
    properties = []

    for item in node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if item.name.startswith('__') and item.name != '__init__':
                continue
            method = extract_function(item)
            method['isAsync'] = isinstance(item, ast.AsyncFunctionDef)
            method['visibility'] = 'private' if item.name.startswith('_') else 'public'
            method['isStatic'] = any(
                isinstance(d, ast.Name) and d.id == 'staticmethod'
                for d in item.decorators if hasattr(item, 'decorators')
            ) if hasattr(item, 'decorators') else False
            methods.append(method)

    return {
        'name': node.name,
        'extends': bases[0] if bases else None,
        'implements': bases[1:] if len(bases) > 1 else [],
        'methods': methods,
        'properties': properties,
        'isExported': not node.name.startswith('_'),
        'lineRange': [node.lineno, node.end_lineno or node.lineno],
        'existingDoc': docstring if docstring else None
    }

def emit(value):
    sys.stdout.write(json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':')
    ))

if __name__ == '__main__':
    operation = sys.argv[1]
    if operation == 'module':
        emit(analyze_file(sys.argv[2]))
    elif operation == 'module-source':
        emit(analyze_source(sys.argv[2], sys.stdin.read()))
    elif operation == 'snapshot':
        emit(snapshot_source(sys.argv[2], sys.stdin.read()))
    else:
        raise RuntimeError('Unsupported Python parser operation.')
`;

/** Parses Python files by delegating AST extraction to Python's stdlib ast module. */
export class PythonParser implements LanguageParser {
  readonly name = "python";
  readonly supportedExtensions = [".py"];

  constructor(
    private readonly executePython: PythonProcessRunner = runPythonProcess,
  ) {}

  /** Parses a Python file into exported functions, classes, and imports. */
  async parse(filePath: string): Promise<ParsedModule> {
    // Verify file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    return this.parseModule(filePath, "module");
  }

  /** Parses supplied source text through the bounded Python AST worker. */
  async parseSource(filePath: string, source: string): Promise<ParsedModule> {
    return this.parseModule(filePath, "module-source", source);
  }

  private async parseModule(
    filePath: string,
    operation: "module" | "module-source",
    source?: string,
  ): Promise<ParsedModule> {
    const executable = resolvePythonExecutable();
    try {
      const { stdout } = await this.executePython(
        executable,
        ["-c", PYTHON_AST_SCRIPT, operation, filePath],
        {
          timeout: PYTHON_EXECUTION_TIMEOUT,
          maxBuffer: PYTHON_EXECUTION_MAX_BUFFER,
          input: source,
        },
      );

      const data = JSON.parse(stdout.trim());

      return this.mapModule(filePath, data);
    } catch (error: unknown) {
      if (
        getSafeAllowlistedErrorCode(error, PYTHON_UNAVAILABLE_CODES) ===
        "ENOENT"
      ) {
        throw createSafeParserError(
          `Python parser unavailable: ${executable === DEFAULT_PYTHON_EXECUTABLE ? DEFAULT_PYTHON_EXECUTABLE : "configured Python"} executable was not found`,
          "Python executable unavailable.",
        );
      }
      // Preserve the error chain without retaining the child-process error,
      // whose stderr may contain untrusted source text.
      throw await createParseFailure(this.executePython, executable);
    }
  }

  private mapModule(
    filePath: string,
    data: Record<string, unknown>,
  ): ParsedModule {
    const functions = Array.isArray(data.functions)
      ? data.functions.filter(isRecord)
      : [];
    const classes = Array.isArray(data.classes)
      ? data.classes.filter(isRecord)
      : [];
    const imports = Array.isArray(data.imports)
      ? data.imports.filter(isRecord)
      : [];

    return {
      filePath,
      language: "python",
      functions: functions.map(this.mapFunction),
      classes: classes.map(this.mapClass),
      types: [], // Python doesn't have separate type declarations like TS
      variables: [],
      imports: imports.map(this.mapImport),
    };
  }

  /** Creates a value-free public API snapshot from in-memory Python source. */
  async snapshot(
    filePath: string,
    source: string,
  ): Promise<ParserModuleSnapshot> {
    const executable = resolvePythonExecutable();
    try {
      const { stdout } = await this.executePython(
        executable,
        ["-c", PYTHON_AST_SCRIPT, "snapshot", filePath],
        {
          timeout: PYTHON_EXECUTION_TIMEOUT,
          maxBuffer: PYTHON_EXECUTION_MAX_BUFFER,
          input: source,
        },
      );

      return this.mapSnapshot(JSON.parse(stdout.trim()) as unknown);
    } catch (error: unknown) {
      if (
        getSafeAllowlistedErrorCode(error, PYTHON_UNAVAILABLE_CODES) ===
        "ENOENT"
      ) {
        throw createSafeParserError(
          `Python parser unavailable: ${executable === DEFAULT_PYTHON_EXECUTABLE ? DEFAULT_PYTHON_EXECUTABLE : "configured Python"} executable was not found`,
          "Python executable unavailable.",
        );
      }
      throw await createParseFailure(this.executePython, executable);
    }
  }

  private mapSnapshot(raw: unknown): ParserModuleSnapshot {
    if (!isRecord(raw)) throw invalidSnapshotOutput();
    const keys = Object.keys(raw);
    const allowedKeys = [
      "language",
      "dependencyFingerprint",
      "symbols",
      "reexports",
      "dunderAll",
    ];
    if (
      !["language", "dependencyFingerprint", "symbols"].every((key) =>
        Object.hasOwn(raw, key),
      ) ||
      keys.some((key) => !allowedKeys.includes(key)) ||
      raw.language !== "python" ||
      !isSnapshotHash(raw.dependencyFingerprint) ||
      !Array.isArray(raw.symbols) ||
      (raw.reexports !== undefined && !Array.isArray(raw.reexports)) ||
      (raw.dunderAll !== undefined &&
        raw.dunderAll !== null &&
        !Array.isArray(raw.dunderAll))
    ) {
      throw invalidSnapshotOutput();
    }

    const symbols = raw.symbols.map((symbol) => this.mapSnapshotSymbol(symbol));
    for (let index = 1; index < symbols.length; index += 1) {
      if (
        compareSnapshotSymbolIdentity(symbols[index - 1], symbols[index]) >= 0
      ) {
        throw invalidSnapshotOutput();
      }
    }
    const reexports =
      raw.reexports === undefined
        ? undefined
        : raw.reexports.map((edge) => this.mapReexport(edge));
    const dunderAll =
      raw.dunderAll === undefined || raw.dunderAll === null
        ? undefined
        : this.mapDunderAll(raw.dunderAll as unknown[]);

    return {
      language: "python",
      dependencyFingerprint: raw.dependencyFingerprint,
      symbols,
      ...(reexports === undefined ? {} : { reexports }),
      ...(dunderAll === undefined ? {} : { dunderAll }),
    };
  }

  private mapReexport(raw: unknown): ReexportEdge {
    if (
      !isExactRecord(raw, ["specifier", "names"]) ||
      typeof raw.specifier !== "string" ||
      !raw.specifier.startsWith(".") ||
      (raw.names !== null && !Array.isArray(raw.names))
    ) {
      throw invalidSnapshotOutput();
    }
    if (raw.names === null) return { specifier: raw.specifier };
    const names = raw.names.map((name) => {
      if (
        !isExactRecord(name, ["exported", "local"]) ||
        typeof name.exported !== "string" ||
        typeof name.local !== "string" ||
        !isPythonIdentifier(name.exported) ||
        !isPythonIdentifier(name.local)
      ) {
        throw invalidSnapshotOutput();
      }
      return { exported: name.exported, local: name.local };
    });
    return { specifier: raw.specifier, names };
  }

  private mapDunderAll(raw: unknown[]): string[] {
    const names = raw.map((name) => {
      if (typeof name !== "string" || !isPythonIdentifier(name)) {
        throw invalidSnapshotOutput();
      }
      return name;
    });
    for (let index = 1; index < names.length; index += 1) {
      if (compareUnicodeCodePoints(names[index - 1], names[index]) >= 0) {
        throw invalidSnapshotOutput();
      }
    }
    return names;
  }

  private mapSnapshotSymbol(raw: unknown): ParserSymbolSnapshot {
    if (!isRecord(raw)) throw invalidSnapshotOutput();
    const kind = raw.kind;
    if (kind !== "function" && kind !== "class" && kind !== "method") {
      throw invalidSnapshotOutput();
    }

    // Classes carry arity only when they declare a constructor.
    const hasExpectedKeys =
      hasExactKeys(raw, SNAPSHOT_SYMBOL_KEYS) ||
      (kind === "class" &&
        hasExactKeys(
          raw,
          SNAPSHOT_SYMBOL_KEYS.filter((key) => key !== "arity"),
        ));
    if (!hasExpectedKeys) throw invalidSnapshotOutput();

    const arity = raw.arity;
    const validArity =
      (kind === "class" && arity === undefined) ||
      (isExactRecord(arity, ["required", "total"]) &&
        Number.isSafeInteger(arity.required) &&
        Number.isSafeInteger(arity.total) &&
        (arity.required as number) >= 0 &&
        (arity.total as number) >= 0 &&
        (arity.required as number) <= (arity.total as number));
    if (
      raw.language !== "python" ||
      !isSafeQualifiedName(kind, raw.qualifiedName) ||
      !isSafeSnapshotSignature(raw.signature) ||
      !validArity ||
      !isSnapshotHash(raw.contractFingerprint) ||
      !isSnapshotHash(raw.implementationFingerprint) ||
      (raw.documentationFingerprint !== null &&
        !isSnapshotHash(raw.documentationFingerprint))
    ) {
      throw invalidSnapshotOutput();
    }

    return {
      language: "python",
      kind,
      qualifiedName: raw.qualifiedName,
      signature: raw.signature,
      ...(arity === undefined
        ? {}
        : { arity: arity as { required: number; total: number } }),
      contractFacets: this.mapContractFacets(kind, raw.contractFacets),
      contractFingerprint: raw.contractFingerprint,
      implementationFingerprint: raw.implementationFingerprint,
      documentationFingerprint: raw.documentationFingerprint,
    };
  }

  private mapContractFacets(
    kind: "function" | "class" | "method",
    raw: unknown,
  ): Partial<Record<ContractFacet, string>> {
    const requiredFacets =
      kind === "class"
        ? (["constructor", "inheritance", "members", "modifiers"] as const)
        : (["parameters", "modifiers"] as const);
    if (!isRecord(raw)) throw invalidSnapshotOutput();
    const keys = Object.keys(raw);
    const hasValidKeys =
      kind === "class"
        ? hasExactKeys(raw, requiredFacets)
        : hasExactKeys(raw, requiredFacets) ||
          hasExactKeys(raw, [...requiredFacets, "return"]);
    if (!hasValidKeys || keys.some((facet) => !isSnapshotHash(raw[facet]))) {
      throw invalidSnapshotOutput();
    }
    const mapped: Partial<Record<ContractFacet, string>> = {};
    for (const facet of keys as ContractFacet[])
      mapped[facet] = raw[facet] as string;
    return mapped;
  }
  private mapFunction(raw: Record<string, unknown>): FunctionInfo {
    return {
      name: raw.name as string,
      parameters: (raw.parameters as Array<Record<string, unknown>>).map(
        (p) => ({
          name: p.name as string,
          type: (p.type as string) || undefined,
          isOptional: p.isOptional as boolean,
          defaultValue: p.defaultValue as string | undefined,
        }),
      ),
      returnType: (raw.returnType as string) || "None",
      isAsync: raw.isAsync as boolean,
      isExported: raw.isExported as boolean,
      lineRange: raw.lineRange as [number, number],
      existingDoc: raw.existingDoc as string | undefined,
      signature: raw.signature as string,
    };
  }

  private mapClass(raw: Record<string, unknown>): ClassInfo {
    const methods = ((raw.methods as Array<Record<string, unknown>>) || []).map(
      (m): MethodInfo => ({
        name: m.name as string,
        parameters: (m.parameters as Array<Record<string, unknown>>).map(
          (p) => ({
            name: p.name as string,
            type: (p.type as string) || undefined,
            isOptional: p.isOptional as boolean,
          }),
        ),
        returnType: (m.returnType as string) || "None",
        isAsync: m.isAsync as boolean,
        isExported: true,
        lineRange: m.lineRange as [number, number],
        existingDoc: m.existingDoc as string | undefined,
        signature: m.signature as string,
        visibility:
          (m.visibility as "public" | "private" | "protected") || "public",
        isStatic: (m.isStatic as boolean) || false,
      }),
    );

    return {
      name: raw.name as string,
      extends: raw.extends as string | undefined,
      implements: (raw.implements as string[]) || [],
      methods,
      properties: [],
      isExported: raw.isExported as boolean,
      lineRange: raw.lineRange as [number, number],
      existingDoc: raw.existingDoc as string | undefined,
    };
  }

  private mapImport(raw: Record<string, unknown>): ImportStatement {
    return {
      source: raw.source as string,
      names: raw.names as string[],
      isDefault: raw.isDefault as boolean,
    };
  }
}
