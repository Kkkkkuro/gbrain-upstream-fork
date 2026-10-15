/**
 * `transaction(fn, { signal })` on Postgres: aborting the signal discards the
 * transaction's connection, after cancelling its fenced statement when the
 * installed driver supports cancelAndDiscard().
 *
 * postgres.js gives every `begin()` callback a handle whose `discard()` (the
 * vendored #5466/#5560 hunk, `sql.discard = reservation.discard` in
 * vendor/postgres/src/index.js) rejects the reservation's queue with
 * `CONNECTION_CLOSED`, drops the reservation and terminates the socket. The
 * server eventually sees the socket close and rolls the open transaction back.
 * That close is not proof that an in-flight statement stopped: the optional
 * cancelAndDiscard path sends CancelRequest first, holds the reservation until
 * query settlement, and rejects on its bounded fallback. The pool
 * reconnects on its next checkout. An abort that lands while `BEGIN` is still
 * on the wire is applied as soon as the handle exists. One that lands after
 * `COMMIT` returned finds no owned reservation and is a no-op in the driver.
 */
export interface Discardable {
  discard?: () => void;
  cancelAndDiscard?: () => Promise<void>;
}

/** The rejection for an aborted transaction: an `AbortError` carrying the signal's reason and the driver error that ended it. */
export function transactionAborted(signal: AbortSignal, cause?: unknown): Error {
  const reason = signal.reason;
  const error = new DOMException(reason instanceof Error ? reason.message : 'transaction aborted', 'AbortError');
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
  return error;
}

/**
 * Runs `run`, whose `attach` callback hands over the transaction handle once
 * `begin()` has produced it. While `signal` is live, an abort discards the
 * attached handle; a rejection that follows an abort is rethrown as
 * `transactionAborted(signal, error)`.
 */
export async function withTransactionAbort<T>(signal: AbortSignal | undefined, run: (attach: (handle: Discardable) => void) => Promise<T>): Promise<T> {
  if (!signal) return run(() => {});
  let handle: Discardable | null = null;
  let aborting: Promise<void> | undefined;
  let abortFailure: unknown;
  const onAbort = () => {
    if (!handle || aborting) return;
    try {
      aborting = Promise.resolve(handle.cancelAndDiscard ? handle.cancelAndDiscard() : handle.discard?.())
        .catch(error => { abortFailure = error; });
    } catch (error) {
      abortFailure = error;
      aborting = Promise.resolve();
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await run(h => {
      handle = h;
      if (signal.aborted) onAbort();
    });
    await aborting;
    // run() resolves only after the transaction has committed. A late abort
    // cannot turn persisted success into a retryable failure.
    return result;
  } catch (error) {
    await aborting;
    if (signal.aborted) throw transactionAborted(signal, abortFailure ?? error);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
