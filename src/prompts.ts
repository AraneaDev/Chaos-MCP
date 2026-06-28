export interface PromptListing {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
}
export interface PromptResult {
  description: string;
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
}

export function listPrompts(): PromptListing[] {
  return [
    {
      name: 'harden_file',
      description:
        'Walk through hardening one file: audit → write tests for survivors → verify by runId → repeat.',
      arguments: [
        { name: 'filePath', description: 'Path to the source file to harden.', required: true },
      ],
    },
    {
      name: 'triage_changes',
      description: "Triage a PR's changed files weakest-first, then harden the weakest.",
      arguments: [
        {
          name: 'diffBase',
          description: 'Git base to diff against (e.g. "main", "HEAD", "staged").',
          required: true,
        },
      ],
    },
  ];
}

function userMessage(text: string): PromptResult['messages'] {
  return [{ role: 'user', content: { type: 'text', text } }];
}

function requireArg(args: Record<string, string>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return v;
}

export function getPrompt(name: string, args: Record<string, string>): PromptResult {
  switch (name) {
    case 'harden_file': {
      const filePath = requireArg(args, 'filePath');
      return {
        description: `Harden ${filePath} against surviving mutants.`,
        messages: userMessage(
          [
            `Harden the test coverage of \`${filePath}\` using Chaos-MCP. Steps:`,
            `1. (Optional) Call estimate_audit on \`${filePath}\` to gauge size/cost.`,
            `2. Call audit_code_resilience on \`${filePath}\`. Note the returned runId and the survivor list.`,
            `3. For each surviving mutant, add or strengthen a test that would kill it (target the reported line + mutator).`,
            `4. Re-run audit_code_resilience with that runId to verify the previously-surviving mutants are now killed.`,
            `5. Repeat until clean. Only suppress a mutant (suppress arg) if it is genuinely equivalent (unkillable).`,
          ].join('\n'),
        ),
      };
    }
    case 'triage_changes': {
      const diffBase = requireArg(args, 'diffBase');
      return {
        description: `Triage files changed vs ${diffBase}.`,
        messages: userMessage(
          [
            `Find the weakest test coverage among the files changed versus \`${diffBase}\`:`,
            `1. Call triage_test_coverage with diffBase="${diffBase}" to rank the changed files weakest-first.`,
            `2. Take the weakest file from the ranking and harden it: audit_code_resilience → write tests for survivors → verify by runId.`,
            `3. Move down the ranking until the changed files meet your bar (use minScore to gate).`,
          ].join('\n'),
        ),
      };
    }
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
