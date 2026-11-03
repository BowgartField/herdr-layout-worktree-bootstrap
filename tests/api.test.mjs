import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { context, reset } from "./herdr-stub.mjs";

// src/api.js with its "herdr" import pointed at the stub.
async function api() {
  reset();
  context.spaces = [{ id: "space-1", active: true, folder: "/repo/feature", machine: null,
    tabs: [{ id: "tab-1", active: true }, { id: "tab-2", active: false }] }];
  context.tree = { id: "bootstrap-content", active: "main" };
  const url = (p) => JSON.stringify(new URL(p, import.meta.url).href);
  const source = (await fs.readFile(new URL("../src/api.js", import.meta.url), "utf8"))
    .replace('from "herdr"', `from ${url("./herdr-stub.mjs")}`)
    .replace('from "./worker.js"', `from ${url("../mods/worktree-bootstrap/worker.js")}`)
    .replace('from "./engine.js"', `from ${url("../src/engine.js")}`);
  return import("data:text/javascript;base64," + Buffer.from(source + `\n// ${Math.random()}`).toString("base64"));
}
const job = () => ({ id: "job", action: "create", created: 1, updated: 1, revision: 1,
  source: "/repo", target: "/repo/feature", machine: null, space: "space-1", tab: "tab-1",
  checkout_ready: true, state: "running", runner: "/runtime/worker.sh", stateDir: "/jobs" });
const workerCalls = () => context.requests.filter(([cmd, args]) => cmd === "sh" && args[0] !== "-c");

test("setup blocks only its own first tab, not another tab or workspace", async () => {
  const m = await api(); m.remember(job());
  assert.equal(m.setupJob().id, "job");
  context.spaces[0].tabs[0].active = false; context.spaces[0].tabs[1].active = true;
  assert.equal(m.setupJob(), null);
  context.spaces[0].active = false;
  context.spaces.push({ id: "other", active: true, folder: "/other", machine: null, tabs: [{ id: "other-tab", active: true }] });
  assert.equal(m.setupJob(), null);
});

test("failed setup stays gated; success releases the panel", async () => {
  const m = await api(); m.remember({ ...job(), state: "failed" });
  assert.ok(m.setupJob()); m.syncSetupView();
  assert.deepEqual(context.calls, [["layout.select", { stack: "bootstrap-content", child: "bootstrap-setup" }]]);
  m.syncSetupView(); assert.equal(context.calls.length, 1);
  m.remember({ ...job(), state: "success" });
  assert.equal(m.setupJob(), null); m.syncSetupView();
  assert.deepEqual(context.calls[1], ["layout.select", { stack: "bootstrap-content", child: "main" }]);
});

test("prepare installs the worker, passes plain sh files and starts the job in herdr-core", async () => {
  const m = await api();
  context.files["/repo/.herdr/worktree-setup.json"] = JSON.stringify({ version: 2, hooks: { on_created: [{ name: "Deps", argv: ["npm", "ci"], timeout_seconds: 60 }] } });
  context.response = { ...job(), state: "queued", checkout_ready: false };
  const next = await m.prepare({ action: "create", source: "/repo", target: "/home/x/.herdr/worktrees/repo/feature", branch: "feature", argv: ["claude"] });
  assert.equal(next.state, "queued");
  assert.equal(next.stateDir, "/fixture/app/data/worktree-bootstrap/jobs");
  assert.equal(next.runner, "/fixture/app/data/worktree-bootstrap/runtime/worker.sh");
  const install = context.requests.find(([cmd, args]) => cmd === "sh" && args[0] === "-c" && args[1].includes('worker.sh" install'));
  assert.equal(install[1][3], "/fixture/app/data/worktree-bootstrap/runtime");
  const [, prepareArgs] = workerCalls()[0];
  assert.equal(prepareArgs[1], "prepare");
  assert.match(prepareArgs[4], /^action='create'$/m);
  assert.match(prepareArgs[4], /terminal_command\(\) \{ exec 'claude'; \}/);
  assert.match(prepareArgs[5], /hook_on_created_1\(\) \{ run_hook 'Deps' 60 'npm' 'ci'; \}/);
  const launch = context.requests.find(([name]) => name === "hc");
  assert.ok(launch[1].includes("--bg")); assert.ok(launch[1].includes("--no-parent"));
  assert.deepEqual(launch[1].slice(-4), ["sh", next.runner, "run", `${next.stateDir}/${next.id}`]);
});

test("invalid configuration and unconfirmed branch deletion are refused before any job exists", async () => {
  const m = await api();
  context.files["/repo/.herdr/worktree-setup.json"] = "{ broken";
  await assert.rejects(m.prepare({ action: "create", source: "/repo", target: "/elsewhere", branch: "x" }), /invalid JSON/);
  delete context.files["/repo/.herdr/worktree-setup.json"];
  await assert.rejects(m.prepare({ action: "remove", source: "/repo", target: "/repo/feature", branchAction: "force", confirmBranch: "other" }), /exact branch/);
  await assert.rejects(m.prepare({ action: "create", source: "/repo", target: "/elsewhere", branch: "-x" }), /valid branch/);
  context.files["/taken"] = "";
  await assert.rejects(m.prepare({ action: "create", source: "/repo", target: "/taken", branch: "x" }), /already exists/);
  assert.equal(workerCalls().length, 0);
});

test("the main checkout can never be removed", async () => {
  const m = await api();
  await assert.rejects(m.prepare({ action: "remove", source: "/repo", target: "/repo" }), /linked checkout/);
});

test("stale status replies cannot regress a newer lifecycle state", async () => {
  const m = await api(); m.remember(job());
  context.response = () => {
    m.remember({ ...job(), state: "success", updated: 3, revision: 3 });
    return [{ ...job(), state: "running", updated: 2, revision: 2 }];
  };
  await m.pollJobs();
  assert.equal(m.allJobs().job.state, "success");
});

test("jobs of the former Python runtime are stopped, never retried", async () => {
  const m = await api(); m.remember({ ...job(), runner: "/runtime/runner.py" });
  await m.pollJobs();
  assert.equal(m.allJobs().job.state, "failed");
  assert.equal(m.allJobs().job.retryable, false);
  assert.equal(workerCalls().length, 0);
});

test("removal closes only the explicitly requested space after checkout removal", async () => {
  const m = await api(); m.remember({ ...job(), action: "remove" });
  context.response = [{ ...job(), action: "remove", state: "success", checkout_removed: true, revision: 2, updated: 2 }];
  await m.pollJobs();
  assert.ok(context.calls.some(([name, args]) => name === "space.close" && args.id === "space-1" && args.confirmed));
  assert.ok(!context.calls.some(([name]) => name === "space.select" || name === "tab.close"));
});

test("runtime path metadata never overwrites new status or reopened-space fields", async () => {
  const m = await api(); const old = { ...job(), state: "failed", space: "old-space", tab: "old-tab" };
  m.remember(old);
  m.remember({ ...old, state: "queued", space: "new-space", tab: "new-tab" }, old.machine, old);
  assert.equal(m.allJobs().job.state, "queued");
  assert.equal(m.allJobs().job.space, "new-space");
  assert.equal(m.allJobs().job.tab, "new-tab");
});

test("dialog and coordinator claim a new space exactly once", async () => {
  const m = await api(); context.spaces = [];
  m.remember({ ...job(), space: null, tab: null });
  m.openGate(m.allJobs().job); m.openGate(m.allJobs().job);
  assert.equal(context.calls.filter(([name]) => name === "space.new").length, 1);
  const args = context.calls.find(([name]) => name === "space.new")[1];
  assert.deepEqual(args.argv, ["sh", "/runtime/worker.sh", "gate", "/jobs/job"]);
  assert.equal(m.allJobs().job.opening, true);
});

test("explicit reopening rebinds the job to the new space and its first tab", async () => {
  const m = await api(); m.remember({ ...job(), space: "closed-space", tab: "closed-tab", opening: true });
  m.openGate(m.allJobs().job, true);
  assert.equal(m.allJobs().job.space, "space-1");
  assert.equal(m.allJobs().job.tab, "tab-1");
});

test("retry sends the configuration as it is now", async () => {
  const m = await api(); m.remember({ ...job(), state: "failed" });
  context.files["/repo/.herdr/worktree-setup.json"] = JSON.stringify({ version: 1, commands: [{ name: "Fixed", argv: ["true"], timeout_seconds: 5 }] });
  context.response = { ...job(), state: "queued", revision: 2 };
  await m.retry(m.allJobs().job);
  const [, args] = workerCalls()[0];
  assert.deepEqual(args.slice(1, 3), ["retry", "/jobs/job"]);
  assert.match(args[3], /run_hook 'Fixed' 5 'true'/);
  assert.equal(m.allJobs().job.state, "queued");
});

test("the scripts editor reads, then writes only what changed and keeps it out of git status", async () => {
  const m = await api();
  context.files["/repo/.herdr/worktree-copy.list"] = "# mine\n.env\n";
  const loaded = await m.readScripts("/repo", null);
  assert.equal(loaded.repo.linked, false);
  assert.deepEqual(loaded.copyPaths, [".env"]);
  assert.equal(loaded.hooks.on_created.length, 0);
  const hooks = { on_created: [{ name: "Deps", argv: ["npm", "ci"], timeout_seconds: 900 }], before_remove: [], after_remove: [] };
  assert.equal(await m.saveScripts(loaded, hooks, [".env"], null), 1);
  assert.deepEqual(context.writes, ["/repo/.herdr/worktree-setup.json"]);
  assert.equal(context.files["/repo/.herdr/worktree-copy.list"], "# mine\n.env\n");
  assert.deepEqual(JSON.parse(context.files["/repo/.herdr/worktree-setup.json"]).hooks.on_created[0].argv, ["npm", "ci"]);
  const excluded = context.requests.find(([cmd, args]) => cmd === "sh" && args[0] === "-c" && args.includes("/repo/.git/info/exclude"));
  assert.ok(excluded[1].includes("/.herdr/worktree-setup.json"));
  // Edited elsewhere since it was read: refused.
  context.files["/repo/.herdr/worktree-setup.json"] = "{}";
  await assert.rejects(m.saveScripts(loaded, hooks, [".env"], null), /stale/);
});

test("saving an empty form creates no files", async () => {
  const m = await api();
  const loaded = await m.readScripts("/repo", null);
  assert.equal(await m.saveScripts(loaded, loaded.hooks, [], null), 0);
  assert.deepEqual(context.writes, []);
});
