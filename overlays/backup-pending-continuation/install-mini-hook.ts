import { fileURLToPath } from 'node:url';
import { INSTALL_SCOPE, installCombinedHook } from '../mini-writer/postinstall.ts';

export { MINI_HOSTNAME, isMiniWriter } from '../mini-writer/host.ts';

export function installMiniHook(host?: string): 'installed' | 'refused' {
  return installCombinedHook(host);
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const outcome = installMiniHook();
  process.stdout.write(`${outcome}: ${INSTALL_SCOPE}\n`);
  process.exit(0);
}
