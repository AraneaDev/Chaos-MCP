import { splitCommandArgs } from '../../utils/shell-quote.js';

const SELECTOR_OPTIONS = new Set(['--testsuite', '--filter', '--group', '--exclude-group']);

export type PhpCoverageScope = 'project' | 'selected';

export interface PhpCoverageSelection {
  raw: string;
  args: string[];
  scope: 'selected';
}

export function parsePhpCoverageSelection(
  raw: string | undefined,
): PhpCoverageSelection | undefined {
  if (raw === undefined) return undefined;

  const args = splitCommandArgs(raw);
  if (args.length === 0) throw new Error('PHP coverage options must select tests.');

  for (let index = 0; index < args.length; ) {
    const option = args[index];
    if (SELECTOR_OPTIONS.has(option)) {
      const value = args[index + 1];
      if (value === undefined || value === '') {
        throw new Error(`PHP coverage selector ${option} is missing a value.`);
      }
      index += 2;
      continue;
    }

    const isEqualsForm = [...SELECTOR_OPTIONS].some(
      (allowed) => option.startsWith(`${allowed}=`) && option.length > allowed.length + 1,
    );
    if (!isEqualsForm) {
      throw new Error(`Unsupported PHP coverage option: ${option}`);
    }
    index += 1;
  }

  return { raw, args, scope: 'selected' };
}
