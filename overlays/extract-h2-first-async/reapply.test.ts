import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchPath, reapplyExtractH2FirstAsync } from './reapply.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'extract-h2-first-async-reapply-'));
  cpSync(FIXTURES, root, { recursive: true });
  return root;
}

function files(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(path, readFileSync(path));
    }
  };
  walk(root);
  return out;
}

describe('reapply extract-h2-first-async', () => {
  test('applies the 100-baseline fixture once and a second run stays present', () => {
    const root = tree();
    try {
      expect(reapplyExtractH2FirstAsync(root, patchPath()).result).toBe('applied');
      expect(reapplyExtractH2FirstAsync(root, patchPath()).result).toBe('present');
      expect(readFileSync(join(root, 'src/core/persistence/atom-maintenance.ts'), 'utf8')).toContain(
        'outcome?.extract_halt_attributed === true',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed apply after a successful dry-run restores the snapshot', () => {
    const root = tree();
    try {
      const before = files(root);
      const target = join(root, 'src/core/persistence/atom-maintenance.ts');
      const outcome = reapplyExtractH2FirstAsync(root, patchPath(), () => {
        writeFileSync(target, 'half applied\n');
        writeFileSync(`${target}.rej`, 'reject\n');
        return { status: 1, stdout: '', stderr: 'apply failed\n' };
      });
      expect(outcome.result).toBe('failed');
      const after = files(root);
      expect(after.size).toBe(before.size);
      for (const [path, bytes] of before) {
        expect(after.get(path)?.equals(bytes)).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('partial markers refuse to patch', () => {
    const root = tree();
    try {
      mkdirSync(join(root, 'test'), { recursive: true });
      writeFileSync(
        join(root, 'test/h2-first-async-halt.test.ts'),
        'first observed conflict after an earlier pending phase must contribute its first halt\n',
      );
      expect(reapplyExtractH2FirstAsync(root, patchPath()).result).toBe('partial');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
