#!/usr/bin/env node
/**
 * Meta-test: run chaos-mcp's audit_code_resilience against ChaosMCP's own source.
 *
 * Tests the full pipeline: handler → engine dispatch → sandbox → StrykerJS →
 * result parsing, all within the project's own workspace.
 *
 * Run: node scripts/meta-test.js    (from the project root)
 *
 * IMPORTANT: The workspace must have @stryker-mutator/core and
 * @stryker-mutator/vitest-runner installed (they're devDeps).
 * node_modules is symlinked into the sandbox, so Stryker is available
 * even though it's excluded from the cpSync copy.
 */
import { handleToolCall } from '../build/index.js';

// Build a mock CallToolRequest (plain JS — no TS-specific syntax in this file)
const request = {
  method: 'tools/call',
  params: {
    name: 'audit_code_resilience',
    arguments: {
      filePath: 'src/utils/exec-classify.ts',
      timeoutMs: 120000,
      mutatorDenylist: ['StringLiteral'],
      concurrency: 4,
    },
  },
};

console.log('Running chaos-mcp against its own source: src/utils/exec-classify.ts');
console.log('   (tests the full pipeline: handler → sandbox → StrykerJS → parse)');
console.log('');

const start = Date.now();
try {
  const response = await handleToolCall(request);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (response.isError) {
    const text = response.content[0].text;
    console.log(`Tool returned an error after ${elapsed}s:`);
    console.log(`   ${text.slice(0, 500)}`);
  } else {
    const text = response.content[0].text;
    const result = JSON.parse(text);
    console.log(`Mutation audit complete (${elapsed}s):`);
    console.log(`   Target:         ${result.target}`);
    console.log(`   Total mutants:  ${result.totalMutants}`);
    console.log(`   Killed:         ${result.killed}`);
    console.log(`   Survived:       ${result.survived}`);
    console.log(`   Mutation score: ${result.mutationScore}`);
    if (result.vulnerabilities.length > 0) {
      console.log(`   Vulnerabilities: ${result.vulnerabilities.length}`);
      for (const v of result.vulnerabilities.slice(0, 5)) {
        console.log(`     Line ${v.line}: [${v.replacement}] ${v.description}`);
      }
      if (result.vulnerabilities.length > 5) {
        console.log(`     ... and ${result.vulnerabilities.length - 5} more`);
      }
    } else {
      console.log('   No surviving mutants!');
    }
  }
  process.exit(response.isError ? 1 : 0);
} catch (error) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Crash after ${elapsed}s: ${message}`);
  process.exit(2);
}
