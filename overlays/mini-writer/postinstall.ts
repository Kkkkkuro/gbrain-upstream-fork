import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_SCOPE, isMiniWriter } from './host.ts';

const REAPPLY = [
  'overlays/backup-pending-continuation/reapply.ts',
  'overlays/subject-infer-alias/reapply.ts',
] as const;

export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function postinstallCommand(): string {
  return `bun ${join(dirname(fileURLToPath(import.meta.url)), 'postinstall.ts')}`;
}

export function runCombinedPostinstall(host?: string): number {
  if (!isMiniWriter(host)) {
    process.stdout.write(`postinstall skipped: not the Mini writer. ${INSTALL_SCOPE}\n`);
    return 0;
  }
  const root = repoRoot();
  let failed = 0;
  for (const rel of REAPPLY) {
    const script = join(root, rel);
    if (!existsSync(script)) {
      process.stdout.write(`postinstall skip missing ${rel}\n`);
      continue;
    }
    const result = spawnSync('bun', [script], { encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) failed = result.status ?? 1;
  }
  return failed;
}

export function installCombinedHook(host?: string): 'installed' | 'refused' {
  if (!isMiniWriter(host)) return 'refused';
  const path = join(homedir(), '.bun', 'install', 'global', 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  pkg.scripts = { ...(pkg.scripts ?? {}), postinstall: postinstallCommand() };
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return 'installed';
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const code = runCombinedPostinstall();
  process.exit(code);
}
