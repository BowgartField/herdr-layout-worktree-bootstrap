# Worktree bootstrap mod

- This is a standalone Herdr app mod, separate from the daemon fork and legacy plugin.
- Users need nothing beyond Herdr's own requirements: mods in JavaScript, jobs in the POSIX `sh` worker (`runtime/worker.sh`, sh + Git only, must pass under bash and dash). No Python, Node or compiled helpers at run time; Node is for build and tests only.
- The copy, lifecycle, lock and branch rules are ported from the MIT upstream plugin (`licenses/`). Keep its license and attribution, and never weaken those checks. Lifecycle commands are argv arrays, never shell-expanded.
- Edit `src/` and `runtime/`, then run `node tools/build.mjs`; `mods/` and `layouts/` are generated.
- No automatic force deletion, protected-branch deletion, or unverified leftover cleanup.
- Never expose argv, environment values or copied file contents in UI state. Hook output belongs in private job logs.
- Keep running jobs independent of the app. A setup must block only its first terminal, not Herdr navigation or other tabs.
- Install only personal mod/layout copies; never edit shipped mods, keys or generated API declarations.
- Verify `node --test tests/*.test.mjs` and every installed mod with `herdr-app check`; also inspect runtime errors and the native UI.
- Use the repository-local Git identity. Do not commit or publish without the user's request.
