import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../trust-scan-checkpoint-gc.test.ts'));
