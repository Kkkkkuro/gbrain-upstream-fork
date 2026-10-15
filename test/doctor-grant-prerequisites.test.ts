import { describe, expect, test } from 'bun:test';
import { checkGrantNewOps } from '../src/commands/doctor/checks/grant-new-ops.ts';
import { operations } from '../src/core/operations.ts';
import { requireOwnerConfirmation } from '../src/core/trust/confirm.ts';

// No database, provider, or module mocks: exercise the real diagnostic with
// a strict, read-only in-memory query adapter and the real owner scope gate.
const snapshot = ['edit_page', 'get_brain_identity', 'get_page', 'get_write_request', 'put_page', 'put_pages', 'recall', 'whoami'];
const added = ['confirm_memory', 'questions_pin', 'questions_list', 'questions_status', 'questions_refresh', 'questions_unpin'];
async function diagnose(scopes: string[], opts: { legacy?: boolean; includeConfirm?: boolean } = {}) {
  const allowed = opts.includeConfirm ? [...snapshot, 'confirm_memory'] : [...snapshot];
  const row = { client_id: 'synthetic-artifacts', client_name: 'artifacts', scope: scopes.join(' '), allowed_operations: allowed,
    surface: 'full', source_id: 'default', grant_revision: 3 };
  const before = JSON.stringify(row);
  const queries: string[] = [];
  const engine = {
    getConfig: async (key: string) => key === 'mcp.publish_skills' ? 'true' : null,
    executeRaw: async (q: string) => {
      queries.push(q);
      if (/^SELECT \* FROM oauth_clients/.test(q)) return opts.legacy ? [] : [row];
      if (/^SELECT \* FROM access_tokens/.test(q)) return opts.legacy
        ? [{ id: 'synthetic-token', name: 'artifacts', scopes, permissions: { allowed_operations: allowed } }] : [];
      if (/^SELECT after_grant FROM oauth_grant_audit/.test(q)) return [{ after_grant: {
        allowedOperations: allowed, catalogProvenance: { version: 1, gbrain_version: '0.60.122.0',
          operations: operations.map(op => op.name).filter(name => !added.includes(name)) },
      } }];
      throw new Error(`Unexpected query: ${q}`);
    },
  };
  const check = await checkGrantNewOps(engine as any, { cfg: { mcp_surface: 'full' } as any });
  expect(JSON.stringify(row)).toBe(before);
  expect(queries.every(q => q.startsWith('SELECT '))).toBe(true);
  return { check, finding: (check.details as any)?.grants?.[0] };
}

describe('grant diagnostic execution prerequisites', () => {
  for (const scopes of [['read', 'write'], ['admin'], ['read', 'write', 'memory_confirm']]) {
    test(`${scopes.join('+')}: scope report agrees with the real owner gate`, async () => {
      const { check, finding } = await diagnose(scopes);
      const granted = scopes.includes('memory_confirm');
      expect(check.status).toBe('warn');
      expect(finding.execution_prerequisites).toEqual([{
        operation: 'confirm_memory', applies_to: 'trust_promotion', required_scope: 'memory_confirm', scope_granted: granted,
      }]);
      expect(check.message).toContain('dry-run and already-confirmed no-op');
      expect(check.message).toContain(granted ? 'memory_confirm scope is present' : 'snapshot-only rescope cannot enable trust promotion');
      expect(check.fix?.user_message).toContain('memory_confirm');
      expect(check.fix?.consent).toEqual(['credentials']);
      expect(finding.argv).not.toContain('--scopes');
      expect(finding.preview_argv).not.toContain('--scopes');
      const gate = requireOwnerConfirmation({ remote: true, auth: { scopes } } as any,
        { ref: 'f1', summary: 'Confirm synthetic fact', command: ['gbrain', 'trust', 'confirm', 'f1'] });
      if (granted) expect(await gate).toEqual({ via: 'memory_confirm_scope' });
      else await expect(gate).rejects.toMatchObject({ code: 'insufficient_scope' });
    });
  }

  test('counts, catalog age, excluded operations and repair consent stay intact', async () => {
    const { check, finding } = await diagnose(['read', 'write']);
    expect(finding.grant_age).toMatchObject({ excluded_count: 103, predates_count: 6, excluded_at_snapshot_count: 97 });
    expect(finding.blockers).toEqual([{ blocker: 'operation_snapshot', excluded_count: 103 }]);
    expect(added.every(op => finding.excluded_operations.operation_snapshot.includes(op))).toBe(true);
    expect(check.fix?.argv).toEqual(['gbrain', 'auth', 'rescope', '--client', 'synthetic-artifacts', '--operations', '<OPERATIONS>']);
    expect(check.fix?.user_message).toContain('or leave it as it is');
  });

  test('legacy tokens receive the same missing promotion prerequisite', async () => {
    const { finding } = await diagnose(['read', 'write'], { legacy: true });
    expect(finding.kind).toBe('legacy_token');
    expect(finding.execution_prerequisites[0]).toMatchObject({ operation: 'confirm_memory', scope_granted: false });
    expect(finding.preview_argv).toEqual(['gbrain', 'auth', 'rescope', '--token', 'artifacts', '--refresh-operations']);
  });

  test('no extra prerequisite finding when confirm_memory is already in the snapshot', async () => {
    const { check, finding } = await diagnose(['read', 'write'], { includeConfirm: true });
    expect(check.status).toBe('warn');
    expect(finding.execution_prerequisites).toBeUndefined();
    expect(check.message).not.toContain('snapshot-only rescope cannot enable trust promotion');
  });
});
