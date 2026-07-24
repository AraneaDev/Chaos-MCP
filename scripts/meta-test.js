#!/usr/bin/env node
/**
 * Meta-test: run chaos-mcp's audit_code_resilience against ChaosMCP's own source.
 *
 * Tests the full pipeline: handler → engine dispatch → sandbox → StrykerJS →
 * result parsing, all within the project's own workspace.
 *
 * Run: node scripts/meta-test.js    (from the project root)
 *
 * This check is intentionally non-skippable once invoked: Chaos-MCP uses
 * Stryker's built-in command runner for Vitest 3, so only core is required.
 * A missing engine/build or a timeout is a failed dogfood check, not success.
 *
 * Implementation note: the early-return guard runs synchronously inside
 * `main()` BEFORE the dynamic `import('../build/index.js')` resolves, so
 * a missing Stryker install (or missing `build/`) does NOT cause the
 * build/index.js module to load. Top-level imports use only cheap
 * node:* modules (fs/path/url) so module-init has no project side
 * effects.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const strykerInstalled = existsSync(join(projectRoot, 'node_modules', '@stryker-mutator', 'core'));
const buildIndexExists = existsSync(join(projectRoot, 'build', 'index.js'));

async function main() {
  if (!strykerInstalled) {
    console.error('Meta-test failed: @stryker-mutator/core is not installed.');
    console.error('   Run `npm install` before the dogfood audit.');
    return 1;
  }
  if (!buildIndexExists) {
    console.error('Meta-test failed: build/index.js not present.');
    console.log('   Run `npm run build` first to compile chaos-mcp.');
    return 1;
  }

  // Both preconditions met → load the built entrypoint dynamically and exercise
  // the full pipeline against our own source.
  const { handleToolCall } = await import('../build/index.js');

  // Build a mock CallToolRequest (plain JS — no TS-specific syntax in this file)
  const request = {
    method: 'tools/call',
    params: {
      name: 'audit_code_resilience',
      arguments: {
        filePath: 'src/gate.ts',
        timeoutMs: 180000,
        mutatorDenylist: ['StringLiteral'],
        concurrency: 2,
      },
    },
  };

  console.log('Running chaos-mcp against its own source: src/gate.ts');
  console.log('   (tests the full pipeline: handler → sandbox → StrykerJS → parse)');
  console.log('');

  const start = Date.now();
  try {
    const response = await handleToolCall(request);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (response.isError) {
      const text = response.content[0].text;
      console.log(`Tool returned an error after ${elapsed}s:`);
      console.log(`   ${text}`);
      return 1;
    } else {
      const text = response.content[0].text;
      const result = JSON.parse(text);
      const { total, killed, survived } = result.summary ?? {};
      console.log(`Mutation audit complete (${elapsed}s):`);
      console.log(`   Target:         ${result.target}`);
      console.log(`   Total mutants:  ${total}`);
      console.log(`   Killed:         ${killed}`);
      console.log(`   Survived:       ${survived}`);
      console.log(`   Mutation score: ${result.mutationScore}`);
      const allSurvivors = [...(result.survivors ?? []), ...(result.noCoverage ?? [])];
      if (allSurvivors.length > 0) {
        console.log(`   Survivors: ${allSurvivors.length}`);
        for (const v of allSurvivors.slice(0, 5)) {
          const mutators = Object.entries(v.mutators)
            .map(([m, n]) => (n > 1 ? `${m}×${n}` : m))
            .join(', ');
          const changes = v.changes ? ` [${v.changes.join('; ')}]` : '';
          console.log(`     Line ${v.line}: ${mutators}${changes}`);
        }
        if (allSurvivors.length > 5) {
          console.log(`     ... and ${allSurvivors.length - 5} more`);
        }
      } else {
        console.log('   No surviving mutants!');
      }
      return 0;
    }
  } catch (error) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Crash after ${elapsed}s: ${message}`);
    return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Unhandled: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
