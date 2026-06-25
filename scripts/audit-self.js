#!/usr/bin/env node
/**
 * Run mutation audit against a ChaosMCP source file.
 * Usage: node scripts/audit-self.js <filePath>
 */

import { handleToolCall } from '../build/index.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/audit-self.js <filePath>');
  process.exit(1);
}

const request = {
  method: 'tools/call',
  params: {
    name: 'audit_code_resilience',
    arguments: {
      filePath,
      timeoutMs: 120000,
      mutatorDenylist: ['StringLiteral'],
      concurrency: 4,
    },
  },
};

const start = Date.now();
try {
  const response = await handleToolCall(request);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (response.isError) {
    const text = response.content[0].text;
    console.log(`FAIL|${filePath}|${elapsed}s|ERROR|${text.slice(0, 300).replace(/\n/g, ' ')}`);
  } else {
    const text = response.content[0].text;
    const result = JSON.parse(text);
    console.log(`OK|${filePath}|${elapsed}s|${result.totalMutants}|${result.killed}|${result.survived}|${result.mutationScore}`);
    if (result.vulnerabilities.length > 0) {
      for (const v of result.vulnerabilities.slice(0, 5)) {
        console.log(`  VULN|L${v.line}|[${v.replacement}]|${v.description}`);
      }
      if (result.vulnerabilities.length > 5) {
        console.log(`  ... and ${result.vulnerabilities.length - 5} more`);
      }
    }
  }
} catch (error) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const message = error instanceof Error ? error.message : String(error);
  console.log(`CRASH|${filePath}|${elapsed}s|${message}`);
}
