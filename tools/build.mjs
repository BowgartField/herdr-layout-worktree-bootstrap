// Development only: regenerate mods/ and layouts/ from the Herdr 0.1.12
// baseline in vendor/app, the hand-written mods in src/ and runtime/worker.sh.
// Users never run this; they install the generated files (tools/install.sh).
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const at = (...parts) => path.join(ROOT, ...parts);
export const NAMES = { worktree: "worktree-bootstrap", spaces: "bootstrap-spaces", menu: "bootstrap-menu",
  "new-menu": "bootstrap-new-menu", tabs: "bootstrap-tabs", "workspace-chrome": "bootstrap-chrome", pane: "bootstrap-pane" };
const OWN = { setup: "worktree-bootstrap-setup", scripts: "worktree-bootstrap-scripts" };

function patch(file, old, replacement) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(old)) throw new Error(`Expected upstream anchor missing: ${file}: ${old.slice(0, 65)}`);
  fs.writeFileSync(file, text.replace(old, replacement));
}
function cut(file, from, to, replacement) {
  const text = fs.readFileSync(file, "utf8");
  const a = text.indexOf(from);
  const b = text.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`Expected upstream block missing: ${file}: ${from}`);
  fs.writeFileSync(file, text.slice(0, a) + replacement + text.slice(b));
}
const copyDir = (from, to) => {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) fs.copyFileSync(path.join(from, name), path.join(to, name));
};

// The source layout with our mods, and its active-tab block in a stack whose
// other child is the setup screen. Everything else stays as it was.
export function makeLayout(source) {
  const tree = structuredClone(source);
  let changed = false;
  const visit = (node) => {
    const content = node.content ?? {};
    if (NAMES[content.mod]) content.mod = NAMES[content.mod];
    const header = content.pane?.header?.content;
    if (header && NAMES[header.mod]) header.mod = NAMES[header.mod];
    (node.children ?? []).forEach((child, i) => {
      visit(child);
      if (child.content?.tab === "active" && !changed) {
        node.children[i] = { id: "bootstrap-content", type: "stack", active: "main", children: [
          { ...child, id: "main" },
          { id: "bootstrap-setup", type: "block", content: { mod: "worktree-bootstrap-setup" } },
        ] };
        changed = true;
      }
    });
  };
  visit(tree);
  if (!changed) throw new Error("The source layout needs a block showing the active tab");
  tree.terminal_menu = "bootstrap-menu";
  tree.cloned_from = { name: "main", version: "0.1.12" };
  return tree;
}

export function build() {
  for (const [original, name] of Object.entries(NAMES)) {
    const folder = at("mods", name);
    copyDir(at("vendor/app", original), folder);
    for (const file of fs.readdirSync(folder).filter((f) => f.endsWith(".js"))) {
      let text = fs.readFileSync(path.join(folder, file), "utf8");
      for (const [old, renamed] of Object.entries(NAMES)) text = text.replaceAll(`mod: "${old}"`, `mod: "${renamed}"`);
      fs.writeFileSync(path.join(folder, file), text);
    }
    fs.writeFileSync(path.join(folder, "mod.json"), '{ "place": "none" }\n');
  }
  for (const [source, name] of Object.entries(OWN)) copyDir(at("src", source), at("mods", name));

  const worktree = at("mods/worktree-bootstrap/main.js");
  patch(worktree, "import { View, div }", "import { View, div, svg }");
  patch(worktree, "// Where a space is now:", `import { prepare, allJobs, pollJobs, inspect, openGate } from "./api.js";

const pause = (cx, ms) => new Promise(resolve => cx.timer.after(ms, () => resolve()));

// Where a space is now:`);
  patch(worktree, "    this.busy = false;", `    this.branchAction = "keep";
    this.branchConfirm = "";
    this.branchInput = InputState.new({ value: "", placeholder: "Type the exact branch name" });
    this.branchInput.on("change", (_e, cx) => { this.branchConfirm = this.branchInput.value(); cx.notify(); });
    this.branchInput.on("submit", (_e, cx) => this.go(cx));
    this.job = null;
    this.busy = false;`);
  patch(worktree, "        this.repo = repo;", `        if (repo && !this.opening) this.details = await inspect(repo.top, this.on);
        this.repo = repo;`);
  patch(worktree, "await this.remove() : await this.create()", "await this.remove(cx) : await this.create(cx)");
  cut(worktree, "  async create() {", "\n  shown() {", `  async create(cx) {
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    const path = \`\${ROOT(this.userHome)}/\${this.repo.name}/\${slug(branch)}\`;
    const p = props();
    const initial = await prepare({ action: "create", source: this.repo.top, target: path, branch, argv: p.argv, tabName: p.tab }, this.on);
    this.job = initial.id;
    for (;;) {
      await pollJobs();
      const job = allJobs()[initial.id];
      if (job?.checkout_ready) {
        openGate(job);
        return "";
      }
      if (job?.state === "failed") return job.error || "Worktree creation failed.";
      await pause(cx, 400);
    }
  }
`);
  cut(worktree, "  async remove() {", "\n  key(e, cx)", `  async remove(cx) {
    const s = this.space();
    const status = await git(this.repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    if (!status.ok) return status.err || "git status failed.";
    const { mods, unpushed } = await submodules(this.repo.top, this.on);
    const changed = (status.out && !this.dirty) || unpushed.some(name => !this.unpushed.includes(name));
    this.dirty ||= status.out !== "";
    this.unpushed = [...new Set([...this.unpushed, ...unpushed])];
    if (changed) return "It changed since this opened. Enter again confirms the displayed changes.";
    if (this.branchAction !== "keep" && this.branchConfirm !== this.details?.branch)
      return "Type the exact branch name to confirm branch deletion.";
    const initial = await prepare({ action: "remove", source: this.repo.main, target: this.repo.top,
      force: this.dirty || mods.length > 0, space: s.id,
      branchAction: this.branchAction, confirmBranch: this.branchConfirm }, this.on);
    this.job = initial.id;
    for (;;) {
      await pollJobs();
      const job = allJobs()[initial.id];
      if (job?.state === "success") return "";
      if (job?.state === "failed") return job.error || "Teardown failed; the checkout was kept unless removal already completed.";
      await pause(cx, 400);
    }
  }
`);
  patch(worktree, '    else run("space.new", { folder: c.path, machine: this.on });', `    else {
      const pending = Object.values(allJobs()).filter(job => job.target === c.path
        && (job.machine ?? null) === (this.on ?? null) && job.action !== "remove" && job.state !== "success")
        .sort((a, b) => b.created - a.created)[0];
      if (pending) openGate(pending, true);
      else run("space.new", { folder: c.path, machine: this.on });
    }`);
  patch(worktree, "    const blocked = !r || (remove && !r.linked);", `    const blocked = !r || (remove && !r.linked);
    const job = this.job && allJobs()[this.job];
    const busy = job && (job.state === "running" || job.state === "queued");`);
  patch(worktree, "      .when(Boolean(this.error),", `      .when(!remove && Boolean(this.details), el => el.child(div().text_size(11).text_color(t.dim)
        .child(\`Copies \${this.details.copy_paths.length} configured local paths · \${this.details.hooks.on_created.length} setup hooks\`)))
      .when(remove && Boolean(this.details?.branch) && !this.details?.branch_protected && !this.busy, el => el
        .child(div().id("branch-cleanup-choice").py(5).text_color(t.accent)
          .on_click((_e, cx) => {
            const choices = ["keep", "safe", "force"];
            this.branchAction = choices[(choices.indexOf(this.branchAction) + 1) % choices.length];
            cx.notify();
          }).child({ keep: "Branch: keep", safe: "Branch: delete safely", force: "Branch: FORCE delete (may discard commits)" }[this.branchAction]))
        .when(this.branchAction !== "keep", row => row
          .child(div().text_size(11).text_color(t.muted).child(\`Confirm branch: \${this.details.branch}\`))
          .child(Input.new(this.branchInput).h(30).px(8).border(1).border_color(t.input).bg(t.background))))
      .when(Boolean(job), el => el.child(v_flex().gap(5)
        .child(h_flex().gap(8).items_center()
          .when(busy, row => row.child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.accent).spin(900)))
          .child(div().min_w(0).truncate().text_color(job.state === "failed" ? t.blocked : t.foreground)
            .child(\`\${job.percent == null ? "" : \`\${job.percent}% · \`}\${job.step}\`)))
        .child(div().text_size(11).text_color(t.dim).child(job.phase === "before_remove" ? "Teardown runs before the checkout is removed." : "Lifecycle job continues if this dialog closes."))))
      .when(Boolean(this.error),`);
  patch(worktree, "The branch stays.`", '${this.branchAction === "keep" ? "The branch stays." : this.branchAction === "safe" ? "Deletes the branch only if Git considers it merged." : "Force-deletes the confirmed branch, including unmerged commits."}`');

  const menu = at("mods/bootstrap-menu/main.js");
  patch(menu, "{ width: 440, height: 260 }", "{ width: 560, height: 420 }");
  // The scripts editor belongs to a repository's main checkout only.
  patch(menu, '        ...(git === "linked" ?', `        ...(git === "main" ? [["Worktree scripts…", "worktree-scripts", { space: tg.id }]] : []),
        ...(git === "linked" ?`);
  patch(menu, '    if (it[1] === "worktree")', `    if (it[1] === "worktree-scripts") openOverlay({ mod: "worktree-bootstrap-scripts", kind: "dialog", width: 760, height: 640, props: it[2] });
    else if (it[1] === "worktree")`);
  patch(menu, ': command === "worktree" ? "git-branch"', ': command === "worktree" ? "git-branch" : command === "worktree-scripts" ? "file-text"');
  patch(menu, 'it[1] === "app.help" ||', 'it[1] === "app.help" || it[1] === "worktree-scripts" ||');
  // Other mods add space-menu entries that open their dialog, without patching this menu:
  // data/menu-items/<name>.json = { "space": [{ label, mod, width?, height?, icon? }] }.
  patch(menu, ', exec } from "herdr";', `, exec, appHome } from "herdr";
import * as fs from "fs/promises";`);
  patch(menu, "function items(p, git) {", `// Entries other mods register in data/menu-items/*.json for this kind of menu.
async function menuExtensions(tab) {
  const dir = \`\${appHome()}/data/menu-items\`;
  const names = await fs.readdir(dir).catch(() => []);
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const spec = JSON.parse(await fs.readFile(\`\${dir}/\${name}\`, "utf8"));
      for (const x of spec?.[tab] ?? []) if (x?.label && x?.mod) out.push(x);
    } catch { /* a broken extension file is skipped */ }
  }
  return out;
}

function items(p, git, extra = []) {`);
  patch(menu, '        ["Close", "space.close", { id: tg.id }],', `        ...extra.map((x) => [x.label, \`mod:\${x.mod}\`, { space: tg.id }, x]),
        ["Close", "space.close", { id: tg.id }],`);
  patch(menu, "    const folder = space && place(space);", `    const folder = space && place(space);
    this.extra = [];
    if (space)
      cx.spawn(async (cx) => {
        this.extra = await menuExtensions("space").catch(() => []);
        cx.notify();
      });`);
  patch(menu, "const it = items(props(), this.git)[i];", "const it = items(props(), this.git, this.extra)[i];");
  patch(menu, "const list = items(props(), this.git);", "const list = items(props(), this.git, this.extra);");
  patch(menu, '    if (it[1] === "worktree-scripts")', `    if (it[1].startsWith("mod:")) openOverlay({ mod: it[3].mod, kind: "dialog", width: it[3].width ?? 720, height: it[3].height ?? 560, props: it[2] });
    else if (it[1] === "worktree-scripts")`);
  patch(menu, ".child(svg(menuIcon(it[1]))", ".child(svg(it[3]?.icon ? `mods/workspace-chrome/${it[3].icon}.svg` : menuIcon(it[1]))");
  patch(menu, 'it[1] === "worktree-scripts" || (it[1] === "app.theme"', 'it[1] === "worktree-scripts" || (it[1].startsWith("mod:") && !list[i - 1][1].startsWith("mod:") && list[i - 1][1] !== "worktree-scripts") || (it[1] === "app.theme"');

  patch(at("mods/bootstrap-new-menu/main.js"), "width: 460, height: 280", "width: 520, height: 340");

  const spaces = at("mods/bootstrap-spaces/main.js");
  patch(spaces, "// The sidebar's rail", `import { jobForSpace, pollJobs, syncSetupView } from "./api.js";

// The sidebar's rail`);
  patch(spaces, "    this.git = {};", `    this.bootstrapError = "";
    cx.timer.every(1000, cx => cx.spawn(async cx => {
      try { await pollJobs(); }
      catch (error) {
        if (this.bootstrapError !== String(error)) { this.bootstrapError = String(error); cx.notify(); }
      }
      syncSetupView();
    }));
    this.git = {};`);
  patch(spaces, "    const on = w.active;", `    const job = jobForSpace(w);
    const loading = job && job.state !== "success";
    const busy = job && (job.state === "queued" || job.state === "running");
    const on = w.active;`);
  patch(spaces, "          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),", `          .child(loading ? h_flex().flex_1().min_w(0).gap(5).items_center().justify_end()
            .when(busy, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.accent).spin(900)))
            .child(div().min_w(0).truncate().text_size(11).text_color(job.state === "failed" ? t.blocked : t.muted)
              .child(\`\${job.percent == null ? "" : \`\${job.percent}% · \`}\${job.step}\`))
            : g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),`);
  patch(spaces, "    const now = Date.now();", "    syncSetupView();\n    const now = Date.now();");

  // A mod may not import another mod's code: each gets its own copy.
  const worker = `// Generated from runtime/worker.sh by tools/build.mjs; do not edit.\nexport const WORKER_SOURCE = ${JSON.stringify(fs.readFileSync(at("runtime/worker.sh"), "utf8"))};\n`;
  for (const name of [...Object.values(NAMES), ...Object.values(OWN)]) {
    fs.copyFileSync(at("src/api.js"), at("mods", name, "api.js"));
    fs.copyFileSync(at("src/engine.js"), at("mods", name, "engine.js"));
    fs.writeFileSync(at("mods", name, "worker.js"), worker);
  }

  fs.mkdirSync(at("layouts"), { recursive: true });
  const layout = makeLayout(JSON.parse(fs.readFileSync(at("vendor/app/layouts/main.json"), "utf8")));
  fs.writeFileSync(at("layouts/worktree-bootstrap.json"), JSON.stringify(layout, null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) build();
