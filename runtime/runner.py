#!/usr/bin/env python3
"""Persistent worktree jobs for the Herdr app; no daemon plugin required."""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))
import worktree_bootstrap as bootstrap


JOB_ID = re.compile(r"^[a-f0-9]{32}$")


def state_root(value=None):
    if value:
        return Path(value).expanduser().resolve()
    if os.environ.get("HERDR_BOOTSTRAP_STATE_DIR"):
        return Path(os.environ["HERDR_BOOTSTRAP_STATE_DIR"]).expanduser().resolve()
    home = Path(os.environ.get("HERDR_APP_HOME", str(Path.home() / ".config/herdr-app")))
    return home / "data/worktree-bootstrap/jobs"


def job_dir(root, job):
    if not isinstance(job, str) or not JOB_ID.fullmatch(job):
        raise bootstrap.BootstrapError("Invalid job identifier")
    return root / job


def read_json(path):
    with path.open(encoding="utf-8") as file:
        return json.load(file)


@contextlib.contextmanager
def status_lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "status.lock").open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


@dataclasses.dataclass(frozen=True)
class RemovedCheckout:
    target: Path
    source: Path
    branch: str


def update(root, job, _only_running=False, **values):
    directory = job_dir(root, job)
    with status_lock(directory):
        path = directory / "status.json"
        current = read_json(path) if path.exists() else {}
        if _only_running and current.get("state") != "running":
            return current
        current.update(values)
        current["updated"] = time.time_ns() // 1000
        current["revision"] = current.get("revision", 0) + 1
        bootstrap._atomic_write_json(path, current)
        return current


def git(path, args, *, check=True):
    return bootstrap._run_git(Path(path), args, check=check)


def head(path):
    result = git(path, ["rev-parse", "--verify", "HEAD"], check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def branch(path):
    result = git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def dirty(path):
    result = git(path, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"])
    return result.stdout


def inspect(target):
    context = bootstrap.resolve_repository(Path(target))
    name = branch(context.target)
    hooks = bootstrap.load_lifecycle_commands(context.source)
    inspection = bootstrap.inspect_branch(context.source, name) if name else None
    return {
        "source": str(context.source), "target": str(context.target), "branch": name,
        "head": head(context.target), "linked": not context.target_is_primary,
        "dirty": bool(dirty(context.target)),
        "copy_paths": bootstrap.read_copy_list(context.source),
        "hooks": {key: [command.name for command in value] for key, value in hooks.items()},
        "branch_protected": bool(inspection and inspection.protected),
        "branch_merged": inspection.merged_into_default if inspection else None,
    }


def prepare(root, *, action, source, target, branch_name="", base="HEAD", force=False,
            branch_action="keep", confirm_branch="", command=None):
    if action not in {"create", "setup", "remove"}:
        raise bootstrap.BootstrapError("Unknown lifecycle action")
    source_context = bootstrap.resolve_repository(Path(source))
    primary = source_context.source
    target = Path(target).expanduser().resolve()
    # Validate configuration before creating or deleting anything.
    bootstrap.load_lifecycle_commands(primary)
    bootstrap.read_copy_list(primary)
    if command is not None and (not isinstance(command, list) or not all(isinstance(arg, str) for arg in command)):
        raise bootstrap.BootstrapError("The initial terminal command must be an argv array")
    spec = {"command": command or [], "action": action, "source": str(primary), "checkout": str(source_context.target),
            "target": str(target), "branch": branch_name, "base": base,
            "force": bool(force), "branch_action": branch_action}
    if action == "create":
        if not branch_name or branch_name.startswith("-"):
            raise bootstrap.BootstrapError("A valid branch name is required")
        git(primary, ["check-ref-format", "--branch", branch_name])
        if target == primary or target.exists() or target.is_symlink():
            raise bootstrap.BootstrapError("The target checkout path already exists")
    else:
        context = bootstrap.resolve_repository(target)
        if context.target_is_primary or context.common_git_dir != source_context.common_git_dir:
            raise bootstrap.BootstrapError("Only a linked checkout of this repository can be changed")
        spec.update(branch=branch(target), expected_head=head(target),
                    dirty_snapshot=hashlib.sha256(dirty(target).encode()).hexdigest())
        if action == "remove" and dirty(target) and not force:
            raise bootstrap.BootstrapError("The checkout is dirty; explicit force confirmation is required")
        if branch_action not in {"keep", "safe", "force"}:
            raise bootstrap.BootstrapError("Invalid branch cleanup choice")
        if action == "remove" and branch_action != "keep":
            if not spec["branch"] or confirm_branch != spec["branch"]:
                raise bootstrap.BootstrapError("Type the exact branch name to confirm branch deletion")
            if bootstrap.inspect_branch(primary, spec["branch"]).protected:
                raise bootstrap.BootstrapError("Protected branches cannot be deleted")
    identifier = uuid.uuid4().hex
    directory = job_dir(root, identifier)
    directory.mkdir(parents=True, mode=0o700)
    bootstrap._atomic_write_json(directory / "spec.json", spec)
    status = update(root, identifier, id=identifier, action=action, source=str(primary),
                    target=str(target), branch=spec["branch"], state="queued", phase="queued",
                    step="Waiting for the lifecycle job", percent=None, pid=None,
                    created=time.time(), checkout_ready=action != "create", checkout_removed=False)
    return status


def report(root, identifier, step, percent=None):
    if not isinstance(step, str) or not step.strip() or len(step) > 160:
        raise bootstrap.BootstrapError("The step must contain 1 to 160 characters")
    if percent is not None and (isinstance(percent, bool) or not 0 <= percent <= 100):
        raise bootstrap.BootstrapError("The percentage must be between 0 and 100")
    return update(root, identifier, _only_running=True, step=step.strip(), percent=percent)


def environment(root, identifier, context, *, forced=False, removed=False, expected_head=None):
    env = dict(bootstrap._lifecycle_environment(
        worktree_path=context.target, repo_root=context.source,
        branch=branch(context.target) if not removed else context.branch,
        head_oid=head(context.target) if not removed else expected_head,
        forced=forced, leftover=context.target.exists() if removed else False,
    ))
    env.update(HERDR_BOOTSTRAP_JOB_ID=identifier, HERDR_BOOTSTRAP_STATE_DIR=str(root),
               HERDR_BOOTSTRAP_RUNNER=str(Path(__file__).resolve()),
               HERDR_PROGRESS_COMMAND=str(Path(__file__).resolve().parent / "progress"),
               HERDR_BIN_PATH=str(Path(__file__).resolve().parent / "progress"))
    # Shell functions are opt-in helpers; the configured argv is never shell-expanded.
    if not os.environ.get("BASH_ENV"):
        env["BASH_ENV"] = str(Path(__file__).resolve().parent / "progress.bash")
    return env


def lifecycle(root, identifier, context, phase, *, forced=False, removed=False, expected_head=None):
    commands = bootstrap.load_lifecycle_commands(context.source)[phase]
    env = environment(root, identifier, context, forced=forced, removed=removed,
                      expected_head=expected_head)
    update(root, identifier, phase=phase, step={"on_created": "Preparing worktree",
           "before_remove": "Preparing teardown", "after_remove": "Finishing cleanup"}[phase],
           percent=None)
    # Keep the plugin's argv execution, timeout, process-group cleanup and coarse steps.
    bootstrap._report_plugin_progress = lambda _env, step, percent: report(root, identifier, step[:160], percent)
    return bootstrap.run_lifecycle_commands(context.target if not removed else context.source,
        commands, phase=phase, environment=env, stdin=subprocess.DEVNULL)


def run_job(root, identifier):
    directory = job_dir(root, identifier)
    with bootstrap.TargetLock(directory, "job"):
        old = read_json(directory / "status.json")
        if old.get("state") == "success":
            return old
        if old.get("checkout_removed"):
            raise bootstrap.BootstrapError("The checkout was removed; do not retry removal")
        spec = read_json(directory / "spec.json")
        update(root, identifier, state="running", pid=os.getpid(), error=None,
               step="Preparing lifecycle job", percent=None, finished=None, retryable=True)
        previous_handlers = {}
        def interrupted(_signal, _frame):
            raise KeyboardInterrupt()
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[sig] = signal.signal(sig, interrupted)
        try:
            primary = bootstrap.resolve_repository(Path(spec["source"]))
            placeholder = bootstrap.RepositoryContext(Path(spec["target"]), primary.source,
                                                       primary.common_git_dir, False)
            with bootstrap.TargetLock(root / "locks", bootstrap.target_key(placeholder)):
                if spec["action"] == "create" and not old.get("checkout_ready"):
                    update(root, identifier, phase="checkout", step="Creating worktree")
                    args = ["worktree", "add"]
                    exists = git(spec["source"], ["show-ref", "--verify", "--quiet", "refs/heads/" + spec["branch"]], check=False).returncode == 0
                    if not exists:
                        args += ["-b", spec["branch"]]
                    args += [spec["target"], spec["branch"] if exists else spec["base"]]
                    git(spec["checkout"], args)
                    update(root, identifier, checkout_ready=True)
                context = bootstrap.resolve_repository(Path(spec["target"]))
                if context.target_is_primary or context.common_git_dir != primary.common_git_dir:
                    raise bootstrap.BootstrapError("Checkout identity no longer matches this job")
                if spec["action"] in {"create", "setup"}:
                    update(root, identifier, phase="copy", step="Copying local files", percent=0)
                    with bootstrap.TargetLock(root / "plugin", bootstrap.target_key(context)):
                        bootstrap.cleanup_stale_transactions(context.target)
                        entries = bootstrap.classify_copy_entries(context.source, context.target,
                                      bootstrap.read_copy_list(context.source))
                        count = bootstrap.sync_paths(context, entries)
                        update(root, identifier, copied_count=count)
                        lifecycle(root, identifier, context, "on_created")
                else:
                    if branch(context.target) != spec["branch"] or head(context.target) != spec["expected_head"]:
                        raise bootstrap.BootstrapError("The checkout changed; reopen removal to review it")
                    lifecycle(root, identifier, context, "before_remove", forced=spec["force"])
                    # Hooks must finish before Git is allowed to remove the checkout.
                    current = bootstrap.resolve_repository(context.target)
                    current_dirty = dirty(current.target)
                    changed_dirty = hashlib.sha256(current_dirty.encode()).hexdigest() != spec["dirty_snapshot"]
                    if current.common_git_dir != context.common_git_dir or branch(current.target) != spec["branch"] or head(current.target) != spec["expected_head"]:
                        raise bootstrap.BootstrapError("The checkout identity changed during teardown")
                    if current_dirty and (not spec["force"] or changed_dirty):
                        raise bootstrap.BootstrapError("The checkout became dirty during teardown; review removal again")
                    update(root, identifier, phase="remove", step="Removing worktree", percent=None)
                    git(context.source, ["worktree", "remove"] + (["--force"] if spec["force"] else []) + [str(context.target)])
                    update(root, identifier, checkout_removed=True)
                    removed = RemovedCheckout(context.target, context.source, spec["branch"])
                    lifecycle(root, identifier, removed, "after_remove", forced=spec["force"],
                              removed=True, expected_head=spec["expected_head"])
                    if spec["branch_action"] != "keep":
                        update(root, identifier, phase="branch", step="Cleaning up branch")
                        result = bootstrap.delete_local_branch(context.source, spec["branch"],
                            force=spec["branch_action"] == "force", expected_oid=spec["expected_head"])
                        update(root, identifier, branch_result=result)
                return update(root, identifier, state="success", phase="complete", step="Setup complete" if spec["action"] != "remove" else "Cleanup complete", percent=100, finished=time.time())
        except BaseException as error:
            # Never publish commands/environment or copied contents into shared UI state.
            message = "Lifecycle job interrupted" if isinstance(error, KeyboardInterrupt) else str(error)
            update(root, identifier, state="failed", error=message, step="Lifecycle job failed", finished=time.time())
            raise
        finally:
            for sig, handler in previous_handlers.items():
                signal.signal(sig, handler)


def statuses(root, identifiers):
    result = []
    for identifier in identifiers:
        item = read_json(job_dir(root, identifier) / "status.json")
        if item.get("state") == "queued" and time.time() - item.get("queued_at", item["created"]) > 60:
            item = update(root, identifier, state="failed", step="Lifecycle job did not start",
                          error="The lifecycle runner did not start; retry the operation")
        if item.get("state") == "running" and item.get("pid"):
            try:
                os.kill(item["pid"], 0)
            except ProcessLookupError:
                item = update(root, identifier, state="failed", step="Lifecycle job stopped",
                              error="The lifecycle runner stopped; hook processes may still be running. Inspect them before starting another operation.",
                              retryable=False)
        result.append(item)
    return result


def gate(root, identifier, command):
    """No shell exists under the setup screen. Discard buffered input before exec."""
    import termios
    tty = sys.stdin.isatty()
    old = termios.tcgetattr(sys.stdin) if tty else None
    handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGINT, signal.SIGQUIT)}
    if old:
        mode = list(old)
        mode[3] &= ~termios.ECHO
        termios.tcsetattr(sys.stdin, termios.TCSANOW, mode)
    try:
        last = None
        while True:
            status = statuses(root, [identifier])[0]
            if status.get("state") == "success":
                break
            text = status.get("error") or status.get("step", "Preparing worktree")
            if text != last:
                print(text, flush=True)
                last = text
            time.sleep(0.2)
    finally:
        if tty:
            termios.tcflush(sys.stdin, termios.TCIFLUSH)
            termios.tcsetattr(sys.stdin, termios.TCSANOW, old)
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    if not command:
        command = [os.environ.get("SHELL", "/bin/sh"), "-l"]
    os.execvp(command[0], command)


def main():
    # Accept the legacy `HERDR_BIN_PATH plugin progress report ...` calling form.
    argv = sys.argv[1:]
    if argv[:3] == ["plugin", "progress", "report"]:
        argv = ["progress"] + argv[3:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "run", "status", "progress", "gate", "inspect", "retry", "logs"])
    parser.add_argument("--state-dir")
    parser.add_argument("--job", default=os.environ.get("HERDR_BOOTSTRAP_JOB_ID"))
    parser.add_argument("--jobs", default="[]")
    parser.add_argument("--operation", choices=["create", "setup", "remove"])
    parser.add_argument("--source")
    parser.add_argument("--target")
    parser.add_argument("--branch", default="")
    parser.add_argument("--base", default="HEAD")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--branch-action", choices=["keep", "safe", "force"], default="keep")
    parser.add_argument("--confirm-branch", default="")
    parser.add_argument("--step")
    parser.add_argument("--percent", type=int)
    parser.add_argument("--command")
    args = parser.parse_args(argv)
    root = state_root(args.state_dir)
    try:
        if args.action == "prepare":
            result = prepare(root, action=args.operation, source=args.source, target=args.target,
                branch_name=args.branch, base=args.base, force=args.force,
                branch_action=args.branch_action, confirm_branch=args.confirm_branch,
                command=json.loads(args.command) if args.command else None)
        elif args.action == "run":
            # Hook stdout/stderr stay private; only status metadata goes to the UI.
            log = job_dir(root, args.job) / "output.log"
            fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", buffering=1) as stream:
                os.dup2(stream.fileno(), 1)
                os.dup2(stream.fileno(), 2)
                result = run_job(root, args.job)
        elif args.action == "status":
            result = statuses(root, json.loads(args.jobs))
        elif args.action == "retry":
            directory = job_dir(root, args.job)
            with bootstrap.TargetLock(directory, "job"):
                current = read_json(directory / "status.json")
                if current.get("state") != "failed" or current.get("checkout_removed") or current.get("retryable") is False:
                    raise bootstrap.BootstrapError("Only a failed setup/teardown before removal can be retried")
                result = update(root, args.job, state="queued", pid=None, error=None,
                                queued_at=time.time(), step="Waiting to retry lifecycle job")
        elif args.action == "logs":
            path = job_dir(root, args.job) / "output.log"
            if path.exists():
                with path.open("rb") as stream:
                    stream.seek(max(0, path.stat().st_size - 32000))
                    result = stream.read().decode("utf-8", "replace")
            else:
                result = "No hook output yet."
        elif args.action == "progress":
            result = report(root, args.job, args.step, args.percent)
        elif args.action == "gate":
            command = json.loads(args.command) if args.command else read_json(job_dir(root, args.job) / "spec.json").get("command", [])
            return gate(root, args.job, command)
        else:
            result = inspect(args.target)
        if args.action not in {"progress", "run"}:
            print(json.dumps(result, ensure_ascii=False))
        return 0
    except (bootstrap.BootstrapError, OSError, ValueError, KeyboardInterrupt) as error:
        print(json.dumps({"error": "Lifecycle job interrupted" if isinstance(error, KeyboardInterrupt) else str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
