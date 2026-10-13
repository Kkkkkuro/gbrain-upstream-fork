import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolutePostinstallCommand, runPostinstall } from './postinstall.ts';
import { patchPath, reapplySubjectInfer } from './reapply.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'subject-infer-reapply-'));
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

function sameBytes(before: Map<string, Buffer>, root: string): boolean {
  const after = files(root);
  if (before.size !== after.size) return false;
  for (const [path, bytes] of before) {
    const next = after.get(path);
    if (!next || !next.equals(bytes)) return false;
  }
  return true;
}

describe('reapply subject-infer alias', () => {
  test('applies the stock fixture once and a second run stays present', () => {
    const root = tree();
    try {
      expect(reapplySubjectInfer(root, patchPath()).result).toBe('applied');
      expect(reapplySubjectInfer(root, patchPath()).result).toBe('present');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed apply after a successful dry-run restores the snapshot', () => {
    const root = tree();
    try {
      const before = files(root);
      const target = join(root, 'src/core/facts/subject-infer.ts');
      const outcome = reapplySubjectInfer(root, patchPath(), () => {
        writeFileSync(target, 'half applied\n');
        writeFileSync(`${target}.rej`, 'reject\n');
        return { status: 1, stdout: '', stderr: 'apply failed\n' };
      });
      expect(outcome.result).toBe('failed');
      expect(outcome.output).toContain('apply failed');
      expect(sameBytes(before, root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the installed postinstall command is an absolute path', () => {
    const command = absolutePostinstallCommand();
    const script = command.slice('bun '.length);
    expect(command.startsWith('bun ')).toBe(true);
    expect(isAbsolute(script)).toBe(true);
    const pkg = JSON.parse(readFileSync(join(HERE, 'mini-global-package.json'), 'utf8')) as { scripts: { postinstall: string } };
    const installed = pkg.scripts.postinstall.slice('bun '.length);
    expect(pkg.scripts.postinstall.startsWith('bun ')).toBe(true);
    expect(isAbsolute(installed)).toBe(true);
    expect(installed.includes(`${join('overlays', 'subject-infer-alias', 'postinstall.ts')}`) || installed.endsWith('postinstall.ts')).toBe(true);
  });

  test('partial markers exit without patching', () => {
    const root = tree();
    try {
      const target = join(root, 'src/core/facts/subject-infer.ts');
      writeFileSync(target, `${readFileSync(target, 'utf8')}\nasync function aliasSlugsContained() {}\n`);
      const before = files(root);
      const outcome = reapplySubjectInfer(root, patchPath());
      expect(outcome.result).toBe('partial');
      expect(outcome.output).toContain('partial');
      expect(sameBytes(before, root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('upstream bytes that do not match exit 1 and leave the file unchanged', () => {
    const root = tree();
    try {
      const target = join(root, 'src/core/facts/subject-infer.ts');
      writeFileSync(target, 'this is not the upstream file\n');
      const before = files(root);
      const outcome = reapplySubjectInfer(root, patchPath());
      expect(outcome.result).toBe('failed');
      expect(outcome.output.length).toBeGreaterThan(0);
      expect(sameBytes(before, root)).toBe(true);
      expect(runPostinstall('not-the-mini', root)).toBe(0);
      expect(sameBytes(before, root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('postinstall on the Mini reports failure when upstream bytes do not match', () => {
    const root = tree();
    try {
      mkdirSync(join(root, 'src/core/facts'), { recursive: true });
      writeFileSync(join(root, 'src/core/facts/subject-infer.ts'), 'not upstream\n');
      writeFileSync(join(root, 'test/facts-subject-infer.test.ts'), 'not upstream\n');
      const before = files(root);
      expect(runPostinstall('KuroChendeMac-mini.local', root)).toBe(1);
      expect(sameBytes(before, root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
