import { describe, it, expect } from 'vitest';
import { listPrompts, getPrompt } from '../prompts.js';

describe('prompts', () => {
  it('lists harden_file and triage_changes with their required args', () => {
    const byName = Object.fromEntries(listPrompts().map((p) => [p.name, p]));
    expect(byName.harden_file.arguments).toEqual([
      { name: 'filePath', description: expect.any(String), required: true },
    ]);
    expect(byName.triage_changes.arguments).toEqual([
      { name: 'diffBase', description: expect.any(String), required: true },
    ]);
  });

  it('renders harden_file with the file path interpolated', () => {
    const res = getPrompt('harden_file', { filePath: 'src/math.ts' });
    expect(res.messages[0].role).toBe('user');
    const text = res.messages[0].content.text;
    expect(text).toContain('src/math.ts');
    expect(text).toContain('audit_code_resilience');
    expect(text).toContain('runId');
  });

  it('renders triage_changes with the diff base interpolated', () => {
    const text = getPrompt('triage_changes', { diffBase: 'main' }).messages[0].content.text;
    expect(text).toContain('main');
    expect(text).toContain('triage_test_coverage');
  });

  it('throws on an unknown prompt name', () => {
    expect(() => getPrompt('nope', {})).toThrow();
  });

  it('throws when a required argument is missing', () => {
    expect(() => getPrompt('harden_file', {})).toThrow(/filePath/);
  });
});
