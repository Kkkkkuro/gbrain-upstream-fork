import { hostname } from 'node:os';

export const MINI_HOSTNAME = 'KuroChendeMac-mini.local';

export const INSTALL_SCOPE = 'Mini only. Mini is the only writer. Do not install this hook on any other machine, and do not add it to github:garrytan/gbrain.';

export function isMiniWriter(host = hostname()): boolean {
  return host === MINI_HOSTNAME;
}
