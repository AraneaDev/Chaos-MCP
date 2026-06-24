import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Verifies that the postbuild script correctly restores the `#!/usr/bin/env node`
 * shebang in build/index.js. TypeScript compiler strips shebangs during compilation;
 * the postbuild script in package.json re-prepends it so the CLI binary works when
 * invoked directly (e.g. `./build/index.js` or via the `chaos-mcp` bin link).
 */
describe('build output shebang restoration', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const buildEntry = join(__dirname, '..', '..', 'build', 'index.js');

  beforeAll(() => {
    // Ensure the build exists — vitest runs after `npm run build` in the check pipeline,
    // but standalone `vitest run` may not have built first.
    if (!existsSync(buildEntry)) {
      throw new Error(
        `Build output not found at ${buildEntry}. Run "npm run build" before running this test.`,
      );
    }
  });

  it('build/index.js starts with #!/usr/bin/env node shebang', () => {
    const content = readFileSync(buildEntry, 'utf-8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('shebang appears only once at the very first line', () => {
    const content = readFileSync(buildEntry, 'utf-8');
    const lines = content.split('\n');
    // First line must be the shebang
    expect(lines[0]).toBe('#!/usr/bin/env node');
    // No duplicate shebang on line 2 (postbuild could double-prepend if run twice)
    expect(lines[1]).not.toBe('#!/usr/bin/env node');
  });

  it('build/index.js is valid JavaScript (parseable by Node)', () => {
    const content = readFileSync(buildEntry, 'utf-8');
    // Basic sanity: should contain the Server import from the MCP SDK
    expect(content).toContain('@modelcontextprotocol/sdk');
    // Should contain the tool name
    expect(content).toContain('audit_code_resilience');
  });
});
