import { expect, test } from 'bun:test';
import { readRecordedHaltReasons7d } from '../src/core/extract/rollup-writer.ts';
import { computeExtractHealthCheck } from '../src/commands/doctor/checks/extraction-sync.ts';

const rejecting = (error: unknown) => ({ executeRaw: async () => { throw error; } }) as any;

test('permission failure mentioning halt_reasons is propagated, never treated as old schema', async () => {
  const error = Object.assign(new Error('permission denied for halt_reasons'), { code: '42501' });
  await expect(readRecordedHaltReasons7d(rejecting(error))).rejects.toBe(error);
});

test('invalid halt_reasons data is propagated', async () => {
  const error = Object.assign(new Error('invalid input syntax in halt_reasons'), { code: '22P02' });
  await expect(readRecordedHaltReasons7d(rejecting(error))).rejects.toBe(error);
});

test('only the named pre-migration missing column gets the compatibility fallback', async () => {
  const missing = Object.assign(new Error('column r.halt_reasons does not exist'), { code: '42703' });
  expect((await readRecordedHaltReasons7d(rejecting(missing))).size).toBe(0);
  const other = Object.assign(new Error('column other does not exist; query uses halt_reasons'), { code: '42703', column_name: 'other' });
  await expect(readRecordedHaltReasons7d(rejecting(other))).rejects.toBe(other);
});

test('official exact no-SQLSTATE messages work, while vague or contradictory diagnostics do not', async () => {
  expect((await readRecordedHaltReasons7d(rejecting(new Error('column halt_reasons does not exist')))).size).toBe(0);
  for (const error of [new Error('halt_reasons is unavailable'),
    Object.assign(new Error('column halt_reasons does not exist'), { column_name: 'other' }),
    Object.assign(new Error('column halt_reasons does not exist'), { column: 'other' })]) {
    await expect(readRecordedHaltReasons7d(rejecting(error))).rejects.toBe(error);
  }
});

test('Doctor cannot turn a failed dependency mentioning no such table into healthy extraction', async () => {
  const error = Object.assign(new Error('no such table: unrelated'), { code: '42P01', table_name: 'unrelated' });
  expect((await computeExtractHealthCheck(rejecting(error))).status).toBe('warn');
});

test('Doctor accepts the exact pre-migration extract_rollup_7d absence', async () => {
  const error = Object.assign(new Error('relation "extract_rollup_7d" does not exist'), { code: '42P01', table_name: 'extract_rollup_7d' });
  expect((await computeExtractHealthCheck(rejecting(error))).status).toBe('ok');
});

test('SQL metadata outranks a misleading message, including the wrong native table', async () => {
  const error = Object.assign(new Error('relation "extract_rollup_7d" does not exist'), { code: '42P01', table_name: 'unrelated' });
  expect((await computeExtractHealthCheck(rejecting(error))).status).toBe('warn');
});
