# Changelog

Versions follow [Semantic Versioning](https://semver.org). Each release is a
Git tag `vX.Y.Z` with a GitHub release.

## 1.1.0 — 2026-11-03

### Added
- **Worktree scripts…** in a main checkout's space menu (right-click): a form
  that edits the create, before-remove and after-remove commands and the files
  to copy, saved to `.herdr/worktree-setup.json` and `.herdr/worktree-copy.list`.
- Hook scripts can be named relative to the repository (`bash setup.sh`,
  `./scripts/setup.sh`): taken from the hook's folder, else from the main checkout.

### Changed
- No Python needed anymore: jobs run in a POSIX `sh` worker (sh + Git only) that
  the mod writes to each machine itself, SSH hosts included. Configuration is
  validated in the mods' JavaScript.
- Install with `sh tools/install.sh`; it upgrades a 1.0.0 install and removes
  its unedited Python runtime.

### Removed
- The Python runtime (`runner.py`, vendored plugin engine) and `--source-layout`.

## 1.0.0

- Worktree setup and teardown with native progress in Herdr app 0.1.12:
  sidebar spinner and step, setup screen gating the first tab, teardown
  progress in the removal dialog, safe branch cleanup, private hook logs, retry.
