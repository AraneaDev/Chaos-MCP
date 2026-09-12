// Rewrites src/engines/capabilities.baseline.json from the built matrix.
// Run after `npm run build` whenever the parity test says parity went up.
import { writeFileSync } from 'node:fs';
import { CAPABILITIES } from '../build/engines/capabilities.js';

const PATH = new URL('../src/engines/capabilities.baseline.json', import.meta.url);
writeFileSync(PATH, `${JSON.stringify(CAPABILITIES, null, 2)}\n`);
console.log(`Parity baseline updated: ${PATH.pathname}`);
