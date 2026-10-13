import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MINI_HOST = 'KuroChendeMac-mini';
export const INSTALL_SCOPE = 'Mini only. Mini is the only writer. Do not install this hook on any other machine, and do not add it to github:garrytan/gbrain.';

export function isMiniWriter(host = hostname()): boolean {
  return host === MINI_HOST || host.startsWith(`${MINI_HOST}.`);
}

export function postinstallCommand(overlayDir = dirname(fileURLToPath(import.meta.url))): string {
  return `bun ${join(overlayDir, 'reapply.ts')}`;
}

export function globalPackagePath(): string {
  return join(homedir(), '.bun', 'install', 'global', 'package.json');
}

export function installMiniHook(host = hostname()): 'installed' | 'refused' {
  if (!isMiniWriter(host)) return 'refused';
  const path = globalPackagePath();
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string>; scripts?: Record<string, string> };
  pkg.scripts = { ...(pkg.scripts ?? {}), postinstall: postinstallCommand() };
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return 'installed';
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const outcome = installMiniHook();
  process.stdout.write(`${outcome}: ${INSTALL_SCOPE}\n`);
  process.exit(0);
}
