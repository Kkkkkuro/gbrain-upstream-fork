# subject-infer alias reapply

Mini only. This overlay reapplies the subject-infer alias patch after `bun update` replaces the global gbrain tree. It does not touch the backup continuation patch.

Install the `scripts.postinstall` line from `mini-global-package.json` only into `~/.bun/install/global/package.json` on the Mini. That value is an absolute path, because a relative overlay path does not resolve when bun runs the hook from the global package directory. A merged hook that also runs the backup reapply is not in the repo yet, so this command runs only the subject-infer reapply.

`reapply.ts` dry-runs `patch` first. A dry-run failure prints the patch output and leaves the tree unchanged, including no `.rej` or `.orig` files. If some of the markers are already present and some are not, it exits 1 and does not run `patch`.
