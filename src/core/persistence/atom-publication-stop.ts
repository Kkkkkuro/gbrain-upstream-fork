/** Cooperative stop after admission must retain every durable request identity. */
import { AbortError } from '../abort-check.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { isWriteReceipt, type WriteReceipt } from './types.ts';

export function atomPublicationErrorReceipts(error: unknown): WriteReceipt[] {
  const value = error as { write_requests?: unknown; writeRequests?: unknown; writeRequest?: unknown } | null;
  return Array.isArray(value?.write_requests) ? value.write_requests.filter(isWriteReceipt)
    : Array.isArray(value?.writeRequests) ? value.writeRequests.filter(isWriteReceipt)
    : isWriteReceipt(value?.writeRequest) ? [value.writeRequest] : [];
}

export function assertAtomPublicationActive(assertActive: () => void, receipts: WriteReceipt[] = []): void {
  try { assertActive(); } catch (cause) {
    const receipt = receipts.find(row => ['queued', 'running', 'recovering'].includes(row.state)) ?? receipts.at(-1);
    if (!receipt) throw cause;
    const pending = receipts.some(row => ['queued', 'running', 'recovering'].includes(row.state));
    const error = pending
      ? opError('write_pending', 'Atom retry stopped after receiving durable write receipts; cancellation does not roll them back.',
        `Inspect request ${receipt.request_id} and the retained batch before another attempt. Already accepted writes may still settle.`,
        { fix: readFix('Reads the atom request\'s durable receipt: its state, outcome and error, read-only.',
          { argv: ['gbrain', 'write-request', '--', receipt.request_id] }) })
      : new AbortError(`Atom retry stopped after durable writes settled; their recorded outcomes remain valid. Inspect request ${receipt.request_id}.`);
    Object.assign(error, { cause, writeRequest: receipt, writeRequests: receipts, write_requests: receipts });
    throw error;
  }
}
