// Integration tests for runtime/worker.sh with real Git repositories.
// Run under /bin/sh and, when installed, dash (Debian/Ubuntu's /bin/sh).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jobFile, hooksFile, newJobId } from "../src/engine.js";

const WORKER = new URL("../runtime/worker.sh", import.meta.url).pathname;
const shells = ["sh", ...["dash"].filter((s) => spawnSync("sh", ["-c", `command -v ${s}`]).status === 0)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(shell) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtb-")));
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime);
  fs.copyFileSync(WORKER, path.join(runtime, "worker.sh"));
  const worker = path.join(runtime, "worker.sh");
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".herdr"), { recursive: true });
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "fixture@example.test");
  git(repo, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n.cache/\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "original\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "fixture");
  const sh = (...args) => spawnSync(shell, [worker, ...args], { encoding: "utf8" });
  const f = {
    root, repo, git, sh, worker, jobs: path.join(root, "jobs"), target: path.join(root, "feature"),
    hooks: {}, copy: [],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    prepare(spec) {
      const id = newJobId();
      const r = sh("prepare", f.jobs, id, jobFile({ source: repo, target: f.target, ...spec }), hooksFile(f.hooks, f.copy));
      if (r.status !== 0) throw new Error(r.stderr.trim());
      return { id, dir: path.join(f.jobs, id), status: JSON.parse(r.stdout) };
    },
    run(job) { return sh("run", job.dir); },
    status(job) { return JSON.parse(sh("status", f.jobs, job.id).stdout)[0]; },
    log(job) { return sh("logs", job.dir).stdout; },
    create(extra = {}) {
      const job = f.prepare({ action: "create", branch: "feature/demo", ...extra });
      const r = f.run(job);
      assert.equal(r.status, 0, f.log(job));
      return job;
    },
  };
  assert.equal(sh("install").status, 0);
  return f;
}
const cmd = (name, script, timeout = 10) => ({ name, argv: ["sh", "-c", script], timeout_seconds: timeout });

for (const shell of shells) {
  const t = (name, body) => test(`[${shell}] ${name}`, async () => {
    const f = fixture(shell);
    try { await body(f); } finally { f.cleanup(); }
  });

  t("copies only ignored configured files and passes the lifecycle environment", (f) => {
    fs.writeFileSync(path.join(f.repo, ".env"), "LOCAL_FIXTURE=1\n");
    fs.mkdirSync(path.join(f.repo, ".cache/deep"), { recursive: true });
    fs.writeFileSync(path.join(f.repo, ".cache/deep/x"), "x");
    fs.symlinkSync("deep/x", path.join(f.repo, ".cache/link"));
    f.copy = [".env", "tracked.txt", ".cache", "missing.env"];
    f.hooks = { on_created: [cmd("Check", 'test -f .env && test "$(basename "$HERDR_PRIMARY_PATH")" = repo && test "$HERDR_WORKTREE_BRANCH" = feature/demo && echo ok > setup.ok')] };
    const job = f.create();
    assert.equal(fs.readFileSync(path.join(f.target, ".env"), "utf8"), "LOCAL_FIXTURE=1\n");
    assert.equal(fs.readlinkSync(path.join(f.target, ".cache/link")), "deep/x");
    assert.ok(fs.existsSync(path.join(f.target, "setup.ok")));
    const s = f.status(job);
    assert.equal(s.copied_count, 2);
    assert.equal(s.state, "success");
    assert.equal(s.percent, 100);
    assert.ok(!fs.readdirSync(f.target).some((n) => n.startsWith(".herdr-worktree-bootstrap-txn-")));
  });

  t("arguments are passed exactly, never shell-expanded", (f) => {
    f.hooks = { on_created: [{ name: "Exact", argv: ["sh", "-c", 'printf "%s|" "$@" > args.txt', "x", "$HOME", "a b", "it's", "*", "`id`"], timeout_seconds: 10 }] };
    f.create();
    assert.equal(fs.readFileSync(path.join(f.target, "args.txt"), "utf8"), "$HOME|a b|it's|*|`id`|");
  });

  t("setup failure keeps the checkout and the status never shows argv", (f) => {
    f.hooks = { on_created: [cmd("Fail setup", "echo SECRET_ARG >&2; exit 7")] };
    const job = f.prepare({ action: "create", branch: "feature/demo" });
    assert.notEqual(f.run(job).status, 0);
    assert.ok(fs.existsSync(path.join(f.target, ".git")));
    const s = f.status(job);
    assert.equal(s.state, "failed");
    assert.match(s.error, /setup command 1 \(Fail setup\) failed with exit code 7/);
    assert.ok(!JSON.stringify(s).includes("SECRET_ARG"));
    assert.match(f.log(job), /SECRET_ARG/);
  });

  t("retry reruns setup with the hooks fixed meanwhile", (f) => {
    f.hooks = { on_created: [cmd("Flaky", "exit 3")] };
    const job = f.prepare({ action: "create", branch: "feature/demo" });
    f.run(job);
    f.hooks = { on_created: [cmd("Fixed", "touch fixed")] };
    assert.equal(f.sh("retry", job.dir, hooksFile(f.hooks, [])).status, 0);
    assert.equal(f.status(job).state, "queued");
    assert.equal(f.run(job).status, 0);
    assert.ok(fs.existsSync(path.join(f.target, "fixed")));
    assert.notEqual(f.sh("retry", job.dir, hooksFile(f.hooks, [])).status, 0);
  });

  t("a failed before_remove never lets Git remove the checkout", (f) => {
    f.create();
    f.hooks = { before_remove: [cmd("Refuse", "exit 4")] };
    const job = f.prepare({ action: "remove" });
    assert.notEqual(f.run(job).status, 0);
    assert.ok(fs.existsSync(f.target));
    assert.equal(f.status(job).checkout_removed, false);
  });

  t("a hook that makes the checkout dirty blocks even forced removal", (f) => {
    f.create();
    f.hooks = { before_remove: [cmd("Edit", "echo changed > tracked.txt")] };
    const job = f.prepare({ action: "remove", force: true });
    assert.notEqual(f.run(job).status, 0);
    assert.match(f.status(job).error, /became dirty/);
    assert.ok(fs.existsSync(f.target));
  });

  t("a dirty checkout needs force to be prepared for removal", (f) => {
    f.create();
    fs.writeFileSync(path.join(f.target, "new.txt"), "x");
    assert.throws(() => f.prepare({ action: "remove" }), /explicit force/);
    const job = f.prepare({ action: "remove", force: true });
    assert.equal(f.run(job).status, 0, f.log(job));
    assert.ok(!fs.existsSync(f.target));
  });

  t("teardown precedes removal and after_remove runs in the primary checkout", (f) => {
    f.create();
    f.hooks = {
      before_remove: [cmd("Before", "test -e .git")],
      after_remove: [cmd("After", 'test ! -e "$HERDR_WORKTREE_PATH" && test "$HERDR_LEFTOVER_DETECTED" = 0 && touch after.ok')],
    };
    const job = f.prepare({ action: "remove" });
    assert.equal(f.run(job).status, 0, f.log(job));
    assert.ok(!fs.existsSync(f.target));
    assert.ok(fs.existsSync(path.join(f.repo, "after.ok")));
    assert.equal(f.status(job).checkout_removed, true);
    f.git(f.repo, "show-ref", "--verify", "refs/heads/feature/demo");
  });

  t("safe branch cleanup keeps unmerged commits", (f) => {
    f.create();
    fs.writeFileSync(path.join(f.target, "unmerged.txt"), "keep this commit");
    f.git(f.target, "add", "unmerged.txt");
    f.git(f.target, "commit", "-q", "-m", "unmerged");
    const job = f.prepare({ action: "remove", branchAction: "safe" });
    assert.notEqual(f.run(job).status, 0);
    assert.ok(!fs.existsSync(f.target));
    assert.equal(f.status(job).checkout_removed, true);
    f.git(f.repo, "show-ref", "--verify", "refs/heads/feature/demo");
    assert.notEqual(f.sh("retry", job.dir, hooksFile({}, [])).status, 0);
  });

  t("safe branch cleanup deletes a merged branch", (f) => {
    f.create();
    const job = f.prepare({ action: "remove", branchAction: "safe" });
    assert.equal(f.run(job).status, 0, f.log(job));
    assert.equal(f.status(job).branch_result, "deleted_safely");
    assert.throws(() => f.git(f.repo, "show-ref", "--verify", "--quiet", "refs/heads/feature/demo"));
  });

  t("protected branches are never deleted", (f) => {
    f.git(f.repo, "branch", "develop");
    const job = f.create({ branch: "develop" });
    const removal = f.prepare({ action: "remove", branchAction: "force" });
    assert.notEqual(f.run(removal).status, 0);
    assert.match(f.status(removal).error, /protected branch/);
    f.git(f.repo, "show-ref", "--verify", "refs/heads/develop");
    assert.ok(job);
  });

  t("a timed-out hook is stopped with its children and the checkout is kept", async (f) => {
    const marker = path.join(f.root, "child-alive");
    f.hooks = { on_created: [cmd("Wait too long", `(sleep 4; touch "${marker}") & sleep 30`, 1)] };
    const job = f.prepare({ action: "create", branch: "feature/demo" });
    const start = Date.now();
    assert.notEqual(f.run(job).status, 0);
    assert.ok(Date.now() - start < 8000);
    assert.match(f.status(job).error, /timed out after 1s/);
    assert.ok(fs.existsSync(f.target));
    await sleep(4500);
    assert.ok(!fs.existsSync(marker), "the hook's child kept running");
  });

  t("a missing executable is reported without running anything", (f) => {
    f.hooks = { on_created: [{ name: "Ghost", argv: ["definitely-not-a-program-xyz"], timeout_seconds: 5 }] };
    const job = f.prepare({ action: "create", branch: "feature/demo" });
    assert.notEqual(f.run(job).status, 0);
    assert.match(f.status(job).error, /executable not found/);
  });

  t("a script reports its own step and percentage while it runs", async (f) => {
    f.hooks = { on_created: [cmd("Custom", '"$HERDR_PROGRESS_COMMAND" --step "Migrating fixture database" --percent 42 && "$HERDR_BIN_PATH" plugin progress report --step "Legacy form" && sleep 1.5')] };
    const job = f.prepare({ action: "create", branch: "feature/demo" });
    const child = spawn(shell, [f.worker, "run", job.dir], { stdio: "ignore" });
    const done = new Promise((resolve) => child.on("exit", resolve));
    let seen = false;
    for (let i = 0; i < 160 && !seen; i++) {
      const s = f.status(job);
      if (s?.step === "Legacy form") { assert.equal(s.percent, null); seen = true; }
      else await sleep(50);
    }
    assert.ok(seen);
    assert.equal(await done, 0);
    assert.equal(f.status(job).state, "success");
  });

  t("late progress cannot overwrite a finished job; bad values are refused", (f) => {
    const job = f.create();
    const env = { ...process.env, HERDR_BOOTSTRAP_JOB_DIR: job.dir };
    spawnSync(shell, [f.worker, "progress", "--step", "Late", "--percent", "1"], { env });
    assert.equal(f.status(job).step, "Setup complete");
    for (const args of [["--step", "x", "--percent", "101"], ["--step", "  "], ["--step", "x".repeat(161)], ["--step", "x", "--percent", "-1"]])
      assert.notEqual(spawnSync(shell, [f.worker, "progress", ...args], { env }).status, 0, args.join(" "));
  });

  t("a lost worker disables retry so orphaned hooks cannot overlap", (f) => {
    const job = f.prepare({ action: "create", branch: "feature/demo" });
    fs.writeFileSync(path.join(job.dir, "status/state"), "running");
    fs.writeFileSync(path.join(job.dir, "status/pid"), "999999");
    const s = f.status(job);
    assert.equal(s.state, "failed");
    assert.equal(s.retryable, false);
    assert.notEqual(f.sh("retry", job.dir, hooksFile({}, [])).status, 0);
  });

  t("the gate starts the private terminal command only after success", (f) => {
    const job = f.prepare({ action: "create", branch: "feature/demo", argv: ["sh", "-c", "echo SPEC_COMMAND_READY"] });
    assert.ok(!JSON.stringify(job.status).includes("SPEC_COMMAND_READY"));
    f.run(job);
    const r = spawnSync(shell, [f.worker, "gate", job.dir], { encoding: "utf8", timeout: 5000, cwd: f.target });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /SPEC_COMMAND_READY/);
  });

  t("status escapes messages as valid JSON", (f) => {
    const job = f.prepare({ action: "create", branch: "feature/demo" });
    fs.writeFileSync(path.join(job.dir, "status/error"), 'quote " back \\ tab \t\nline\u0001');
    assert.equal(f.status(job).error, 'quote " back \\ tab \t\nline');
  });

  t("a relative script is found in the hook's folder, else in the main checkout", (f) => {
    // Only in the main checkout (untracked): reached from the worktree too.
    fs.writeFileSync(path.join(f.repo, "setup.sh"), 'echo "main $(pwd -P)" > ran-main\n');
    fs.mkdirSync(path.join(f.repo, "scripts"));
    fs.writeFileSync(path.join(f.repo, "scripts/run.sh"), "#!/bin/sh\ntouch ran-direct\n", { mode: 0o755 });
    // Tracked: the worktree's own copy wins.
    fs.writeFileSync(path.join(f.repo, "tracked.sh"), "touch ran-tracked-main\n");
    f.git(f.repo, "add", "tracked.sh"); f.git(f.repo, "commit", "-q", "-m", "script");
    fs.writeFileSync(path.join(f.repo, "tracked.sh"), "touch ran-from-main-copy\n");
    f.hooks = {
      on_created: [
        { name: "Interpreter", argv: ["sh", "-e", "setup.sh"], timeout_seconds: 10 },
        { name: "Direct", argv: ["scripts/run.sh"], timeout_seconds: 10 },
        { name: "Tracked", argv: ["sh", "tracked.sh"], timeout_seconds: 10 },
        { name: "Inline", argv: ["sh", "-c", "test ! -e setup.sh && touch inline-ok", "setup.sh"], timeout_seconds: 10 },
      ],
      before_remove: [{ name: "Teardown", argv: ["bash", "setup.sh"], timeout_seconds: 10 }],
    };
    f.create();
    assert.equal(fs.readFileSync(path.join(f.target, "ran-main"), "utf8").trim(), `main ${f.target}`);
    for (const file of ["ran-direct", "ran-tracked-main", "inline-ok"]) assert.ok(fs.existsSync(path.join(f.target, file)), file);
    assert.ok(!fs.existsSync(path.join(f.target, "ran-from-main-copy")));
    const job = f.prepare({ action: "remove", force: true });
    assert.equal(f.run(job).status, 0, f.log(job));
  });

  t("an existing branch is checked out instead of created", (f) => {
    f.git(f.repo, "branch", "feature/demo");
    f.create();
    assert.equal(f.git(f.target, "symbolic-ref", "--short", "HEAD").trim(), "feature/demo");
  });
}
