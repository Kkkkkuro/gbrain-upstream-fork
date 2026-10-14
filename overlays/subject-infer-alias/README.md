# subject-infer alias reapply

Mini only. This overlay reapplies the subject-infer alias patch after `bun update` replaces the global gbrain tree. It does not touch the backup continuation patch.

The Mini hook is `overlays/mini-writer/postinstall.ts`. It checks `KuroChendeMac-mini.local`, then runs the backup reapply and this reapply. `mini-global-package.json` points at that file with an absolute path. This overlay does not keep its own hostname check.

`reapply.ts` dry-runs `patch` first. A dry-run failure prints the patch output and leaves the tree unchanged, including no `.rej` or `.orig` files. If some of the markers are already present and some are not, it exits 1 and does not run `patch`.
