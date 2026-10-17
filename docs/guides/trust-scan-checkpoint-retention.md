# When a completed trust scan becomes unscanned again

`gbrain trust scan` stores its legacy coverage in the single
`op_checkpoints` row `(trust_scan, v1)`. It contains the detector version,
per-table progress and original ID ceilings, and a completion timestamp.
This is durable coverage, including resumable progress before completion.

The general checkpoint collector previously deleted this row after seven
inactive days. The next `doctor` could then report legacy rows as unscanned
again, with the same detector version and a missing completion timestamp.
This can happen without new content being written or the detector changing.
The purge phase of a normal maintenance cycle calls this collector.

## Reproduce with synthetic data

The regression test models one legacy row within the gate baseline:

1. Run the deterministic scan and verify zero unscanned rows.
2. Age only its checkpoint beyond the ordinary seven-day TTL.
3. Run `purgeStaleCheckpoints` and read the native scan state again.

Before the fix, GC removes the coverage and the row becomes unscanned.
After the fix, completed coverage and incomplete scan progress survive.
Ordinary temporary checkpoints still expire, and an old detector's retained
cursor cannot satisfy the current detector. The fixed scan key is updated
in place; retaining it does not accumulate a history of scan cursors.

PGLite and registered PostgreSQL regressions cover these four cases.

## Observed recurrence and recovery

An operator observed a completed detector-v2 scan become unscanned roughly
one week later: its checkpoint was absent, while the original baseline
remained. More than two thousand legacy rows were counted again. The
collector mechanism was reproduced with the real functions in an isolated
database. No row-level production deletion audit was retained, so a
particular production process or maintenance invocation was not identified.

The fix exempts `trust_scan` from temporary-checkpoint GC. It does not
reconstruct a deleted cursor, infer a completed scan or change Doctor's
thresholds. After the fix was deployed, the owner explicitly authorized one
official scan; independent native state and Doctor then reported zero
unscanned rows. That scan reused nine matching flag receipts and added one
flag, matching the read-only preview. No content or trust tier was rewritten.
The owner did not confirm flags or claim additional sources as part of recovery.

The same health-score drop also included a separate, expected
`embedding_state` warning: soft-deleted test pages crossed their 72-hour
recovery window while automatic retention purging was disabled. That warning
was resolved by an explicitly authorized purge of just those test pages.
Active embedding coverage was complete. It was not evidence of lost live
vectors, and deleting pages is not a remedy for missing trust-scan coverage.

## Operator boundary

If coverage has already been lost, read Doctor's `trust_scan` user message.
The owner decides whether to run `gbrain trust scan` on the brain host:
instruction-like legacy content can acquire a flag, and
`trust.agent_activation=suppress` withholds flagged content from proactive
context until confirmed. Agents must not start a scan from this guide alone.
Do not manufacture completion timestamps, raise trust tiers, blanket-claim
sources or delete memory to silence this warning. An actual detector-version
change still requires its normal reassessment.
