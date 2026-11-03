import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { context } from "./herdr-stub.mjs";

async function api() {
  context.store = {}; context.calls = []; context.requests = []; context.response = null;
  context.spaces = [{ id: "space-1", active: true, folder: "/repo/feature", machine: null,
    tabs: [{ id: "tab-1", active: true }, { id: "tab-2", active: false }] }];
  context.panes = [];
  context.tree = { id: "bootstrap-content", active: "main" };
  const stub = new URL("./herdr-stub.mjs", import.meta.url).href;
  const source = (await fs.readFile(new URL("../mods/api.js", import.meta.url), "utf8"))
    .replace('from "herdr"', `from ${JSON.stringify(stub)}`);
  return import("data:text/javascript;base64," + Buffer.from(source + `\n// ${Math.random()}`).toString("base64"));
}
const job = () => ({ id: "job", action: "create", created: 1, updated: 1, revision: 1,
  source: "/repo", target: "/repo/feature", machine: null, space: "space-1", tab: "tab-1",
  checkout_ready: true, state: "running", runner: "/runtime/runner.py", stateDir: "/jobs" });

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

test("job state is preserved separately from its runtime state directory", async () => {
  const m = await api();
  context.response = { ...job(), state: "queued", checkout_ready: false };
  const next = await m.prepare({ action: "create", source: "/repo", target: "/repo/feature", branch: "feature" });
  assert.equal(next.state, "queued");
  assert.equal(next.stateDir, "/fixture/app/data/worktree-bootstrap/jobs");
  const launch = context.requests.find(([name]) => name === "hc");
  assert.ok(launch[1].includes("--bg")); assert.ok(launch[1].includes("--no-parent"));
  assert.ok(launch[1].includes(next.stateDir));
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
  assert.ok(args.argv.includes("gate"));
  assert.equal(m.allJobs().job.opening, true);
});

test("explicit reopening rebinds the job to the new space and its first tab", async () => {
  const m = await api(); m.remember({ ...job(), space: "closed-space", tab: "closed-tab", opening: true });
  m.openGate(m.allJobs().job, true);
  assert.equal(m.allJobs().job.space, "space-1");
  assert.equal(m.allJobs().job.tab, "tab-1");
});
