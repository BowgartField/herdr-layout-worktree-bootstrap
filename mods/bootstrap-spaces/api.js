import { appHome, exec, hc, spaces, panes, shared, setShared, run, notify, layout } from "herdr";

export const JOBS = "worktree-bootstrap.jobs";
const cache = {};
export const allJobs = () => shared(JOBS) ?? {};
const running = job => job.state === "queued" || job.state === "running";

export async function runtime(machine) {
  const key = machine ?? "";
  if (cache[key]) return cache[key];
  let root;
  if (machine) {
    const r = await exec("python3", ["-c", "from pathlib import Path; print(Path.home())"], { on: machine });
    if (r.code !== 0) throw new Error("Python 3 is required on the target machine.");
    root = `${r.stdout.trim()}/.local/share/herdr-mod-worktree-bootstrap`;
  } else root = `${appHome()}/data/worktree-bootstrap`;
  const value = { runner: `${root}/runtime/runner.py`, stateDir: `${root}/jobs` };
  const check = await exec("python3", ["-c", "import os,sys; sys.exit(0 if os.path.isfile(sys.argv[1]) else 1)", value.runner], { on: machine });
  if (check.code !== 0) throw new Error("Install the worktree-bootstrap runtime on this machine first.");
  return cache[key] = value;
}

export async function call(action, args = [], machine = null, paths = null) {
  const p = paths ?? await runtime(machine);
  const r = await exec("python3", [p.runner, action, "--state-dir", p.stateDir, ...args], { on: machine });
  let value;
  try { value = JSON.parse(r.stdout); } catch { throw new Error("The lifecycle runtime returned an invalid response."); }
  if (r.code !== 0 || value?.error) throw new Error(value?.error || "The lifecycle command failed.");
  return value;
}

export function remember(job, machine = null, paths = null) {
  const previous = allJobs();
  setShared(JOBS, { ...previous, [job.id]: { ...previous[job.id], ...job,
    machine: machine ?? job.machine ?? previous[job.id]?.machine ?? null,
    ...(paths ? { runner: paths.runner, stateDir: paths.stateDir } : {}) } });
}

export async function launch(job) {
  const args = ["run", "--json", "--bg", "--rm", "--no-parent", "--no-notify", "--outlive-parent",
    "--cwd", job.source];
  if (job.machine) args.push("--on", job.machine);
  args.push("--", "python3", job.runner, "run", "--state-dir", job.stateDir, "--job", job.id);
  const r = await hc(args);
  if (r.code !== 0) throw new Error("Could not start the lifecycle job in herdr-core.");
}

export async function prepare(options, machine = null) {
  const paths = await runtime(machine);
  const args = ["--operation", options.action, "--source", options.source, "--target", options.target];
  if (options.branch) args.push("--branch", options.branch);
  if (options.argv) args.push("--command", JSON.stringify(options.argv));
  if (options.force) args.push("--force");
  if (options.branchAction) args.push("--branch-action", options.branchAction, "--confirm-branch", options.confirmBranch ?? "");
  const job = await call("prepare", args, machine, paths);
  remember({ ...job, space: options.space ?? null, tab_name: options.tabName ?? null }, machine, paths);
  const tracked = allJobs()[job.id];
  try { await launch(tracked); }
  catch (error) {
    remember({ ...tracked, state: "failed", error: String(error), step: "Unable to start lifecycle job" }, machine, paths);
    throw error;
  }
  return tracked;
}

export function openGate(job, reopen = false) {
  const current = allJobs()[job.id] ?? job;
  const existing = spaces().find(space => (space.machine ?? null) === (current.machine ?? null) && place(space) === current.target);
  if (existing) {
    remember({ ...current, space: existing.id, tab: existing.tabs[0]?.id, opening: true }, current.machine, current);
    run("space.select", { id: existing.id });
    return;
  }
  if (current.opening && !reopen) return;
  // Claim the open before posting it, so dialog and coordinator never open twice.
  remember({ ...current, opening: true, space: null, tab: null }, current.machine, current);
  try {
    run("space.new", { folder: current.target, machine: current.machine, tab: current.tab_name,
      argv: ["python3", current.runner, "gate", "--state-dir", current.stateDir, "--job", current.id] });
  } catch (error) {
    remember({ ...current, opening: true, open_error: String(error) }, current.machine, current);
    throw error;
  }
}

export function place(space) {
  const tabs = new Set((space?.tabs ?? []).map(tab => tab.id));
  return panes().find(pane => tabs.has(pane.tab) && pane.cwd)?.cwd ?? space?.folder;
}

export function jobForSpace(space) {
  if (!space) return null;
  return Object.values(allJobs()).filter(job => (job.machine ?? null) === (space.machine ?? null)
    && (job.space === space.id || job.target === place(space)))
    .sort((a, b) => b.created - a.created)[0] ?? null;
}

export function setupJob() {
  const space = spaces().find(item => item.active);
  const job = jobForSpace(space);
  const tab = space?.tabs.find(item => item.active);
  return job && job.action !== "remove" && job.checkout_ready && job.state !== "success"
    && tab?.id === (job.tab ?? space?.tabs[0]?.id) ? job : null;
}

export function syncSetupView() {
  const child = setupJob() ? "bootstrap-setup" : "main";
  const find = node => node?.id === "bootstrap-content" ? node
    : (node?.children ?? []).map(find).find(Boolean);
  const stack = find(layout());
  if (!stack || stack.active === child) return;
  run("layout.select", { stack: "bootstrap-content", child });
}

let polling = false;
export async function pollJobs() {
  if (polling) return;
  polling = true;
  try {
    const groups = new Map();
    for (const job of Object.values(allJobs())) {
      if (!running(job)) continue;
      const key = JSON.stringify([job.machine, job.runner, job.stateDir]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const values = await call("status", ["--jobs", JSON.stringify(group.map(job => job.id))], first.machine, first);
      for (const value of values) {
        const current = allJobs()[value.id];
        if (!current || (value.revision ?? 0) < (current.revision ?? 0)) continue;
        let next = { ...current, ...value };
        if (next.checkout_ready && (!next.space || !spaces().some(space => space.id === next.space))) {
          const space = spaces().find(space => (space.machine ?? null) === (next.machine ?? null) && place(space) === next.target);
          if (space) next = { ...next, space: space.id, tab: space.tabs[0]?.id };
        }
        if (!next.space && !next.opening && next.checkout_ready && next.action === "create") {
          remember(next, next.machine, next);
          openGate(next);
          next = allJobs()[next.id];
        }
        if (next.checkout_removed && next.space && !next.space_closed) {
          run("space.close", { id: next.space, confirmed: true });
          next.space_closed = true;
        }
        if (next.updated !== current.updated || next.space !== current.space || next.space_closed !== current.space_closed)
          remember(next, next.machine, next);
        if (next.state !== current.state && !running(next)) notify({
          title: next.state === "success" ? "Worktree ready" : "Worktree lifecycle failed",
          body: next.state === "success" ? next.step : next.error,
          level: next.state === "success" ? "success" : "error",
        });
      }
    }
  } finally { polling = false; }
}

export async function retry(job) {
  const next = await call("retry", ["--job", job.id], job.machine, job);
  remember({ ...job, ...next }, job.machine, job);
  await launch(allJobs()[job.id]);
}

export async function readLog(job) {
  return await call("logs", ["--job", job.id], job.machine, job);
}
