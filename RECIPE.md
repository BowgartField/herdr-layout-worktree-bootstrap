# Worktree bootstrap

A native worktree lifecycle interface for Herdr app: sidebar progress, a setup
screen in the first tab, and teardown progress in the removal dialog.

## What you see

The existing Herdr sidebar and tab bar remain. A worktree row adds a native
animated spinner, a truncated step and an optional percentage. The active setup
tab's content becomes a centered “Setup worktree…” title and step, with log and
retry controls on failure. The removal dialog shows the teardown step and offers
keep/safe-delete/force-delete choices for the branch, with exact-name confirmation.
Colors use Herdr's theme roles and the spinner animates natively, not with redraw
timers.

## How it behaves

Create a checkout using the inherited plugin configuration. Copy eligible ignored
files, run `on_created` as argv arrays, and track progress from disk. A herdr-core
background worker survives app closure. The first terminal runs a non-interactive
gate until success; other tabs and spaces remain usable. On failure show the
error, keep the checkout, and allow an explicit retry. Discard buffered input
before starting the shell or selected agent.

Removal waits for `before_remove`, rechecks checkout identity and dirty state,
then runs Git removal and `after_remove`. Never force automatically, delete a
protected/in-use/changed branch, or delete unverified leftovers. Safe branch
cleanup can fail while preserving the branch after checkout removal.

## Built from

Clone the main layout and native spaces, tabs, menu, new-menu, workspace-chrome,
pane and worktree mods. Route worktree menu entries to `worktree-bootstrap`.
Replace only the active-tab block with a stack of the original terminal block
and `worktree-bootstrap-setup`. Select the loading child only for the job's first
tab; keep the sidebar and tabs outside that stack. Coordinate using `shared` /
`setShared`, `spaces`, `panes`, `run`, `exec` and `hc`. Animate with `.spin()`.

Port the original plugin's rules for copy eligibility, transactional copying,
lifecycle parsing/execution and branch safeguards: validation in the mods'
JavaScript, execution in a POSIX `sh` worker the mod writes to each machine, so
nothing beyond Herdr's own requirements (sh, Git) is needed. A main checkout's
space menu offers **Worktree scripts…**, a form that edits the hooks (name,
command typed like in a terminal and stored as argv, timeout) and the copy list. Keep job metadata
separate from logs and runtime paths; reject stale status revisions. Poll only
active jobs and avoid no-op shared-state updates. See README for installation,
configuration, progress helpers, verification and the SSH qualification limit.
