import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../core/test-file.js', async () => {
  const actual =
    await vi.importActual<typeof import('../core/test-file.js')>('../core/test-file.js');
  return { ...actual, workspaceHasPythonTests: vi.fn(actual.workspaceHasPythonTests) };
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertPythonHasTests, pythonNoTestsMessage } from '../audit/audit-file.js';
import { workspaceHasPythonTests } from '../core/test-file.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';

const mockScan = vi.mocked(workspaceHasPythonTests);
const actualTestFile =
  await vi.importActual<typeof import('../core/test-file.js')>('../core/test-file.js');

/**
 * `audit/audit-file.ts` had no test file. Its Python guard decides whether a run backs
 * out before the sandbox copy — which duplicates the whole workspace tree, 100+ MB on a
 * real repo — so getting it wrong is either a pointless expensive copy or a refusal on
 * a project that does have tests.
 *
 * The subtle branch is the depth limit: a scan that gave up early has NOT established
 * that there are no tests, so only a tree-exhausted miss may block the run. Treating
 * "didn't find any" as "there are none" would refuse to audit deep repositories.
 */

let ws: string;

const env = (): EnvironmentInfo => ({
  projectType: 'python',
  testRunner: 'pytest',
  detectedRunner: 'pytest',
  packageManager: '',
  workspaceRoot: ws,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockScan.mockImplementation(actualTestFile.workspaceHasPythonTests);
  ws = mkdtempSync(join(tmpdir(), 'chaos-py-guard-'));
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('assertPythonHasTests', () => {
  it('allows a workspace with a pytest-discoverable test file', () => {
    writeFileSync(join(ws, 'test_thing.py'), 'def test_x():\n    assert True\n');

    expect(assertPythonHasTests(env())).toBeNull();
  });

  it('allows the suffix spelling of the convention too', () => {
    writeFileSync(join(ws, 'thing_test.py'), 'def test_x():\n    assert True\n');

    expect(assertPythonHasTests(env())).toBeNull();
  });

  it('refuses a workspace whose tree was fully scanned and holds no tests', () => {
    mkdirSync(join(ws, 'pkg'), { recursive: true });
    writeFileSync(join(ws, 'pkg', 'thing.py'), 'def add(a, b):\n    return a + b\n');

    const message = assertPythonHasTests(env());

    expect(message).toContain('No Python test files were found');
    expect(message).toContain(ws);
    // The message has to say what would fix it, not just that it failed.
    expect(message).toContain('test_*.py or *_test.py');
    expect(message).toContain('cosmicray.testSelection');
  });

  it('allows the run when the scan gave up before exhausting the tree', () => {
    // A depth-limited scan proves nothing. Blocking on it would refuse to audit any
    // repository deep enough to hit the limit, however many tests it actually has.
    mockScan.mockReturnValue({ found: false, depthLimited: true });

    expect(assertPythonHasTests(env())).toBeNull();
  });

  it('skips the scan entirely when the config names an explicit test selection', () => {
    // The caller has said where the tests are, so a convention-based search is not
    // evidence of anything — and the scan is the expensive part.
    const verdict = assertPythonHasTests(env(), {
      cosmicray: { testSelection: ['tests/unit'] },
    });

    expect(verdict).toBeNull();
    expect(mockScan).not.toHaveBeenCalled();
  });

  it('falls back to the scan when the explicit selection is empty', () => {
    // An empty array is not a selection. Treating it as one would skip the guard and
    // hand cosmic-ray a run with no tests to grade mutants against.
    const verdict = assertPythonHasTests(env(), { cosmicray: { testSelection: [] } });

    expect(verdict).toContain('No Python test files were found');
    expect(mockScan).toHaveBeenCalled();
  });
});

describe('pythonNoTestsMessage', () => {
  it('names the workspace it searched', () => {
    expect(pythonNoTestsMessage('/some/root')).toContain('/some/root');
  });
});
