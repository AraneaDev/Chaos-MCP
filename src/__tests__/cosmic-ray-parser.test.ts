import { describe, it, expect } from 'vitest';
import { parseCosmicRayDump, buildCosmicRayConfig } from '../engines/python.js';

const target = 'core/cve_scanners/apt.py';

/** Build one cosmic-ray `dump` line ([WorkItem, WorkResult] JSON). */
function line(
  operator: string,
  startPos: [number, number],
  outcome: string | null,
  diff?: string,
): string {
  const item = {
    job_id: 'j' + operator,
    mutations: [
      {
        module_path: target,
        operator_name: operator,
        occurrence: 0,
        start_pos: startPos,
        end_pos: [startPos[0], startPos[1] + 1],
        operator_args: {},
        definition_name: 'fn',
      },
    ],
  };
  const result =
    outcome === null
      ? null
      : { worker_outcome: 'normal', output: '...', test_outcome: outcome, diff: diff ?? '' };
  return JSON.stringify([item, result]);
}

const SURVIVED_DIFF = [
  '--- mutation diff ---',
  '--- acore/cve_scanners/apt.py',
  '+++ bcore/cve_scanners/apt.py',
  '@@ -70,7 +70,7 @@',
  '         except httpx.HTTPError:',
  '-            backoff = base * 2',
  '+            backoff = base - 2',
].join('\n');

describe('parseCosmicRayDump', () => {
  it('maps killed/survived counts and score from the dump', () => {
    const dump = [
      line('core/ReplaceBinaryOperator_Sub_Mul', [183, 18], 'killed'),
      line('core/ReplaceBinaryOperator_Add_Sub', [73, 60], 'survived', SURVIVED_DIFF),
    ].join('\n');
    const r = parseCosmicRayDump(dump, target);
    expect(r.killed).toBe(1);
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(2);
    expect(r.mutationScore).toBe('50.00%');
  });

  it('excludes incompetent mutants from the denominator (uncompilable, not a real hole)', () => {
    const dump = [
      line('core/NumberReplacer', [10, 1], 'killed'),
      line('core/NumberReplacer', [11, 1], 'survived'),
      line('core/ReplaceBinaryOperator_Add_Sub', [12, 1], 'incompetent'),
    ].join('\n');
    const r = parseCosmicRayDump(dump, target);
    expect(r.killed).toBe(1);
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(2); // incompetent dropped
    expect(r.mutationScore).toBe('50.00%');
  });

  it('builds a survivor vulnerability with line (from start_pos), operator, and diff text', () => {
    const dump = line('core/ReplaceBinaryOperator_Add_Sub', [73, 60], 'survived', SURVIVED_DIFF);
    const r = parseCosmicRayDump(dump, target);
    expect(r.vulnerabilities).toHaveLength(1);
    const v = r.vulnerabilities[0];
    expect(v.line).toBe(73); // start_pos[0]
    expect(v.mutator).toBe('core/ReplaceBinaryOperator_Add_Sub'); // raw operator (enrich canonicalizes)
    expect(v.original).toBe('backoff = base * 2');
    expect(v.mutated).toBe('backoff = base - 2');
  });

  it('does not emit a vulnerability for killed mutants', () => {
    const dump = line('core/ReplaceBinaryOperator_Sub_Mul', [183, 18], 'killed');
    expect(parseCosmicRayDump(dump, target).vulnerabilities).toHaveLength(0);
  });

  it('ignores pending (null result) jobs', () => {
    const dump = [
      line('core/NumberReplacer', [1, 1], 'killed'),
      line('core/NumberReplacer', [2, 1], null), // pending — exec interrupted
    ].join('\n');
    const r = parseCosmicRayDump(dump, target);
    expect(r.totalMutants).toBe(1);
    expect(r.killed).toBe(1);
  });

  it('treats an empty dump as 100% (no mutants)', () => {
    const r = parseCosmicRayDump('', target);
    expect(r.totalMutants).toBe(0);
    expect(r.mutationScore).toBe('100.00%');
    expect(r.vulnerabilities).toHaveLength(0);
  });

  it('reports 100% when every mutant was killed', () => {
    const dump = [
      line('core/NumberReplacer', [1, 1], 'killed'),
      line('core/NumberReplacer', [2, 1], 'killed'),
    ].join('\n');
    const r = parseCosmicRayDump(dump, target);
    expect(r.mutationScore).toBe('100.00%');
    expect(r.survived).toBe(0);
  });

  it('skips malformed dump lines without throwing', () => {
    const dump = ['{not json', line('core/NumberReplacer', [1, 1], 'killed')].join('\n');
    const r = parseCosmicRayDump(dump, target);
    expect(r.killed).toBe(1);
    expect(r.totalMutants).toBe(1);
  });
});

describe('buildCosmicRayConfig', () => {
  it('emits a config.toml scoped to the target module with the test command', () => {
    const toml = buildCosmicRayConfig({
      modulePath: 'core/cve_scanners/apt.py',
      testCommand: 'python -m pytest tests/unit/test_apt_version_compare.py -x -q',
      timeoutSeconds: 30,
    });
    expect(toml).toContain('[cosmic-ray]');
    expect(toml).toContain('module-path = "core/cve_scanners/apt.py"');
    expect(toml).toContain(
      'test-command = "python -m pytest tests/unit/test_apt_version_compare.py -x -q"',
    );
    expect(toml).toContain('timeout = 30');
    expect(toml).toContain('[cosmic-ray.distributor]');
    expect(toml).toContain('name = "local"');
  });

  it('does not emit an operators section (cosmic-ray always runs the full operator set)', () => {
    const toml = buildCosmicRayConfig({
      modulePath: 'm.py',
      testCommand: 'pytest',
      timeoutSeconds: 30,
    });
    expect(toml).not.toContain('[cosmic-ray.operators]');
  });
});
