import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REAPPLY } from '../mini-writer/postinstall.ts';
import {
  FIXTURE_CITY,
  FIXTURE_REL,
  PLACEHOLDER_CITY,
  checkNightlyFixtureCity,
  reapplyNightlyFixtureCity,
} from './reapply.ts';

const UPSTREAM_LINE = `{"question_id":"nightly-5","answer":"${PLACEHOLDER_CITY}","haystack_sessions":[[{"role":"assistant","content":"held in ${PLACEHOLDER_CITY}"}]]}\n`;

function rootWith(body: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'nightly-fixture-city-'));
  if (body !== null) {
    const path = join(root, FIXTURE_REL);
    mkdirSync(join(root, 'test', 'fixtures'), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

test('reapply replaces placeholder-city and a second run does not write', () => {
  const root = rootWith(UPSTREAM_LINE);
  try {
    expect(reapplyNightlyFixtureCity(root)).toBe('applied');
    const once = readFileSync(join(root, FIXTURE_REL), 'utf8');
    expect(once.includes(PLACEHOLDER_CITY)).toBe(false);
    expect(once.includes(FIXTURE_CITY)).toBe(true);
    expect(reapplyNightlyFixtureCity(root)).toBe('present');
    expect(readFileSync(join(root, FIXTURE_REL), 'utf8')).toBe(once);
    expect(checkNightlyFixtureCity(root)).toBe('ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check fails while placeholder-city is present and does not rewrite the file', () => {
  const root = rootWith(UPSTREAM_LINE);
  try {
    const before = readFileSync(join(root, FIXTURE_REL));
    expect(checkNightlyFixtureCity(root)).toBe('placeholder-city');
    expect(readFileSync(join(root, FIXTURE_REL)).equals(before)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing fixture fails the check', () => {
  const root = rootWith(null);
  try {
    expect(reapplyNightlyFixtureCity(root)).toBe('missing');
    expect(checkNightlyFixtureCity(root)).toBe('missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the shared postinstall runs this reapply', () => {
  expect(REAPPLY).toContain('overlays/nightly-fixture-city/reapply.ts');
});
