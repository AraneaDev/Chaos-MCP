/**
 * cargo-mutants argv construction.
 *
 * Pure by design: no filesystem access and no environment reads, so both the
 * job-count policy and the `--file` glob escaping are assertable as plain
 * values.
 */

/**
 * Resolve the cargo-mutants `-j` job count. Explicit `concurrency` (from a tool
 * arg or `rust.concurrency` config, already validated to 1–64) is honored as-is.
 * Otherwise a deliberately LOW default: `2` when the machine has spare cores
 * (`cpuCount >= 3`), else `1` (serial). cargo-mutants' own docs warn against
 * core-scaling `-j` for Rust — its build/test tooling is already parallel, and
 * each job needs its own multi-GB `target/` copy — so the default stays small.
 * A result of `1` means "serial"; the engine omits `-j` entirely in that case.
 */
export function resolveCargoJobs(concurrency: number | undefined, cpuCount: number): number {
  if (typeof concurrency === 'number' && Number.isInteger(concurrency) && concurrency >= 1) {
    return concurrency;
  }
  return cpuCount >= 3 ? 2 : 1;
}

/**
 * Escape a source path for cargo-mutants' `--file` flag, which takes a GLOB
 * rather than a literal path.
 *
 * WHY (audit Med#4): `*`, `?`, `[`, `]`, `{` and `}` are all legal POSIX
 * filename characters AND glob metacharacters. Passed through verbatim,
 * `src/parser/token[0].rs` makes `[0]` a character class, so the glob matches
 * `src/parser/token0.rs` — a DIFFERENT file — or, far more often, nothing at
 * all. Verified against cargo-mutants 27.1.0: the unescaped pattern really did
 * list mutants for the wrong file, and `src/does{not}exist.rs` matched nothing
 * while cargo-mutants still exited 0 ("Found 0 mutants to test"), which is what
 * used to surface as a serene 100.00%.
 *
 * HOW: cargo-mutants matches with globset, whose backslash escape is not usable
 * here (a backslash is a path separator on Windows). Instead every metacharacter
 * is wrapped in a single-character class, which always matches that character
 * literally: `[` becomes `[[]`, `*` becomes `[*]`, and so on. That is the same
 * transformation `globset::escape` performs, extended with `{`/`}` because
 * cargo-mutants leaves brace alternation (`{a,b}`) enabled. Each of the six
 * escapes below was confirmed to select exactly the intended file against real
 * cargo-mutants 27.1.0.
 *
 * Deliberately NOT escaped:
 *  - `!` — only special immediately after a `[`, and every `[` we emit is itself
 *    escaped, so a literal `!` can never open a negated class. `[!]` would in
 *    fact be an unterminated class and fail to compile at all.
 *  - `\` — the Windows path separator, which must reach cargo-mutants intact.
 *
 * Escaping is best-effort by nature (glob dialects differ); the zero-mutant
 * guard in {@link parseCargoMutantsText} is what stops a miss becoming a false
 * 100%. Where the two meet: a glob that misses a file which is NOT on disk still
 * throws, and a glob that somehow misses a file that IS on disk degrades to a
 * zero-mutant "n/a" result — never to a 100% score — because `hasNoMutableLogic`
 * (src/format.ts) refuses to render 0/0 as a percentage at all.
 */
export function escapeCargoFileGlob(filePath: string): string {
  return filePath.replace(/[*?[\]{}]/g, (c) => `[${c}]`);
}
