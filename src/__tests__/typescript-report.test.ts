import { describe, expect, it } from 'vitest';
import {
  parseStrykerReportByFile,
  scoreStrykerReport,
  type StrykerJsonReport,
} from '../engines/typescript/report.js';

function report(file: string, id: string, status: string): StrykerJsonReport {
  return {
    files: {
      [file]: {
        source: 'const value = 1;\n',
        mutants: [
          {
            id,
            mutatorName: 'ArithmeticOperator',
            replacement: '2',
            location: { start: { line: 1, column: 15 }, end: { line: 1, column: 16 } },
            status,
          },
        ],
      },
    },
  };
}

describe('parseStrykerReportByFile', () => {
  it('scores each report file exactly like the existing single-file parser', () => {
    const first = report('a.ts', '1', 'Survived');
    const second = report('b.ts', '2', 'Killed');
    const combined: StrykerJsonReport = { files: { ...first.files, ...second.files } };
    const grouped = parseStrykerReportByFile(combined, ['a.ts', 'b.ts']);
    expect(grouped?.get('a.ts')).toEqual(scoreStrykerReport(first, 'a.ts', 'whole-file'));
    expect(grouped?.get('b.ts')).toEqual(scoreStrykerReport(second, 'b.ts', 'whole-file'));
  });

  it('returns undefined when a requested file is absent', () => {
    expect(
      parseStrykerReportByFile(report('a.ts', '1', 'Killed'), ['a.ts', 'b.ts']),
    ).toBeUndefined();
  });

  it('returns undefined when the report contains an unrequested file', () => {
    const raw: StrykerJsonReport = {
      files: { ...report('a.ts', '1', 'Killed').files, ...report('b.ts', '2', 'Killed').files },
    };
    expect(parseStrykerReportByFile(raw, ['a.ts'])).toBeUndefined();
  });

  it('keeps the single-file parser unchanged', () => {
    const raw = report('a.ts', '1', 'NoCoverage');
    expect(scoreStrykerReport(raw, 'a.ts', 'scoped')).toEqual(
      parseStrykerReportByFile(raw, ['a.ts'], 'scoped')?.get('a.ts'),
    );
  });
});
