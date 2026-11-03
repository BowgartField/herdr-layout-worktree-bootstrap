import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bootstrap_runner", ROOT / "runtime/runner.py")
runner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.run_git(self.repo, "init", "-b", "main")
        self.run_git(self.repo, "config", "user.email", "fixture@example.test")
        self.run_git(self.repo, "config", "user.name", "Fixture")
        (self.repo / ".gitignore").write_text(".env\n")
        (self.repo / "tracked.txt").write_text("original\n")
        self.run_git(self.repo, "add", ".")
        self.run_git(self.repo, "commit", "-m", "fixture")
        self.state = self.root / "jobs"
        self.target = self.root / "feature"
        (self.repo / ".herdr").mkdir()

    def run_git(self, path, *args):
        return subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True, check=True)

    def hooks(self, **phases):
        (self.repo / ".herdr/worktree-setup.json").write_text(json.dumps({"version": 2, "hooks": phases}))

    def command(self, name, script, timeout=10):
        return {"name": name, "argv": [sys.executable, "-c", script], "timeout_seconds": timeout}

    def create(self):
        job = runner.prepare(self.state, action="create", source=self.repo, target=self.target, branch_name="feature/demo")
        runner.run_job(self.state, job["id"])
        return job

    def remove(self, **kwargs):
        return runner.prepare(self.state, action="remove", source=self.repo, target=self.target, **kwargs)

    def status(self, job):
        return runner.statuses(self.state, [job["id"]])[0]

    def test_copies_only_ignored_configured_files_and_uses_lifecycle_environment(self):
        (self.repo / ".env").write_text("LOCAL_FIXTURE=1\n")
        (self.repo / ".herdr/worktree-copy.list").write_text(".env\ntracked.txt\n")
        self.hooks(on_created=[self.command("Check copied environment", "import os,pathlib; assert pathlib.Path('.env').exists(); assert pathlib.Path(os.environ['HERDR_PRIMARY_PATH']).name=='repo'; pathlib.Path('setup.ok').write_text('ok')")])
        job = self.create()
        self.assertEqual((self.target / ".env").read_text(), "LOCAL_FIXTURE=1\n")
        self.assertTrue((self.target / "setup.ok").exists())
        self.assertEqual(self.status(job)["copied_count"], 1)
        self.assertEqual(self.status(job)["state"], "success")

    def test_setup_failure_keeps_checkout_and_exposes_failure_without_argv(self):
        self.hooks(on_created=[self.command("Fail setup", "raise SystemExit(7)")])
        job = runner.prepare(self.state, action="create", source=self.repo, target=self.target, branch_name="feature/demo")
        with self.assertRaises(runner.bootstrap.SetupCommandError):
            runner.run_job(self.state, job["id"])
        self.assertTrue((self.target / ".git").exists())
        self.assertEqual(self.status(job)["state"], "failed")
        self.assertNotIn("SystemExit", json.dumps(self.status(job)))

    def test_failed_before_remove_never_requests_git_removal(self):
        self.create()
        self.hooks(before_remove=[self.command("Refuse teardown", "raise SystemExit(4)")])
        job = self.remove()
        with self.assertRaises(runner.bootstrap.SetupCommandError):
            runner.run_job(self.state, job["id"])
        self.assertTrue(self.target.exists())
        self.assertFalse(self.status(job)["checkout_removed"])

    def test_hook_that_makes_checkout_dirty_blocks_even_forced_removal(self):
        self.create()
        self.hooks(before_remove=[self.command("Edit checkout", "from pathlib import Path; Path('tracked.txt').write_text('changed')")])
        job = self.remove(force=True)
        with self.assertRaisesRegex(runner.bootstrap.BootstrapError, "became dirty"):
            runner.run_job(self.state, job["id"])
        self.assertTrue(self.target.exists())

    def test_teardown_precedes_removal_and_after_remove_runs_in_primary(self):
        self.create()
        self.hooks(
            before_remove=[self.command("Before", "from pathlib import Path; assert Path('.git').exists()")],
            after_remove=[self.command("After", "import os; from pathlib import Path; assert not Path(os.environ['HERDR_WORKTREE_PATH']).exists(); Path('after.ok').write_text('ok')")],
        )
        job = self.remove()
        runner.run_job(self.state, job["id"])
        self.assertFalse(self.target.exists())
        self.assertTrue((self.repo / "after.ok").exists())
        self.assertTrue(self.status(job)["checkout_removed"])

    def test_safe_branch_cleanup_keeps_unmerged_commits(self):
        self.create()
        (self.target / "unmerged.txt").write_text("keep this commit")
        self.run_git(self.target, "add", "unmerged.txt")
        self.run_git(self.target, "commit", "-m", "unmerged")
        job = self.remove(branch_action="safe", confirm_branch="feature/demo")
        with self.assertRaises(runner.bootstrap.BootstrapError):
            runner.run_job(self.state, job["id"])
        self.assertFalse(self.target.exists())
        self.assertTrue(self.status(job)["checkout_removed"])
        self.run_git(self.repo, "show-ref", "--verify", "refs/heads/feature/demo")

    def test_branch_deletion_requires_exact_confirmation(self):
        self.create()
        with self.assertRaisesRegex(runner.bootstrap.BootstrapError, "exact branch"):
            self.remove(branch_action="force", confirm_branch="other")
        self.assertTrue(self.target.exists())

    def test_timed_out_hook_is_stopped_and_checkout_is_kept(self):
        self.hooks(on_created=[self.command("Wait too long", "import time; time.sleep(30)", timeout=1)])
        job = runner.prepare(self.state, action="create", source=self.repo, target=self.target, branch_name="feature/demo")
        with self.assertRaises(runner.bootstrap.SetupCommandError):
            runner.run_job(self.state, job["id"])
        self.assertEqual(self.status(job)["state"], "failed")
        self.assertTrue(self.target.exists())

    def test_script_reports_custom_step_from_background_process(self):
        self.hooks(on_created=[self.command("Custom progress", "import os,subprocess,time; subprocess.run([os.environ['HERDR_PROGRESS_COMMAND'],'--step','Migrating fixture database','--percent','42'],check=True); time.sleep(1.5)")])
        job = runner.prepare(self.state, action="create", source=self.repo, target=self.target, branch_name="feature/demo")
        process = subprocess.Popen([sys.executable, str(ROOT / "runtime/runner.py"), "run", "--state-dir", str(self.state), "--job", job["id"]], stdout=subprocess.DEVNULL)
        self.addCleanup(lambda: process.poll() is None and process.terminate())
        seen = False
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and process.poll() is None:
            status = self.status(job)
            if status.get("step") == "Migrating fixture database":
                self.assertEqual(status["percent"], 42)
                seen = True
                break
            time.sleep(0.05)
        self.assertTrue(seen)
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertEqual(self.status(job)["state"], "success")

    def test_gate_drops_input_before_starting_terminal_program(self):
        job = self.create()
        runner.update(self.state, job["id"], state="running", pid=os.getpid(), step="Waiting for fixture")
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        command = [sys.executable, "-c", "import select,sys; print('READY',flush=True); r,_,_=select.select([sys.stdin],[],[],0.3); sys.exit(9 if r else 0)"]
        process = subprocess.Popen([sys.executable, str(ROOT / "runtime/runner.py"), "gate", "--state-dir", str(self.state), "--job", job["id"], "--command", json.dumps(command)], stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        self.addCleanup(lambda: process.poll() is None and process.terminate())
        self.assertTrue(select.select([master], [], [], 3)[0])
        os.read(master, 4096)
        os.write(master, b"input that must never reach the program\n")
        runner.update(self.state, job["id"], state="success")
        self.assertEqual(process.wait(timeout=5), 0)

    def test_lost_worker_disables_retry_to_avoid_overlapping_orphan_hooks(self):
        job = self.create()
        runner.update(self.state, job["id"], state="running", pid=999999999)
        current = self.status(job)
        self.assertEqual(current["state"], "failed")
        self.assertFalse(current["retryable"])
        process = subprocess.run([sys.executable, str(ROOT / "runtime/runner.py"), "retry",
            "--state-dir", str(self.state), "--job", job["id"]], capture_output=True)
        self.assertNotEqual(process.returncode, 0)

    def test_late_progress_cannot_overwrite_completed_state(self):
        job = self.create()
        runner.report(self.state, job["id"], "Late report", 1)
        self.assertEqual(self.status(job)["step"], "Setup complete")
        self.assertEqual(self.status(job)["percent"], 100)

    def test_terminal_command_stays_private_and_gate_recovers_it_from_spec(self):
        command = [sys.executable, "-c", "print('SPEC_COMMAND_READY')"]
        job = runner.prepare(self.state, action="create", source=self.repo, target=self.target,
                             branch_name="feature/demo", command=command)
        self.assertNotIn("SPEC_COMMAND_READY", json.dumps(job))
        runner.run_job(self.state, job["id"])
        result = subprocess.run([sys.executable, str(ROOT / "runtime/runner.py"), "gate",
            "--state-dir", str(self.state), "--job", job["id"]], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertIn("SPEC_COMMAND_READY", result.stdout)

    def test_progress_rejects_out_of_range_values(self):
        job = self.create()
        runner.update(self.state, job["id"], state="running")
        with self.assertRaises(runner.bootstrap.BootstrapError):
            runner.report(self.state, job["id"], "Invalid", 101)


if __name__ == "__main__":
    unittest.main()
