# Limitations

## What StaleDocs does not check

StaleDocs maps changed public symbols to documentation sections. It does not prove that prose is correct, complete, or appropriate for readers.

Behavioral changes that keep the signature (a function returning different values for the same inputs) are not detected; documentation describing such behavior is not reported.

## What audit does not check

`staledocs audit` reads Markdown from the working tree only, never from another
revision. It does not check bare symbol names, command-line flags,
configuration keys, prose, or generated paths under `dist/`, `build/`, `out/`,
`coverage/`, and `node_modules/`. Links written as HTML or reference-style
definitions, commands behind a shell prompt such as `$ npm test`, and text
before a document's first heading are not read. A path that names a file in
another repository, such as an example project's source file, is reported
when no such file exists here; write such paths with a placeholder, as in
`src/<name>.ts`. Scripts are read from `package.json` manifests only; a
document under an unreadable manifest gets no script findings.

The member rule checks only public TypeScript classes and interfaces reachable
from a resolved package entry. It skips a type with `extends`, an index
signature, a computed member name, or more than one declaration (including
merged interfaces and a class merged with a namespace), and every type declared
in a JavaScript file, because inherited, indexed, and assigned members are not
declarations. Python classes are not checked by the member rule yet. When no
package entry resolves, or the entry walk exceeds its bound, the member rule
reports nothing; the bound case sets `ignored.boundaryLimitReached`.

## Public boundary

A public symbol is one that a consumer can import from the package entry. StaleDocs discovers entries from `package.json` (`exports`, then `types`, `module`, `main`; build paths such as `dist/<name>.js` are mapped to `src/<name>.ts` when that file exists) for the root package and one level of workspace packages, then follows static `export ... from` statements with relative specifiers. `export * as ns from` is followed one level. Bare specifiers, `require()`, dynamic `import()`, `tsconfig` path aliases, and CommonJS are not followed. Set `entry` in the configuration to override discovery. When no entry can be resolved, every export in a changed file is treated as public and the report says so.

For Python, StaleDocs discovers root package `__init__.py` entries from the bounded project metadata subset and root or `src` package directories. A path segment beginning with `_` is private except for `__init__.py` and `__main__.py`. A literal list or tuple assigned to `__all__` selects public declarations and relative imports. Without `__all__`, public declarations and names imported into `__init__.py` are treated as reachable. This intentionally differs from Griffe for imported names because small packages commonly re-export them without `__all__`. Resolution follows the package root plus one subpackage `__init__.py`; deeper re-export chains, imports under `if TYPE_CHECKING:`, and dynamic `__all__` values are not followed. Symbols in ordinary modules that are not imported by a selected initializer are internal. Configure additional `__init__.py` entry files when the package documents another surface.

### Re-export changes

Adding a symbol to a resolved entry is reported as `now exported`. Removing it is reported as `no longer exported` and potentially breaking. These flips are emitted only when the public entry resolves at both revisions.

## Languages and syntax not enumerated

CommonJS modules (`module.exports`, `exports.x`) are not enumerated; they are listed as not analyzed in the report. Python analysis does not enumerate module constants or dynamic exports. Generated exports and runtime registration are outside the AST snapshot.

## Documentation discovery

The planner discovers up to 30 case-insensitive `*.md` files at the repository root. It recursively scans `docs`, `doc`, `documentation`, `guide`, `guides`, the configured output directory, and repository-relative files or directories listed in `docs` configuration. It also scans `*.md` files non-recursively beside discovered JavaScript or TypeScript package manifests and Python package roots. Directory discovery stops after 2000 unique Markdown files; traversal also stops after 2000 directories or 10000 filesystem entries. Reaching any of these ceilings sets the optional `ignored.documentationLimitReached` plan field. The `docs` array accepts at most 100 entries. Planning exclusion globs and repository-relative path safety apply to every candidate, and symlinks are skipped. After discovery, `.staledocsignore` removes documentation through case-sensitive path patterns whose literal suffix is `.md`, such as `docs/legacy/*.md`.

Changelog-style files (`CHANGELOG.md`, `CHANGES.md`, `HISTORY.md`, `NEWS.md`, `RELEASES.md`) are read for recommendations only; their entries are history and are never reported as stale.

## Git requirements

Base discovery checks the configured reference, the remote default branch, `origin/main`, `main`, `origin/master`, `master`, and then `HEAD~1`. A shallow clone may not contain the base commit; use `fetch-depth: 0` for pull request reviews.

## Python interpreter requirement

Python analysis invokes the local `python3` interpreter. Its version must understand the syntax used by the project. Set `STALEDOCS_PYTHON` to an approved executable when `python3` is not the right interpreter.

## Trust Gate scope

The Trust Gate inspects prepared input and validated output for secret-like values. It does not replace prompt-injection defenses, a model sandbox, host permissions, or repository access controls.

## MCP scope

The MCP server is pinned to the Git worktree where it starts. It reads only repository-contained paths and does not write during prepare or validate. The host remains responsible for model choice, permissions, and applying approved Markdown.

## Action fork limitations

Review mode can read fork pull requests but may not receive permission to post comments or labels. The Action reports the result in the job summary when the token is read-only.
