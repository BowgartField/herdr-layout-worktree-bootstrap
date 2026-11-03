# Herdr worktree bootstrap mod

Worktree setup and teardown with native progress in **Herdr app 0.1.12**.
This is a standalone Git repository, separate from the legacy Herdr daemon
fork and `herdr-plugin-worktree-bootstrap`.

It reuses the locally modified plugin's Python engine for ignored-file copying,
versioned lifecycle configuration, argv execution, timeouts and branch safety.
Personal copies of the app's native mods provide the interface. No Rust rebuild
or legacy Herdr plugin installation is required.

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

## Requirements

- Herdr app 0.1.12, herdr-core (`hc`), Git and Python 3.9+.
- macOS or Linux for the Python runtime (the inherited engine uses POSIX locks
  and process groups). Windows is not claimed as supported.
- The app's **main** layout, or another layout with an active-tab block.

## Install

From this repository:

```sh
python3 tools/install.py --activate
```

This installs only personal copies under `~/.config/herdr-app/mods/`, the runner
under `data/worktree-bootstrap/runtime/`, and a `worktree-bootstrap` layout.
The installer runs `herdr-app check` on every mod. It refuses collisions and
independently edited personal files. Re-running it updates only files installed
by this repository that have not been independently edited.

The mod runs configured project programs and reads `.herdr` configuration and
listed local files outside its own folder. Review those commands as you would
when installing the original plugin. It does not send data to a network service.

Return to the original interface at any time:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

Other app homes and layout copies are supported:

```sh
python3 tools/install.py --app-home /path/to/app-home --source-layout main
```

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
Install the same runtime on that host first:

```sh
python3 tools/install.py --runtime-only "$HOME/.local/share/herdr-mod-worktree-bootstrap/runtime"
```

Remote Python/Git and lifecycle programs must already be installed. The app
refuses a missing runtime rather than executing a local command for a remote
checkout. Local behavior is covered by integration tests; SSH execution has not
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
python3 -m unittest discover -s tests -v
node --test tests/api.test.mjs
python3 tools/install.py
```

`vendor/app/` is the native UI baseline copied from installed Herdr app 0.1.12.
`tools/build_mods.py` regenerates the personal copies using that baseline and the
integration patches. `mods/api.js` is copied into each mod so none imports code
from another mod at runtime. Changes to the installed default app are never
required. App upgrades may require refreshing this baseline and revalidating.

The old plugin's interactive TUI configuration editors and inventory UI are not
ported; their control files remain compatible. See `NOTICE` for provenance and
licenses. Installation does not publish or commit anything.
