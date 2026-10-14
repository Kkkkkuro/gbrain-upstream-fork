import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reapplyBackupPatch } from './reapply.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upstream');
const FILES = [
  'src/core/backup/status-file.ts',
  'src/core/backup/coverage.ts',
  'src/commands/autopilot-daemon.ts',
];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-reapply-'));
  for (const rel of FILES) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    cpSync(join(FIXTURES, rel), join(root, rel));
  }
  return root;
}

function bytes(root: string): Map<string, Buffer> {
  return new Map(FILES.map((rel) => [rel, readFileSync(join(root, rel))]));
}

function leftovers(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else if (name.name.endsWith('.rej') || name.name.endsWith('.orig')) found.push(path);
    }
  };
  walk(root);
  return found;
}

describe('reapply backup pending continuation', () => {
  test('applies the committed upstream fixtures and a second run stays present', () => {
    const root = fixtureRoot();
    try {
      expect(reapplyBackupPatch(root).result).toBe('applied');
      expect(reapplyBackupPatch(root).result).toBe('present');
      expect(leftovers(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses a partial marker set without rewriting files', () => {
    const root = fixtureRoot();
    try {
      const status = join(root, 'src/core/backup/status-file.ts');
      writeFileSync(status, `${readFileSync(status, 'utf8')}\nexport function pendingBackupContinuationEligible() { return false; }\n`);
      const before = bytes(root);
      const outcome = reapplyBackupPatch(root);
      expect(outcome.result).toBe('partial');
      expect(outcome.patchOutput).toContain('partial markers');
      expect(bytes(root)).toEqual(before);
      expect(leftovers(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exits mismatch and leaves files unchanged when upstream bytes do not match', () => {
    const root = fixtureRoot();
    try {
      writeFileSync(join(root, 'src/core/backup/status-file.ts'), 'this is not the upstream file\n');
      const before = bytes(root);
      const outcome = reapplyBackupPatch(root);
      expect(outcome.result).toBe('mismatch');
      expect(outcome.patchOutput.length).toBeGreaterThan(0);
      expect(bytes(root)).toEqual(before);
      expect(leftovers(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
