import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeLayout, NAMES } from "../tools/build.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const install = (home, ...args) => spawnSync("sh", [path.join(ROOT, "tools/install.sh"), "--no-check", "--app-home", home, ...args], { encoding: "utf8" });

test("the layout keeps terminal geometry and other panels", () => {
  const source = { id: "root", type: "row", children: [
    { id: "sidebar", type: "block", content: { mod: "spaces" } },
    { id: "work", type: "column", children: [
      { id: "tabs", type: "block", content: { mod: "tabs" } },
      { id: "main", type: "block", content: { tab: "active", pane: { gap: 13 } } },
      { id: "files", type: "block", content: { mod: "files" } },
    ] },
  ] };
  const tree = makeLayout(source);
  assert.equal(source.children[0].content.mod, "spaces");
  assert.equal(tree.children[0].content.mod, "bootstrap-spaces");
  const stack = tree.children[1].children[1];
  assert.equal(stack.id, "bootstrap-content");
  assert.equal(stack.children[0].content.pane.gap, 13);
  assert.deepEqual(tree.children[1].children[2], source.children[1].children[2]);
  assert.throws(() => makeLayout({ type: "row", children: [] }), /active tab/);
});

test("generated files are current with src/ and runtime/worker.sh", () => {
  const worker = read("runtime/worker.sh");
  for (const name of [...Object.values(NAMES), "worktree-bootstrap-setup", "worktree-bootstrap-scripts"]) {
    assert.equal(read(`mods/${name}/api.js`), read("src/api.js"), name);
    assert.equal(read(`mods/${name}/engine.js`), read("src/engine.js"), name);
    assert.ok(read(`mods/${name}/worker.js`).includes(JSON.stringify(worker)), `${name}: run node tools/build.mjs`);
  }
  assert.deepEqual(JSON.parse(read("layouts/worktree-bootstrap.json")), makeLayout(JSON.parse(read("vendor/app/layouts/main.json"))));
});

test("install copies personal files, updates its own and refuses others' edits", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-home-"));
  try {
    fs.mkdirSync(path.join(home, "layouts"));
    fs.writeFileSync(path.join(home, "layouts/main.json"), "shipped");
    let r = install(home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(home, "layouts/main.json"), "utf8"), "shipped");
    assert.ok(fs.existsSync(path.join(home, "mods/worktree-bootstrap-scripts/main.js")));
    assert.ok(fs.existsSync(path.join(home, "layouts/worktree-bootstrap.json")));
    r = install(home);
    assert.equal(r.status, 0, r.stderr);
    const personal = path.join(home, "mods/worktree-bootstrap/main.js");
    fs.appendFileSync(personal, "\n// personal edit\n");
    r = install(home);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /independently edited/);
    assert.ok(fs.readFileSync(personal, "utf8").endsWith("// personal edit\n"));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("install never overwrites an unrelated mod with the same name", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-home-"));
  try {
    fs.mkdirSync(path.join(home, "mods/worktree-bootstrap"), { recursive: true });
    fs.writeFileSync(path.join(home, "mods/worktree-bootstrap/main.js"), "personal");
    const r = install(home);
    assert.notEqual(r.status, 0);
    assert.equal(fs.readFileSync(path.join(home, "mods/worktree-bootstrap/main.js"), "utf8"), "personal");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("install upgrades a Python-era install and removes only its unedited runtime", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wtb-home-"));
  const sha = (file) => spawnSync("shasum", ["-a", "256", file], { encoding: "utf8" }).stdout.split(" ")[0];
  try {
    const state = path.join(home, "data/worktree-bootstrap");
    fs.mkdirSync(path.join(state, "runtime/vendor"), { recursive: true });
    fs.mkdirSync(path.join(home, "mods/worktree-bootstrap"), { recursive: true });
    fs.writeFileSync(path.join(state, "runtime/runner.py"), "old runner");
    fs.writeFileSync(path.join(state, "runtime/vendor/worktree_bootstrap.py"), "old engine, edited");
    fs.writeFileSync(path.join(home, "mods/worktree-bootstrap/main.js"), "old mod");
    const files = {
      "data/worktree-bootstrap/runtime/runner.py": sha(path.join(state, "runtime/runner.py")),
      "data/worktree-bootstrap/runtime/vendor/worktree_bootstrap.py": "0".repeat(64),
      "mods/worktree-bootstrap/main.js": sha(path.join(home, "mods/worktree-bootstrap/main.js")),
    };
    fs.writeFileSync(path.join(state, "install.json"), JSON.stringify({ source: "x", layout: "worktree-bootstrap", files }, null, 2));
    const r = install(home);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(state, "runtime/runner.py")));
    assert.ok(fs.existsSync(path.join(state, "runtime/vendor/worktree_bootstrap.py")));
    assert.equal(read("mods/worktree-bootstrap/main.js"), fs.readFileSync(path.join(home, "mods/worktree-bootstrap/main.js"), "utf8"));
    assert.ok(!fs.existsSync(path.join(state, "install.json")));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
