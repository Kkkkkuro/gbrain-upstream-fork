import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapplyBackupPatch } from './reapply.ts';

const UPSTREAM = '/Users/kurochen_macmini/.bun/install/cache/@GH@garrytan-gbrain-52a1024@@@1';

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-reapply-'));
  for (const rel of [
    'src/core/backup/status-file.ts',
    'src/core/backup/coverage.ts',
    'src/commands/autopilot-daemon.ts',
  ]) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    cpSync(join(UPSTREAM, rel), join(root, rel));
  }
  return root;
}

describe('reapply backup pending continuation', () => {
  test('applies the patch onto 0.60.187 bytes and a second run stays present', () => {
    const root = fixtureRoot();
    try {
      expect(reapplyBackupPatch(root)).toBe('applied');
      expect(reapplyBackupPatch(root)).toBe('present');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
