import { expect, test } from 'bun:test';
import { renderCliError } from '../src/core/agent-output.ts';
import { classifyPgAccessError } from '../src/core/pg-access-classify.ts';
import { isRetryableConnError } from '../src/core/retry-matcher.ts';

const openError = 'could not open file "base/42/120_fsm": Interrupted system call';
const pgError = (message: string, code = 'XX000') => Object.assign(new Error(message), { code });

test.each([
  openError,
  'could not read block 3 in file "global/pg_filenode.map": Interrupted system call',
])('Postgres interrupted a data-file read: %s', message => {
  const error = pgError(message);
  const diagnosis = classifyPgAccessError(error);
  expect(diagnosis.reason).toBe('storage_read_interrupted');
  expect(diagnosis.transient).toBe(false);
  expect(isRetryableConnError(error)).toBe(false);
  const out = JSON.parse(renderCliError(error, { json: true, command: 'jobs', tty: false }).stdout!);
  expect(out.code).toBe('database_error');
  expect(out.retryable).toBe(false);
  expect(out.suggestion).toContain('database host');
  expect(out.suggestion).toContain('original job or write receipt');
  const human = renderCliError(error, { json: false, command: 'jobs', tty: false }).stderr;
  expect(human).toContain('original job or write receipt');
});

test('an interrupted client file read and an unrelated PostgreSQL internal error remain distinct', () => {
  expect(classifyPgAccessError(pgError(openError, 'EINTR')).reason).toBe('unknown');
  expect(classifyPgAccessError(pgError('could not open file "report.md": Interrupted system call')).reason).toBe('unknown');
  expect(classifyPgAccessError(pgError('unexpected chunk number 6 for toast value 42')).reason).toBe('storage_corrupt');
});
