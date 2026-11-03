import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLifecycle, serializeLifecycle, parseCopyList, serializeCopyList, validateCopyPaths,
  splitCommandLine, formatCommandLine, sq, hooksFile, jobFile, newJobId,
} from "../src/engine.js";

const command = { name: "Install", argv: ["npm", "ci"], timeout_seconds: 900 };

test("reads version 1 and 2 files, and no file as no hooks", () => {
  assert.deepEqual(parseLifecycle(null).on_created, []);
  assert.deepEqual(parseLifecycle(JSON.stringify({ version: 1, commands: [command] })).on_created, [command]);
  const v2 = parseLifecycle(JSON.stringify({ version: 2, hooks: { before_remove: [command] } }));
  assert.deepEqual(v2.before_remove, [command]);
  assert.deepEqual(v2.after_remove, []);
  assert.deepEqual(parseLifecycle(serializeLifecycle(v2)), v2);
});

test("rejects malformed lifecycle files with a precise reason", () => {
  const bad = (doc, pattern) => assert.throws(() => parseLifecycle(typeof doc === "string" ? doc : JSON.stringify(doc)), pattern);
  bad("{", /invalid JSON/);
  bad([], /JSON object/);
  bad({ version: 3, hooks: {} }, /version must be 1 or 2/);
  bad({ version: true, hooks: {} }, /version must be 1 or 2/);
  bad({ version: 2, hooks: {}, extra: 1 }, /only 'version' and 'hooks'/);
  bad({ version: 2, hooks: { on_destroy: [] } }, /unknown lifecycle hook: on_destroy/);
  bad({ version: 2, hooks: { on_created: [{ ...command, shell: true }] } }, /only name, argv, and timeout_seconds/);
  bad({ version: 2, hooks: { on_created: [{ ...command, argv: "npm ci" }] } }, /argv must be a non-empty array/);
  bad({ version: 2, hooks: { on_created: [{ ...command, argv: [""] }] } }, /executable cannot be empty/);
  bad({ version: 2, hooks: { on_created: [{ ...command, timeout_seconds: 1.5 }] } }, /positive integer/);
  bad({ version: 2, hooks: { on_created: [{ ...command, name: " " }] } }, /non-empty string/);
});

test("copy list: comments, BOM and blank lines are skipped; unsafe paths are refused", () => {
  assert.deepEqual(parseCopyList("﻿# local\n\n.env\n  config/local.json  \n"), [".env", "config/local.json"]);
  for (const [text, pattern] of [["/etc/passwd", /absolute/], ["../x", /escaping/], ["a/./b", /escaping/], ["a//b", /escaping/],
    [".env\n.env", /duplicate/], ["config\nconfig/local.json", /overlapping/]])
    assert.throws(() => parseCopyList(text), pattern);
  assert.throws(() => validateCopyPaths(["a\nb"]), /line breaks/);
  assert.deepEqual(parseCopyList(serializeCopyList([".env", "a b"])), [".env", "a b"]);
});

test("command lines split like a shell would group words, without expanding anything", () => {
  assert.deepEqual(splitCommandLine("npm ci"), ["npm", "ci"]);
  assert.deepEqual(splitCommandLine(`sh -c 'echo "$HOME" | wc'`), ["sh", "-c", 'echo "$HOME" | wc']);
  assert.deepEqual(splitCommandLine(`echo "a \\"b\\" \\$c" d\\ e '' $X *`), ["echo", 'a "b" $c', "d e", "", "$X", "*"]);
  assert.throws(() => splitCommandLine("echo 'open"), /unclosed quote/);
  assert.throws(() => splitCommandLine("   "), /type a command/);
  assert.throws(() => splitCommandLine("''"), /type a command/);
  for (const argv of [["npm", "ci"], ["sh", "-c", "it's $HOME | x"], ["a b", "", "*", "`id`", "--x=y"]])
    assert.deepEqual(splitCommandLine(formatCommandLine(argv)), argv);
});

test("generated sh files quote every value", () => {
  assert.equal(sq("it's"), `'it'\\''s'`);
  assert.throws(() => sq("a\0b"), /NUL/);
  const hooks = hooksFile({ on_created: [{ name: "Say 'hi'", argv: ["echo", "$(id)"], timeout_seconds: 5 }] }, [".env"]);
  assert.match(hooks, /^copy_1='\.env'$/m);
  assert.match(hooks, /run_hook 'Say '\\''hi'\\''' 5 'echo' '\$\(id\)'/);
  assert.match(hooks, /^hook_after_remove_count=0$/m);
  assert.doesNotMatch(jobFile({ action: "setup", source: "/r", target: "/t" }), /terminal_command/);
  assert.match(newJobId(), /^[0-9a-f]{32}$/);
});
