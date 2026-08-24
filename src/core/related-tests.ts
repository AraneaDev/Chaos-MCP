/**
 * Which test files exercise a given source file, for JavaScript and TypeScript
 * workspaces whose runner has no `related` mode of its own.
 *
 * Vitest answers this itself (`vitest related`), and the Stryker plugins for
 * Jest and Mocha answer it through `coverageAnalysis: perTest`. Bun has neither:
 * it has no Stryker plugin at all, so it runs through the command runner, and
 * `bun test` takes only path filters. Left alone, every mutant re-runs the whole
 * suite. On a small real project that is an eleven-second suite paid sixty-nine
 * times over for a file seventeen tests cover.
 *
 * The cheap answer — map `src/foo/bar.ts` to `test/bar.test.ts` by name — is
 * WRONG, and wrong in the direction that costs the most. A mutant killed only
 * by a test outside that mapping is reported as a SURVIVOR, and the operator
 * goes and writes a test that already exists. Measured on one such project,
 * name-mapping selects a single file while three more reach the target through
 * intermediate modules.
 *
 * So this walks the import graph instead, and every ambiguity resolves toward
 * running MORE tests:
 *
 *   - a relative specifier that will not resolve makes its whole file suspect,
 *     and any test that reaches a suspect file is treated as related;
 *   - an empty result is not "no tests" but "cannot tell", and the caller falls
 *     back to the project's configured command;
 *   - the walk is bounded, and hitting a bound also means "cannot tell".
 *
 * Bare specifiers (`node:fs`, `vitest`, `lodash`) are ignored on purpose. They
 * cannot name a file inside the workspace, so they cannot form an edge to the
 * target, and following them would mean resolving node_modules for no gain.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname, relative, resolve, sep } from 'path';
import { COMMON_IGNORE_DIRS } from '../utils/ignore-dirs.js';

/**
 * Directories the import walk never descends into.
 *
 * Deliberately its own set rather than `TEST_SEARCH_SKIP`: that one is tuned
 * for finding a test file by name and also drops `coverage` and `target`, which
 * is right there and harmless here, but the two answer different questions and
 * the repo has already been bitten twice by lists that drifted while sharing a
 * name. Sharing the common core and keeping the extras local is the pattern
 * `ignore-dirs.ts` documents.
 */
const WALK_SKIP = new Set([
  ...COMMON_IGNORE_DIRS,
  'coverage',
  'target',
  'vendor',
  '.stryker-tmp',
  '.chaos-mcp',
]);

/** Extensions the graph considers part of the workspace. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Suffixes appended when a specifier does not name a file directly.
 *
 * `.js` → `.ts` comes first because NodeNext ESM requires the `.js` extension
 * on a relative import that will be emitted from TypeScript, so in a NodeNext
 * codebase almost every intra-workspace edge is spelled with an extension that
 * does not exist on disk. Resolving those is not an edge case here; it is the
 * common case, and missing them would silently empty the graph.
 */
const RESOLVE_SUFFIXES = ['', ...SOURCE_EXTENSIONS, ...SOURCE_EXTENSIONS.map((e) => `/index${e}`)];

/**
 * Relative imports that name data rather than code.
 *
 * These resolve to something real but can never form a path to the target: a
 * JSON manifest or a stylesheet imports nothing. Without this they land in the
 * unresolvable bucket and make their importer suspect, and one test file
 * importing one fixture then attaches itself to EVERY selection. That is not a
 * theoretical concern — it happened on the first workspace this was measured
 * against, and it inflated the answer for six unrelated targets at once.
 */
const ASSET_EXTENSION =
  /\.(?:json|jsonc|json5|css|scss|sass|less|svg|png|jpe?g|gif|webp|txt|md|wasm|node|graphql|gql|ya?ml|toml)$/i;

/** Bun's default test-file shapes, plus the directory conventions around them. */
const TEST_FILE = /(?:^|\/)(?:[^/]+[._](?:test|spec)\.[cm]?[jt]sx?)$/;
const TEST_DIR = /(?:^|\/)(?:__tests__|tests?)\//;

/**
 * Ceilings that keep the walk cheap on a large tree.
 *
 * Passing one is NOT a partial answer: the graph would be missing edges, and a
 * graph missing edges under-selects tests, which is the failure this module
 * exists to avoid. The caller is told "cannot tell" instead.
 */
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DEPTH = 12;

/**
 * Relative import and re-export specifiers, plus dynamic `import()` and
 * `require()`.
 *
 * A regex rather than a parser because this decides only which tests to RUN,
 * never what to mutate: an over-match costs one extra edge, which costs extra
 * tests, which is the safe direction. It cannot see a specifier built at
 * runtime — that is what the suspect-file rule below is for.
 */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]*)['"]/g;

/** A workspace file, its outgoing intra-workspace edges, and whether it resolved cleanly. */
interface GraphFile {
  /** Absolute paths this file imports from inside the workspace. */
  imports: Set<string>;
  /** True when a relative specifier here could not be resolved to a file. */
  suspect: boolean;
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

/** Collect every source file under `root`, or undefined when a bound is hit. */
function collectFiles(root: string): string[] | undefined {
  const found: string[] = [];
  const walk = (dir: string, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory could hold a test that reaches the target, so
      // its contents are unknown rather than absent.
      return false;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (WALK_SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
        if (!walk(full, depth + 1)) return false;
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        if (found.length >= MAX_FILES) return false;
        found.push(full);
      }
    }
    return true;
  };
  return walk(root, 0) ? found : undefined;
}

/** Resolve one relative specifier against the importing file, or undefined. */
function resolveSpecifier(
  fromFile: string,
  specifier: string,
  known: Set<string>,
): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (known.has(candidate)) return candidate;
  }
  // A NodeNext codebase spells its own `.ts` imports as `.js`; swap and retry.
  const swapped = base.replace(/\.([cm]?)js$/, '.$1ts');
  if (swapped !== base) {
    for (const suffix of ['', 'x']) {
      if (known.has(swapped + suffix)) return swapped + suffix;
    }
  }
  return undefined;
}

/** Read one file's intra-workspace edges, or mark it suspect. */
function readEdges(file: string, known: Set<string>): GraphFile {
  const edges: GraphFile = { imports: new Set(), suspect: false };
  let text: string;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return { imports: new Set(), suspect: true };
    text = readFileSync(file, 'utf8');
  } catch {
    return { imports: new Set(), suspect: true };
  }
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1];
    if (specifier === undefined || ASSET_EXTENSION.test(specifier)) continue;
    const resolved = resolveSpecifier(file, specifier, known);
    if (resolved === undefined) edges.suspect = true;
    else edges.imports.add(resolved);
  }
  return edges;
}

function isTestFile(relPath: string): boolean {
  return TEST_FILE.test(relPath) || (TEST_DIR.test(relPath) && /\.[cm]?[jt]sx?$/.test(relPath));
}

/**
 * Test files that reach `targetFile` through the import graph, as
 * workspace-root-relative POSIX paths.
 *
 * Returns `[]` for "cannot tell", which every caller must read as "run the
 * whole suite" rather than "nothing covers this file". The two are
 * indistinguishable from the outside and only one of them is safe to act on.
 */
export function findBunTestSelection(targetFile: string, workspaceRoot: string): string[] {
  const root = resolve(workspaceRoot);
  const absoluteTarget = resolve(root, targetFile);

  const files = collectFiles(root);
  if (files === undefined) return [];
  const known = new Set(files);
  if (!known.has(absoluteTarget)) return [];

  // Reverse edges: a file maps to the files that import it.
  const importers = new Map<string, Set<string>>();
  const suspects: string[] = [];
  for (const file of files) {
    const edges = readEdges(file, known);
    if (edges.suspect) suspects.push(file);
    for (const dep of edges.imports) {
      let set = importers.get(dep);
      if (set === undefined) importers.set(dep, (set = new Set()));
      set.add(file);
    }
  }

  // Everything that reaches the target, plus every file whose own imports could
  // not be read: an unresolved specifier might have been the edge to the target.
  const reaching = new Set<string>([absoluteTarget, ...suspects]);
  const queue = [absoluteTarget, ...suspects];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const importer of importers.get(next) ?? []) {
      if (reaching.has(importer)) continue;
      reaching.add(importer);
      queue.push(importer);
    }
  }

  const selection = [...reaching]
    .map((file) => toPosix(relative(root, file)))
    .filter((rel) => rel !== '' && !rel.startsWith('..') && isTestFile(rel))
    .sort();

  return selection;
}
