# Herdr worktree bootstrap mod

Worktree setup and teardown with native progress in **Herdr app 0.1.12**.
This is a standalone Git repository, separate from the legacy Herdr daemon
fork and `herdr-plugin-worktree-bootstrap`.

It needs nothing besides what Herdr itself needs: the interface is JavaScript
mods (Herdr's own mod language), and setup/teardown jobs run in a small POSIX
`sh` worker that uses Git. No Python, Node, Rust rebuild or legacy Herdr plugin.
The copy, lifecycle and branch-safety rules are ported from the locally modified
`herdr-plugin-worktree-bootstrap` plugin.

## What it does

- Copy the primary checkout's configured ignored files before setup.
- Show a spinner, current step and optional percentage on the worktree row.
- Show “Setup worktree…” and the step in its first tab. The sidebar, shortcuts,
  other tabs and other spaces remain usable.
- Run setup in an independent herdr-core job, including jobs longer than the
  app's 30-second `exec` limit. The first terminal runs a gate, not an interactive
  shell, until setup succeeds. Buffered input is discarded before the shell or
  selected agent starts.
- Show teardown progress in the removal dialog. `before_remove` finishes before
  Git removes anything; a failure preserves the checkout.
- Run `after_remove` from the primary checkout after successful removal.
- Keep the branch by default. Optional safe or forced branch deletion requires
  its exact name. Protected branches, branches in another worktree and changed
  branch heads remain protected. Safe deletion never escalates to force.
- Keep private hook logs, report failures and let a failed setup be retried.
- Edit a repository's scripts from Herdr: right-click a repository's **main
  checkout** in the sidebar, then **Worktree scripts…**. The dialog lists the
  commands run when a worktree is created, before it is removed and after it is
  removed, plus the files to copy. **Save** writes `.herdr/worktree-setup.json`
  and `.herdr/worktree-copy.list` in the main checkout (only what changed, and
  never over a file edited elsewhere since the dialog opened). Commands are typed
  like in a terminal but stored and run as argv, never through a shell: use
  `sh -c '…'` for pipes or variables. The entry is not offered on linked worktrees.

## Requirements

- Herdr app 0.1.12, herdr-core (`hc`) and Git.
- macOS or Linux (the worker is POSIX `sh`: bash, dash, zsh-as-sh and BusyBox
  ash style shells). Windows is not claimed as supported.
- The app's **main** layout, or another layout with an active-tab block.

## Install

From this repository:

```sh
sh tools/install.sh --activate
```

This installs only personal copies under `~/.config/herdr-app/mods/` and a
`worktree-bootstrap` layout (`mods/` and `layouts/` here are also laid out like a
herdr.dev share, so they can be copied by hand). The installer runs
`herdr-app check` on every mod. It refuses collisions and independently edited
personal files. Re-running it updates only files it installed that have not been
edited since, and removes the former Python runtime if it was left unedited.

The mod writes its worker to `data/worktree-bootstrap/runtime/worker.sh` the
first time it needs it, and rewrites it whenever the installed mod carries a
different version. There is no separate runtime to install.

The mod runs configured project programs and reads `.herdr` configuration and
listed local files outside its own folder. Review those commands as you would
when installing the original plugin. It does not send data to a network service.

Return to the original interface at any time:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

Another app home: `sh tools/install.sh --app-home /path/to/app-home`. The
shipped layout is built from Herdr's `main` layout; to start from another one,
change `vendor/app/layouts/main.json` and run `node tools/build.mjs`.

Use this layout's **New worktree**, **Open worktree** and **Remove worktree**
menus. Direct `git worktree` commands and the unmodified shipped worktree dialog
are not intercepted. Removing a worktree outside these menus does not run hooks.

## Existing plugin configuration

The primary checkout remains the source of configuration:

`.herdr/worktree-copy.list`:

```text
# Only Git-ignored local paths are copied. Tracked files are not overwritten.
.env
```

`.herdr/worktree-setup.json`:

```json
{
  "version": 2,
  "hooks": {
    "on_created": [
      {"name": "Install dependencies", "argv": ["npm", "ci"], "timeout_seconds": 900}
    ],
    "before_remove": [],
    "after_remove": []
  }
}
```

A script can be named relative to the repository, whatever the phase's folder:
in `["bash", "worktree-setup.sh"]` or `["./scripts/setup.sh"]`, the script is
taken from the hook's folder (the worktree, or the main checkout for
`after_remove`), else from the main checkout. Only the program, or an
interpreter's script operand (`sh`, `bash`, `node`, `python3`, …, not after
`-c`/`-e`), is resolved this way; other arguments are passed unchanged.

Version 1 `commands` files also work. Commands execute as argv arrays, without
shell interpolation. As in the plugin, `before_remove` and `after_remove` receive
`HERDR_WORKTREE_PATH`, `HERDR_PRIMARY_PATH`, `HERDR_WORKTREE_BRANCH`,
`HERDR_WORKTREE_HEAD`, `HERDR_REMOVAL_FORCED` and `HERDR_LEFTOVER_DETECTED`.

Copying happens first; a copy failure prevents all setup commands. Symbolic
links are preserved as links; the plugin's path and symlink-parent checks remain
in force. Files left behind after Git unregisters a checkout are never deleted
automatically by this mod.

## Report steps from Bash

Bash hooks can call the supplied functions (when `BASH_ENV` is not already set):

```bash
herdr_progress --step 'Loading database' --percent 40
herdr_step 'Applying migrations' --percent 70
```

Any program can invoke the explicit helper, including when it manages its own
`BASH_ENV`:

```bash
"$HERDR_PROGRESS_COMMAND" --step 'Applying migrations' --percent 70
```

`--percent` is optional, from 0 to 100; the step is 1–160 characters.
The legacy form also works through the supplied `HERDR_BIN_PATH` shim:

```bash
"$HERDR_BIN_PATH" plugin progress report --step 'Seeding database' --percent 90
```

A script that hardcodes the old experimental Herdr binary must instead honor
these environment variables. For example, the old Baltix demo's
`report_setup_progress` can use:

```bash
report_setup_progress() {
  "$HERDR_PROGRESS_COMMAND" --step "$1" --percent "$2" || true
}
```

The legacy daemon's `plugin.progress.report` endpoint is not used.

## SSH hosts

The UI passes the space's machine to `exec` and starts the job with `hc --on`.
The mod writes the worker to `~/.local/share/herdr-mod-worktree-bootstrap/` on
that host by itself; Git and the lifecycle programs must already be installed
there. Local behavior is covered by integration tests; SSH execution has not
yet been qualified on a real remote host.

## Jobs, failures and recovery

Jobs live under `data/worktree-bootstrap/jobs/<id>/` in the app home. They have
private specifications and logs, an atomically updated status, and per-target
locks. Scripts outlive the app because herdr-core owns the worker. Reopening the
layout resumes status tracking from the app's persisted shared state.

A failed setup keeps its checkout and its terminal gate. If the runner disappeared
without recording completion, retries are disabled because detached hook processes
may still be running; inspect those processes before beginning a new operation. **Retry setup** reruns
copying and setup, so hooks should be safe to retry. **View log** reads only the
last 32 KB of that job's output. Child programs control their own output; avoid
printing secrets from hooks.

A failed teardown keeps the checkout unless Git removal already finished. If
`after_remove` or safe branch deletion fails after removal, the dialog reports
that failure and the branch is preserved if Git refused deletion. Removal is
never automatically retried after the checkout has gone.

## Development

```sh
node tools/build.mjs          # regenerate mods/ and layouts/
node --test tests/*.test.mjs  # worker (sh and dash), mod API, engine, installer
sh tools/install.sh
```

Development needs Node 22 for the build and tests; users don't. Sources:
`runtime/worker.sh` (the job worker), `src/engine.js` (configuration rules,
command-line splitting, generated job files), `src/api.js` (mod side),
`src/setup/` and `src/scripts/` (the setup screen and scripts editor).
`vendor/app/` is the native UI baseline copied from installed Herdr app 0.1.12.
`tools/build.mjs` regenerates the personal copies from that baseline and the
integration patches, and copies `api.js`, `engine.js` and the embedded worker
into each mod so none imports code from another mod at runtime. Changes to the installed default app are never
required. App upgrades may require refreshing this baseline and revalidating.

The old plugin's inventory UI is not ported; its control files remain
compatible, and the scripts dialog replaces its TUI configuration editors. See `NOTICE` for provenance and
licenses. Installation does not publish or commit anything.
