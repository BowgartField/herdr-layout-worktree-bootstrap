export const context = { store: {}, spaces: [], panes: [], calls: [], requests: [], tree: {}, response: null };
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
export const exec = async (command, args) => {
  context.requests.push([command, args]);
  return { code: 0, stdout: args.includes("-c") ? "" : JSON.stringify(typeof context.response === "function" ? context.response() : context.response) };
};
export const hc = async args => { context.requests.push(["hc", args]); return { code: 0, stdout: "{}" }; };
