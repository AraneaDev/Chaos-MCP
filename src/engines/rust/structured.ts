import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StructuredMutant {
  file: string;
  line: number;
  column: number;
  description: string;
  replacement: string;
  genre: string;
  span: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}

export interface StructuredSummary {
  caught: number;
  missed: number;
  timeout: number;
  unviable: number;
}

interface Position {
  line: number;
  column: number;
}

function position(value: unknown): Position | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.line === 'number' &&
    Number.isInteger(candidate.line) &&
    candidate.line >= 1 &&
    typeof candidate.column === 'number' &&
    Number.isInteger(candidate.column) &&
    candidate.column >= 1
    ? { line: candidate.line, column: candidate.column }
    : undefined;
}

function span(value: unknown): StructuredMutant['span'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const start = position(candidate.start);
  const end = position(candidate.end);
  return start && end
    ? {
        startLine: start.line,
        startColumn: start.column,
        endLine: end.line,
        endColumn: end.column,
      }
    : undefined;
}

function readJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function descriptionFromName(name: string, file: string): string | undefined {
  const prefix = `${file}:`;
  if (!name.startsWith(prefix)) return undefined;
  const location = name.slice(prefix.length).match(/^\d+:\d+:\s*(.*)$/);
  return location?.[1] ? location[1].trim() : undefined;
}

function parseMutants(value: unknown): StructuredMutant[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: StructuredMutant[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const record = item as Record<string, unknown>;
    const file = typeof record.file === 'string' ? record.file : undefined;
    const name = typeof record.name === 'string' ? record.name : undefined;
    const replacement = typeof record.replacement === 'string' ? record.replacement : undefined;
    const genre = typeof record.genre === 'string' ? record.genre : undefined;
    const mutantSpan = span(record.span);
    if (!file || !name || replacement === undefined || !genre || !mutantSpan) return undefined;
    const description = descriptionFromName(name, file);
    if (!description) return undefined;
    parsed.push({
      file,
      line: mutantSpan.startLine,
      column: mutantSpan.startColumn,
      description,
      replacement,
      genre,
      span: mutantSpan,
    });
  }
  return parsed;
}

function parseSummary(value: unknown): StructuredSummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.outcomes)) return undefined;
  const summary: StructuredSummary = { caught: 0, missed: 0, timeout: 0, unviable: 0 };
  for (const outcome of record.outcomes) {
    if (typeof outcome !== 'object' || outcome === null) return undefined;
    const item = outcome as Record<string, unknown>;
    if (item.scenario === 'Baseline') continue;
    if (typeof item.scenario !== 'object' || item.scenario === null) return undefined;
    const scenario = item.scenario as Record<string, unknown>;
    if (typeof scenario.Mutant !== 'object' || scenario.Mutant === null) return undefined;
    if (item.summary === 'CaughtMutant') summary.caught += 1;
    else if (item.summary === 'MissedMutant') summary.missed += 1;
    else if (item.summary === 'Timeout') summary.timeout += 1;
    else if (item.summary === 'Unviable') summary.unviable += 1;
    else return undefined;
  }
  const numberField = (key: keyof StructuredSummary): number | undefined =>
    typeof record[key] === 'number' ? (record[key] as number) : undefined;
  for (const key of ['caught', 'missed', 'timeout', 'unviable'] as const) {
    const valueForKey = numberField(key);
    if (valueForKey === undefined || valueForKey !== summary[key]) return undefined;
  }
  return summary;
}

function outputDirectory(dir: string): string {
  return existsSync(join(dir, 'mutants.json')) ? dir : join(dir, 'mutants.out');
}

/** Read a cargo-mutants output directory without throwing on stale or malformed files. */
export function readStructuredOutput(dir: string): StructuredMutant[] | undefined {
  const root = outputDirectory(dir);
  const mutants = parseMutants(readJson(join(root, 'mutants.json')));
  const summary = parseSummary(readJson(join(root, 'outcomes.json')));
  return mutants && summary ? mutants : undefined;
}

/** Read the aggregate outcome counts used to cross-check cargo-mutants stdout. */
export function readStructuredSummary(dir: string): StructuredSummary | undefined {
  return parseSummary(readJson(join(outputDirectory(dir), 'outcomes.json')));
}

/** Join each stdout result to exactly one structured mutant, or signal fallback. */
export function joinToStructured<T extends { file: string; line: number; description: string }>(
  results: T[],
  structured: StructuredMutant[],
): Map<T, StructuredMutant> | undefined {
  const joined = new Map<T, StructuredMutant>();
  for (const result of results) {
    const matches = structured.filter(
      (mutant) =>
        mutant.file === result.file &&
        mutant.line === result.line &&
        mutant.description === result.description,
    );
    if (matches.length !== 1) return undefined;
    joined.set(result, matches[0]);
  }
  return joined;
}
