# Worktree bootstrap mod

- This is a standalone Herdr app mod, separate from the daemon fork and legacy plugin.
- `runtime/vendor/worktree_bootstrap.py` is the locally modified upstream plugin snapshot. Keep its MIT license and attribution. Reuse its copy, lifecycle, locks and branch checks rather than weakening them.
- Python 3.9+, standard library only. Lifecycle commands are argv arrays, never shell-expanded.
- No automatic force deletion, protected-branch deletion, or unverified leftover cleanup.
- Never expose argv, environment values or copied file contents in UI state. Hook output belongs in private job logs.
- Keep running jobs independent of the app. A setup must block only its first terminal, not Herdr navigation or other tabs.
- Install only personal mod/layout copies; never edit shipped mods, keys or generated API declarations.
- Verify Python integration tests and every installed mod with `herdr-app check`; also inspect runtime errors and the native UI.
- Use the repository-local Git identity. Do not commit or publish without the user's request.
