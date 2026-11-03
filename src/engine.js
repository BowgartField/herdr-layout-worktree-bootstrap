// Worktree lifecycle configuration: reading, validating and writing
// `.herdr/worktree-setup.json` and `.herdr/worktree-copy.list`, and turning
// them into the files the sh worker runs. Pure functions, no Herdr calls.
//
// The validation rules are ported from zerodice0/herdr-plugin-worktree-bootstrap
// (MIT); see NOTICE.

export const SETUP_FILE = ".herdr/worktree-setup.json";
export const COPY_LIST = ".herdr/worktree-copy.list";
export const PHASES = ["on_created", "before_remove", "after_remove"];
export const PROTECTED_BRANCHES = ["main", "master", "develop", "development", "trunk"];
export const DEFAULT_TIMEOUT = 600;

export class ConfigError extends Error {}
const fail = (message) => { throw new ConfigError(message); };
const emptyHooks = () => Object.fromEntries(PHASES.map((phase) => [phase, []]));

function parseCommands(raw, label) {
  if (!Array.isArray(raw)) fail(`${label} commands must be an array`);
  return raw.map((command, index) => {
    const where = `${label} command ${index + 1}`;
    const keys = command && typeof command === "object" && !Array.isArray(command) ? Object.keys(command).sort() : [];
    if (keys.join() !== "argv,name,timeout_seconds") fail(`${where} must contain only name, argv, and timeout_seconds`);
    const { name, argv, timeout_seconds: timeout } = command;
    if (typeof name !== "string" || !name.trim()) fail(`${where} name must be a non-empty string`);
    if (!Array.isArray(argv) || !argv.length || !argv.every((arg) => typeof arg === "string"))
      fail(`${where} argv must be a non-empty array of strings`);
    if (!argv[0]) fail(`${where} executable cannot be empty`);
    if (argv.some((arg) => arg.includes("\0"))) fail(`${where} argv cannot contain NUL bytes`);
    if (!Number.isInteger(timeout) || timeout <= 0) fail(`${where} timeout_seconds must be a positive integer`);
    return { name: name.trim(), argv: [...argv], timeout_seconds: timeout };
  });
}

// Version 1 ({commands}) and version 2 ({hooks}) files; null text is no file.
export function parseLifecycle(text) {
  if (text == null) return emptyHooks();
  let doc;
  try { doc = JSON.parse(text); } catch (error) { fail(`${SETUP_FILE} is invalid JSON: ${error.message}`); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail(`${SETUP_FILE} must contain a JSON object`);
  const keys = Object.keys(doc).sort().join();
  if (doc.version === 1) {
    if (keys !== "commands,version") fail(`${SETUP_FILE} must contain only 'version' and 'commands'`);
    return { ...emptyHooks(), on_created: parseCommands(doc.commands, SETUP_FILE) };
  }
  if (doc.version !== 2) fail(`${SETUP_FILE} version must be 1 or 2`);
  if (keys !== "hooks,version" || !doc.hooks || typeof doc.hooks !== "object" || Array.isArray(doc.hooks))
    fail(`${SETUP_FILE} version 2 must contain only 'version' and 'hooks'`);
  const unknown = Object.keys(doc.hooks).filter((phase) => !PHASES.includes(phase)).sort()[0];
  if (unknown) fail(`${SETUP_FILE} has unknown lifecycle hook: ${unknown}`);
  return Object.fromEntries(PHASES.map((phase) => [phase, parseCommands(doc.hooks[phase] ?? [], `${SETUP_FILE} ${phase}`)]));
}

export function serializeLifecycle(hooks) {
  const clean = Object.fromEntries(PHASES.map((phase) => [phase, parseCommands(hooks[phase] ?? [], phase)]));
  return JSON.stringify({ version: 2, hooks: clean }, null, 2) + "\n";
}

export function validateRelativePath(value) {
  if (typeof value !== "string") fail("copy-list paths must be strings");
  if (!value) fail("copy-list paths cannot be empty");
  if (value.includes("\0")) fail("copy-list paths cannot contain NUL bytes");
  if (/[\r\n]/.test(value)) fail("copy-list paths cannot contain line breaks");
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) fail(`absolute path is not allowed: ${value}`);
  if (value.split("/").some((part) => part === "." || part === ".." || part === ""))
    fail(`ambiguous or escaping path is not allowed: ${value}`);
  return value;
}

export function validateCopyPaths(paths) {
  const seen = new Set();
  for (const path of paths) {
    validateRelativePath(path);
    if (seen.has(path)) fail(`duplicate copy-list path: ${path}`);
    seen.add(path);
  }
  const list = [...seen];
  for (const a of list) for (const b of list)
    if (a !== b && b.startsWith(a + "/")) fail(`overlapping copy-list paths are not allowed: ${a} and ${b}`);
  return list;
}

export function parseCopyList(text) {
  if (text == null) return [];
  const values = [];
  text.split(/\r\n|\n|\r/).forEach((raw, index) => {
    let value = raw.trim();
    if (index === 0) value = value.replace(/^\ufeff/, "");
    if (!value || value.startsWith("#")) return;
    try { values.push(validateRelativePath(value)); }
    catch (error) { fail(`${COPY_LIST}:${index + 1}: ${error.message}`); }
  });
  return validateCopyPaths(values);
}

export function serializeCopyList(paths) {
  const list = validateCopyPaths(paths);
  return "# Local ignored paths copied into new worktrees.\n" + list.map((path) => path + "\n").join("");
}

// A command typed like in a terminal, split into argv without expanding
// anything: quotes and backslashes group words, $VAR and globs stay literal.
export function splitCommandLine(line) {
  const argv = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null; else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1])) word += line[++i];
      else word += c;
    } else if (/\s/.test(c)) {
      if (word !== null) { argv.push(word); word = null; }
    } else if (c === "'" || c === '"') {
      quote = c; word ??= "";
    } else if (c === "\\") {
      if (i + 1 >= line.length) fail("the command ends with a lone backslash");
      word = (word ?? "") + line[++i];
    } else word = (word ?? "") + c;
  }
  if (quote) fail("the command has an unclosed quote");
  if (word !== null) argv.push(word);
  if (!argv.length || !argv[0]) fail("type a command, starting with the program to run");
  return argv;
}

export function formatCommandLine(argv) {
  return argv.map((arg) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`).join(" ");
}

// sh single quoting: the worker sources these files, nothing expands.
export function sq(value) {
  const text = String(value);
  if (text.includes("\0")) fail("values cannot contain NUL bytes");
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// The job's fixed identity, as sh assignments.
export function jobFile({ action, source, checkout, target, branch = "", base = "HEAD", force = false, branchAction = "keep", argv = null }) {
  const lines = [
    `action=${sq(action)}`, `source=${sq(source)}`, `checkout=${sq(checkout ?? source)}`,
    `target=${sq(target)}`, `branch=${sq(branch)}`, `base=${sq(base)}`,
    `force=${force ? 1 : 0}`, `branch_action=${sq(branchAction)}`,
  ];
  if (argv?.length) lines.push(`terminal_command() { exec ${argv.map(sq).join(" ")}; }`);
  return lines.join("\n");
}

// The copy list and hooks, regenerated when a failed job is retried.
export function hooksFile(hooks, copyPaths) {
  const lines = [`copy_count=${copyPaths.length}`];
  copyPaths.forEach((path, i) => lines.push(`copy_${i + 1}=${sq(validateRelativePath(path))}`));
  for (const phase of PHASES) {
    const commands = hooks[phase] ?? [];
    lines.push(`hook_${phase}_count=${commands.length}`);
    commands.forEach((command, i) => lines.push(
      `hook_${phase}_${i + 1}() { run_hook ${sq(command.name)} ${Number(command.timeout_seconds)} ${command.argv.map(sq).join(" ")}; }`));
  }
  return lines.join("\n");
}

export function newJobId() {
  let id = "";
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}
