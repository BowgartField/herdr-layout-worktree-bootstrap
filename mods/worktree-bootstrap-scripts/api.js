// Shared by every mod of this layout (copied into each folder at build time:
// a mod cannot import another mod's code). Talks to Git and to the sh worker
// through `exec`; nothing besides sh and Git is needed on any machine.
import { appHome, exec, hc, spaces, panes, shared, setShared, run, notify, layout, readTextFile, writeTextFile } from "herdr";
import { WORKER_SOURCE } from "./worker.js";
import {
  parseLifecycle, parseCopyList, serializeLifecycle, serializeCopyList, jobFile, hooksFile, newJobId,
  SETUP_FILE, COPY_LIST, PHASES, PROTECTED_BRANCHES,
} from "./engine.js";

export const JOBS = "worktree-bootstrap.jobs";
const cache = {};
export const allJobs = () => shared(JOBS) ?? {};
const running = job => job.state === "queued" || job.state === "running";
const jobDir = job => `${job.stateDir}/${job.id}`;

export async function git(cwd, args, machine) {
  const r = await exec("git", args, { cwd, on: machine });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// The worker lives in the app's data folder here, and in ~/.local/share on
// another machine. It is (re)written whenever it differs from this build.
export async function runtime(machine) {
  const key = machine ?? "";
  if (cache[key]) return cache[key];
  let root;
  if (machine) {
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine });
    if (r.code !== 0 || !r.stdout.trim()) throw new Error("Could not find the home folder on the target machine.");
    root = `${r.stdout.trim()}/.local/share/herdr-mod-worktree-bootstrap`;
  } else root = `${appHome()}/data/worktree-bootstrap`;
  const value = { runner: `${root}/runtime/worker.sh`, stateDir: `${root}/jobs` };
  const current = await readTextFile(value.runner, { on: machine }).catch(() => null);
  if (current !== WORKER_SOURCE) {
    const r = await exec("sh", ["-c", 'set -e; umask 022; mkdir -p "$1"; printf "%s" "$2" > "$1/worker.sh.tmp"; '
      + 'mv -f "$1/worker.sh.tmp" "$1/worker.sh"; sh "$1/worker.sh" install', "sh", `${root}/runtime`, WORKER_SOURCE], { on: machine });
    if (r.code !== 0) throw new Error(`Could not install the worktree worker: ${(r.stderr || r.stdout).trim()}`);
  }
  return cache[key] = value;
}

async function worker(paths, action, args, machine) {
  const r = await exec("sh", [paths.runner, action, ...args], { on: machine });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || "The lifecycle command failed.");
  return r.stdout;
}

// A folder's checkout (top), its repository (common) and primary checkout.
export async function repository(folder, machine) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], machine);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], machine);
  if (!top.ok || !common.ok) throw new Error("This folder is not in a Git repository.");
  const list = await git(top.out, ["worktree", "list", "--porcelain"], machine);
  const first = list.out.split("\n\n")[0].split("\n");
  const primary = first.find(line => line.startsWith("worktree "))?.slice(9);
  if (!list.ok || !primary || first.includes("bare")) throw new Error("The primary checkout is unavailable.");
  return { top: top.out, common: common.out, primary, linked: top.out !== primary };
}

// Both files from the primary checkout; null text when a file is absent.
export async function loadConfig(primary, machine) {
  const [setupText, copyText] = await Promise.all([SETUP_FILE, COPY_LIST]
    .map(file => readTextFile(`${primary}/${file}`, { on: machine })));
  return { setupText, copyText, hooks: parseLifecycle(setupText), copyPaths: parseCopyList(copyText) };
}

async function defaultBranch(primary, machine) {
  const origin = await git(primary, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], machine);
  if (origin.ok && origin.out) return origin.out.split("/").slice(1).join("/");
  for (const name of ["main", "master", "trunk", "develop", "development"])
    if ((await git(primary, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], machine)).ok) return name;
  return null;
}

async function currentBranch(top, machine) {
  const r = await git(top, ["symbolic-ref", "--quiet", "--short", "HEAD"], machine);
  return r.ok ? r.out : "";
}

export async function inspect(target, machine) {
  const repo = await repository(target, machine);
  const config = await loadConfig(repo.primary, machine);
  const branch = await currentBranch(repo.top, machine);
  const protectedBranch = Boolean(branch) && (PROTECTED_BRANCHES.includes(branch) || branch === await defaultBranch(repo.primary, machine));
  return {
    source: repo.primary, target: repo.top, branch, linked: repo.linked,
    copy_paths: config.copyPaths,
    hooks: Object.fromEntries(PHASES.map(phase => [phase, config.hooks[phase].map(command => command.name)])),
    branch_protected: protectedBranch,
  };
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
  args.push("--", "sh", job.runner, "run", jobDir(job));
  const r = await hc(args);
  if (r.code !== 0) throw new Error("Could not start the lifecycle job in herdr-core.");
}

// Validate everything before anything is created or removed.
export async function prepare(options, machine = null) {
  const paths = await runtime(machine);
  const source = await repository(options.source, machine);
  const config = await loadConfig(source.primary, machine);
  const argv = options.argv ?? null;
  if (argv !== null && (!Array.isArray(argv) || !argv.every(arg => typeof arg === "string")))
    throw new Error("The initial terminal command must be an argv array");
  const spec = { action: options.action, source: source.primary, checkout: source.top, target: options.target,
    branch: options.branch ?? "", force: Boolean(options.force), branchAction: options.branchAction ?? "keep", argv };
  if (!["create", "setup", "remove"].includes(spec.action)) throw new Error("Unknown lifecycle action");
  if (!["keep", "safe", "force"].includes(spec.branchAction)) throw new Error("Invalid branch cleanup choice");
  if (spec.action === "create") {
    if (!spec.branch || spec.branch.startsWith("-")) throw new Error("A valid branch name is required");
    const valid = await git(source.top, ["check-ref-format", "--branch", spec.branch], machine);
    if (!valid.ok) throw new Error(valid.err || "A valid branch name is required");
    const taken = await exec("sh", ["-c", 'test -e "$1" || test -L "$1"', "sh", spec.target], { on: machine });
    if (spec.target === source.primary || taken.code === 0) throw new Error("The target checkout path already exists");
  } else {
    const target = await repository(spec.target, machine);
    if (!target.linked || target.common !== source.common)
      throw new Error("Only a linked checkout of this repository can be changed");
    spec.target = target.top;
    spec.branch = await currentBranch(target.top, machine);
    if (spec.action === "remove" && spec.branchAction !== "keep") {
      if (!spec.branch || options.confirmBranch !== spec.branch)
        throw new Error("Type the exact branch name to confirm branch deletion");
      if (PROTECTED_BRANCHES.includes(spec.branch) || spec.branch === await defaultBranch(source.primary, machine))
        throw new Error("Protected branches cannot be deleted");
    }
  }
  const id = newJobId();
  const job = JSON.parse(await worker(paths, "prepare",
    [paths.stateDir, id, jobFile(spec), hooksFile(config.hooks, config.copyPaths)], machine));
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
      argv: ["sh", current.runner, "gate", jobDir(current)] });
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
      if (!job.runner?.endsWith("/worker.sh")) {
        // Started by the former Python runtime: it can no longer be tracked.
        remember({ ...job, state: "failed", retryable: false, step: "Lifecycle job stopped",
          error: "This job was started by an older version of the mod. Check its hooks before starting another operation." }, job.machine, job);
        continue;
      }
      const key = JSON.stringify([job.machine, job.runner, job.stateDir]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const values = JSON.parse(await worker(first, "status", [first.stateDir, ...group.map(job => job.id)], first.machine));
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
        if (next.revision !== current.revision || next.space !== current.space || next.space_closed !== current.space_closed)
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

// A retry uses the configuration as it is now, so a fixed hook takes effect.
export async function retry(job) {
  const config = await loadConfig(job.source, job.machine);
  const next = JSON.parse(await worker(job, "retry", [jobDir(job), hooksFile(config.hooks, config.copyPaths)], job.machine));
  remember({ ...job, ...next }, job.machine, job);
  await launch(allJobs()[job.id]);
}

export async function readLog(job) {
  return await worker(job, "logs", [jobDir(job)], job.machine);
}

// ------------------------------------------------- the scripts editor ---

export async function readScripts(folder, machine) {
  const repo = await repository(folder, machine);
  const texts = await Promise.all([SETUP_FILE, COPY_LIST].map(file => readTextFile(`${repo.primary}/${file}`, { on: machine })));
  const result = { repo, setupText: texts[0], copyText: texts[1], hooks: null, copyPaths: null, error: "" };
  try { result.hooks = parseLifecycle(texts[0]); } catch (error) { result.error = error.message; }
  try { result.copyPaths = parseCopyList(texts[1]); } catch (error) { result.error ||= error.message; }
  return result;
}

async function writeFile(path, text, expected, machine) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const made = await exec("mkdir", ["-p", dir], { on: machine });
  if (made.code !== 0) throw new Error(`Could not create ${dir}`);
  if (!machine) return writeTextFile(path, text, expected);
  if ((await readTextFile(path, { on: machine })) !== expected) throw new Error(`${path} changed since it was opened; reopen it.`);
  const r = await exec("sh", ["-c", 'printf "%s" "$2" > "$1.tmp" && mv -f "$1.tmp" "$1"', "sh", path, text], { on: machine });
  if (r.code !== 0) throw new Error(`Could not write ${path}`);
}

// Keep the personal control files out of `git status`, as the plugin did.
async function exclude(repo, files, machine) {
  await exec("sh", ["-c", 'f=$1; shift; mkdir -p "${f%/*}"; touch "$f"; for e; do grep -qxF "$e" "$f" && continue; '
    + 'if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then echo >> "$f"; fi; printf "%s\\n" "$e" >> "$f"; done',
  "sh", `${repo.common}/info/exclude`, ...files.map(file => `/${file}`)], { on: machine });
}

// Writes only what changed, refusing files edited since they were read.
export async function saveScripts(loaded, hooks, copyPaths, machine) {
  const { repo } = loaded;
  const setup = serializeLifecycle(hooks);
  const copy = serializeCopyList(copyPaths);
  const empty = PHASES.every(phase => !hooks[phase].length);
  const writes = [];
  if (setup !== loaded.setupText && !(empty && loaded.setupText == null)) writes.push([SETUP_FILE, setup, loaded.setupText]);
  const sameCopy = loaded.copyPaths && loaded.copyPaths.join("\n") === copyPaths.join("\n");
  if (!sameCopy && !(copyPaths.length === 0 && loaded.copyText == null)) writes.push([COPY_LIST, copy, loaded.copyText]);
  if (!writes.length) return 0;
  await exclude(repo, writes.map(([file]) => file), machine);
  for (const [file, text, expected] of writes) await writeFile(`${repo.primary}/${file}`, text, expected, machine);
  return writes.length;
}
