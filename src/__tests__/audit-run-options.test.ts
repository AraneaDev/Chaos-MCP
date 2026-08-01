import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isPrebuildAllowed, resolveGatedPrebuild } from '../audit/run-options.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ToolArgs } from '../core/tool-args-validation.js';

/**
 * `audit/run-options.ts` had no test file, and the code it holds includes the gate on
 * `prebuildCommand` — an arbitrary shell command that, by the gate's own wording, "can
 * reach outside the sandbox". A permission check with no test is the one kind worth
 * writing first: it fails open silently, and nothing else in the system re-checks it.
 *
 * Both opt-in routes and every refusal path are asserted, in both directions. A gate
 * forced open and a gate forced shut are different bugs, and only the case each one
 * changes can see it.
 */

const env = (): EnvironmentInfo => ({
  projectType: 'typescript',
  testRunner: 'vitest',
  detectedRunner: 'vitest',
  packageManager: '',
  workspaceRoot: '/workspace',
});

const gate = (args: ToolArgs, cfg = {}) => resolveGatedPrebuild(args, env(), 'typescript', cfg);

const ORIGINAL_FLAG = process.env.CHAOS_MCP_ALLOW_PREBUILD;

beforeEach(() => {
  delete process.env.CHAOS_MCP_ALLOW_PREBUILD;
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.CHAOS_MCP_ALLOW_PREBUILD;
  else process.env.CHAOS_MCP_ALLOW_PREBUILD = ORIGINAL_FLAG;
});

describe('isPrebuildAllowed', () => {
  it('is closed by default', () => {
    expect(isPrebuildAllowed({})).toBe(false);
  });

  it('opens on the config flag', () => {
    expect(isPrebuildAllowed({ allowPrebuild: true })).toBe(true);
  });

  it('stays closed for a non-true config value', () => {
    // `=== true`, not truthiness: a config that says "yes" or 1 must not open a shell.
    expect(isPrebuildAllowed({ allowPrebuild: 'true' as unknown as boolean })).toBe(false);
    expect(isPrebuildAllowed({ allowPrebuild: 1 as unknown as boolean })).toBe(false);
  });

  it('opens on either accepted spelling of the environment flag', () => {
    process.env.CHAOS_MCP_ALLOW_PREBUILD = '1';
    expect(isPrebuildAllowed({})).toBe(true);
    process.env.CHAOS_MCP_ALLOW_PREBUILD = 'true';
    expect(isPrebuildAllowed({})).toBe(true);
  });

  it('stays closed for any other environment value', () => {
    // Guards the exact-match comparisons: a bare presence check would open the gate
    // for '0' and 'false', which are the spellings a user reaches for to DISABLE it.
    for (const value of ['0', 'false', '', 'yes', 'TRUE']) {
      process.env.CHAOS_MCP_ALLOW_PREBUILD = value;
      expect(isPrebuildAllowed({})).toBe(false);
    }
  });
});

describe('resolveGatedPrebuild', () => {
  it('refuses an explicit prebuildCommand while the gate is closed', () => {
    const decision = gate({ prebuildCommand: 'rm -rf /' });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.message).toContain('disabled by default');
    expect(decision.message).toContain('CHAOS_MCP_ALLOW_PREBUILD');
  });

  it('allows an explicit prebuildCommand once the config opts in', () => {
    const decision = gate({ prebuildCommand: 'npm run build' }, { allowPrebuild: true });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.prebuildCmd).toBe('npm run build');
  });

  it('allows an explicit prebuildCommand once the environment opts in', () => {
    process.env.CHAOS_MCP_ALLOW_PREBUILD = '1';
    const decision = gate({ prebuildCommand: 'npm run build' });

    expect(decision.ok).toBe(true);
  });

  it('does not gate a prebuild the server chose for itself', () => {
    // The gate is on the CALLER's command, not on any prebuild at all. Rust declares an
    // auto-prebuild (`cargo check`, keyed on Cargo.toml), and refusing it would break
    // ordinary Rust audits outright while the gate is closed — which is the default. So
    // the refusal has to depend on the argument having been SUPPLIED, not merely on a
    // command existing. Without a workspace that triggers an engine default, this case
    // is unreachable and the `prebuildExplicit &&` conjunct is untestable.
    const rustWs = mkdtempSync(join(tmpdir(), 'chaos-prebuild-'));
    try {
      writeFileSync(join(rustWs, 'Cargo.toml'), '[package]\nname = "x"\n');
      const decision = resolveGatedPrebuild({}, { ...env(), workspaceRoot: rustWs }, 'rust', {});

      expect(decision.ok).toBe(true);
      if (!decision.ok) return;
      expect(decision.prebuildCmd).toBe('cargo check');
    } finally {
      rmSync(rustWs, { recursive: true, force: true });
    }
  });

  it('treats a whitespace-only command as not supplied', () => {
    // A blank string must not count as "explicitly requested" and trip the refusal.
    const decision = gate({ prebuildCommand: '   ' });

    expect(decision.ok).toBe(true);
  });
});
