import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../consolidate-publication-locks.test.ts'));
