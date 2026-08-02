import type { SupportedProjectType } from '../project-detector.js';
import type { ContainerConfig } from '../config-loader.js';
import type { ExecResult } from '../exec-error.js';
import { runShell } from '../exec.js';
import { DEFAULT_IMAGES, type ExecutionMode } from '../execution.js';

export interface ContainerDoctorReport {
  runtime: string;
  available: boolean;
  serverVersion?: string;
  mode: ExecutionMode;
  images: Record<SupportedProjectType, { image: string; present: boolean }>;
}

/** Read-only runtime/image diagnostics used by the CLI doctor command. */
export async function inspectContainerRuntime(
  config: ContainerConfig | undefined,
): Promise<ContainerDoctorReport> {
  const runtime = config?.runtime ?? 'docker';
  const images = Object.fromEntries(
    (Object.keys(DEFAULT_IMAGES) as SupportedProjectType[]).map((language) => [
      language,
      {
        image: config?.images?.[language] ?? DEFAULT_IMAGES[language],
        present: false,
      },
    ]),
  ) as ContainerDoctorReport['images'];
  let version: ExecResult;
  try {
    version = await runShell(runtime, ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: config?.startupTimeoutMs ?? 10_000,
      killTree: true,
    });
  } catch {
    return { runtime, available: false, mode: config?.mode ?? 'native', images };
  }
  for (const language of Object.keys(images) as SupportedProjectType[]) {
    try {
      await runShell(runtime, ['image', 'inspect', images[language].image], {
        timeoutMs: config?.startupTimeoutMs ?? 10_000,
        killTree: true,
      });
      images[language].present = true;
    } catch {
      // Missing images are reported, not pulled or treated as a doctor crash.
    }
  }
  return {
    runtime,
    available: true,
    serverVersion: version.stdout.trim(),
    mode: config?.mode ?? 'native',
    images,
  };
}
