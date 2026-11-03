// A stand-in for the app's "herdr" module: records commands and answers
// exec() the way Git and the worker would for a repository at /repo.
export const context = {};
export function reset() {
  Object.assign(context, { store: {}, spaces: [], panes: [], calls: [], requests: [], tree: {}, response: null,
    files: {}, writes: [], git: null });
}
reset();

export const appHome = () => "/fixture/app";
export const shared = key => context.store[key];
export const setShared = (key, value) => { context.store[key] = value; };
export const spaces = () => context.spaces;
export const panes = () => context.panes;
export const layout = () => context.tree;
export const notify = value => context.calls.push(["notify", value]);
export function run(command, args) {
  context.calls.push([command, args]);
  if (command === "layout.select") context.tree.active = args.child;
}
export const readTextFile = async path => context.files[path] ?? null;
export const writeTextFile = async (path, text, expected) => {
  if ((context.files[path] ?? null) !== expected) throw new Error("stale");
  context.writes.push(path);
  context.files[path] = text;
  return null;
};

function git(args, cwd) {
  const custom = context.git?.(args, cwd);
  if (custom) return custom;
  const ok = stdout => ({ code: 0, stdout, stderr: "" });
  const key = args.join(" ");
  if (key === "rev-parse --show-toplevel") return ok(cwd);
  if (key === "rev-parse --path-format=absolute --git-common-dir") return ok("/repo/.git");
  if (key === "worktree list --porcelain") return ok("worktree /repo\nHEAD 1\nbranch refs/heads/main\n\nworktree /repo/feature\nHEAD 2\nbranch refs/heads/feature\n");
  if (args[0] === "check-ref-format") return ok(args[2]);
  if (key === "symbolic-ref --quiet --short HEAD") return ok(cwd === "/repo" ? "main" : "feature");
  if (key.startsWith("show-ref --verify --quiet refs/heads/main")) return ok("");
  return { code: 1, stdout: "", stderr: "" };
}

export const exec = async (command, args = [], options = {}) => {
  context.requests.push([command, args, options]);
  if (command === "git") return git(args, options.cwd);
  if (command === "sh" && args[0] === "-c") {
    if (args[1].startsWith("test -e")) return { code: context.files[args[3]] != null ? 0 : 1, stdout: "", stderr: "" };
    return { code: 0, stdout: args[1].includes("$HOME") ? "/home/remote" : "", stderr: "" };
  }
  if (command === "sh") {
    const value = typeof context.response === "function" ? context.response(args) : context.response;
    if (value instanceof Error) return { code: 1, stdout: "", stderr: value.message };
    return { code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};
export const hc = async args => { context.requests.push(["hc", args]); return { code: 0, stdout: "{}" }; };
