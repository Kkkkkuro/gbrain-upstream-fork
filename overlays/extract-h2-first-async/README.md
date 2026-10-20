# RC-EXTRACT-H2-FIRST-ASYNC overlay

Local reapply for the halt-undercount fix that is already on the Mini install tree.

- Scope: `atom-maintenance.ts`, `atoms-run-finalization.ts`, `extract-atoms.ts`, plus the H2 / first-async regression tests.
- Base: the accepted 100-protection bytes for those three sources (pre-H2), then H2 terminal-replay + first-async attribution.
- Does **not** replace or rewrite the other 100 local protection files.
- Postinstall: listed in `overlays/mini-writer` REAPPLY after subject-infer.

Markers require `extract_halt_attributed` and related first-async seams. A second reapply is a no-op (`present`).
