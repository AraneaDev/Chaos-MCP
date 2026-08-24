import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertStrykerInstalled } from '../engines/typescript.js';
import { MutationToolStartupError } from '../utils/exec-classify.js';
import type { RunOptions } from '../engines/base.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'chaos-preflight-'));
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

/** Put a StrykerJS install in the workspace, as a package manager would. */
function installStryker(root: string): void {
  const dir = join(root, 'node_modules', '@stryker-mutator', 'core');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"@stryker-mutator/core"}');
}

/** Run `fn` and hand back whatever it threw, so assertions stay unconditional. */
function thrownBy(fn: () => void): unknown {
  try {
    fn();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

describe('assertStrykerInstalled', () => {
  it('passes when StrykerJS is installed in the workspace', () => {
    installStryker(ws);
    expect(() => assertStrykerInstalled({ workDir: ws } as RunOptions)).not.toThrow();
  });

  it('fails fast, and as NOT_INSTALLED, when StrykerJS is absent', () => {
    // Without this the run reaches stryker-cli, which asks whether to install
    // Stryker and blocks on an answer no sandbox can give. There is no ENOENT
    // to classify, so the failure has to be raised before spawning.
    const error = thrownBy(() => assertStrykerInstalled({ workDir: ws } as RunOptions));

    expect(error).toBeInstanceOf(MutationToolStartupError);
    expect((error as MutationToolStartupError).reason).toBe('NOT_INSTALLED');
    expect((error as MutationToolStartupError).tool).toBe('StrykerJS');
  });

  it('names the install command and explains why a global stryker is not enough', () => {
    const error = thrownBy(() => assertStrykerInstalled({ workDir: ws } as RunOptions));

    expect((error as Error).message).toContain('npm install --save-dev @stryker-mutator/core');
    expect((error as Error).message).toContain('stryker-cli');
  });

  it('exempts container runs, where the image supplies StrykerJS', () => {
    const options = { workDir: ws, executor: { kind: 'container' } } as unknown as RunOptions;
    expect(() => assertStrykerInstalled(options)).not.toThrow();
  });
});
