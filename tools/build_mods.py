"""Apply the native UI integration to our personal copies of Herdr 0.1.12 mods."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]

def replace(path, old, new, count=1):
    text = path.read_text()
    if old not in text:
        raise RuntimeError(f"Expected upstream anchor missing: {path}: {old[:65]}")
    path.write_text(text.replace(old, new, count))


def build():
    mapping = {"worktree": "worktree-bootstrap", "spaces": "bootstrap-spaces",
        "menu": "bootstrap-menu", "new-menu": "bootstrap-new-menu", "tabs": "bootstrap-tabs",
        "workspace-chrome": "bootstrap-chrome", "pane": "bootstrap-pane"}
    for original, name in mapping.items():
        folder = ROOT / "mods" / name
        folder.mkdir(exist_ok=True)
        for source in (ROOT / "vendor/app" / original).iterdir():
            shutil.copyfile(source, folder / source.name)
        for target in folder.glob("*.js"):
            text = target.read_text()
            for old, new in mapping.items():
                text = text.replace('mod: "' + old + '"', 'mod: "' + new + '"')
            target.write_text(text)
        (folder / "mod.json").write_text('{ "place": "none" }\n')
    worktree = ROOT / "mods/worktree-bootstrap/main.js"
    replace(worktree, 'import { View, div }', 'import { View, div, svg }')
    replace(worktree, '// Where a space is now:', '''import { prepare, allJobs, remember, pollJobs, call, openGate } from "./api.js";

const pause = (cx, ms) => new Promise(resolve => cx.timer.after(ms, () => resolve()));

// Where a space is now:''')
    replace(worktree, '    this.busy = false;', '''    this.branchAction = "keep";
    this.branchConfirm = "";
    this.branchInput = InputState.new({ value: "", placeholder: "Type the exact branch name" });
    this.branchInput.on("change", (_e, cx) => { this.branchConfirm = this.branchInput.value(); cx.notify(); });
    this.branchInput.on("submit", (_e, cx) => this.go(cx));
    this.job = null;
    this.busy = false;''')
    replace(worktree, '        this.repo = repo;', '''        if (repo && !this.opening) this.details = await call("inspect", ["--target", repo.top], this.on);
        this.repo = repo;''')
    replace(worktree, 'await this.remove() : await this.create()', 'await this.remove(cx) : await this.create(cx)')
    text = worktree.read_text()
    a = text.index('  async create() {')
    b = text.index('\n  shown() {', a)
    text = text[:a] + '''  async create(cx) {
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    const path = `${ROOT(this.userHome)}/${this.repo.name}/${slug(branch)}`;
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
''' + text[b:]
    a = text.index('  async remove() {')
    b = text.index('\n  key(e, cx)', a)
    text = text[:a] + '''  async remove(cx) {
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
''' + text[b:]
    text = text.replace('    else run("space.new", { folder: c.path, machine: this.on });', '    else {\n      const pending = Object.values(allJobs()).filter(job => job.target === c.path\n        && (job.machine ?? null) === (this.on ?? null) && job.action !== "remove" && job.state !== "success")\n        .sort((a, b) => b.created - a.created)[0];\n      if (pending) openGate(pending, true);\n      else run("space.new", { folder: c.path, machine: this.on });\n    }')
    text = text.replace('    const blocked = !r || (remove && !r.linked);', '''    const blocked = !r || (remove && !r.linked);
    const job = this.job && allJobs()[this.job];
    const busy = job && (job.state === "running" || job.state === "queued");''')
    text = text.replace('      .when(Boolean(this.error),', '''      .when(!remove && Boolean(this.details), el => el.child(div().text_size(11).text_color(t.dim)
        .child(`Copies ${this.details.copy_paths.length} configured local paths · ${this.details.hooks.on_created.length} setup hooks`)))
      .when(remove && Boolean(this.details?.branch) && !this.details?.branch_protected && !this.busy, el => el
        .child(div().id("branch-cleanup-choice").py(5).text_color(t.accent)
          .on_click((_e, cx) => {
            const choices = ["keep", "safe", "force"];
            this.branchAction = choices[(choices.indexOf(this.branchAction) + 1) % choices.length];
            cx.notify();
          }).child({ keep: "Branch: keep", safe: "Branch: delete safely", force: "Branch: FORCE delete (may discard commits)" }[this.branchAction]))
        .when(this.branchAction !== "keep", row => row
          .child(div().text_size(11).text_color(t.muted).child(`Confirm branch: ${this.details.branch}`))
          .child(Input.new(this.branchInput).h(30).px(8).border(1).border_color(t.input).bg(t.background))))
      .when(Boolean(job), el => el.child(v_flex().gap(5)
        .child(h_flex().gap(8).items_center()
          .when(busy, row => row.child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.accent).spin(900)))
          .child(div().min_w(0).truncate().text_color(job.state === "failed" ? t.blocked : t.foreground)
            .child(`${job.percent == null ? "" : `${job.percent}% · `}${job.step}`)))
        .child(div().text_size(11).text_color(t.dim).child(job.phase === "before_remove" ? "Teardown runs before the checkout is removed." : "Lifecycle job continues if this dialog closes."))))
      .when(Boolean(this.error),''')
    text = text.replace('if (props()?.action === "remove") this.handle.focus();', 'if (props()?.action === "remove") this.handle.focus();')
    text = text.replace('The branch stays.`', '${this.branchAction === "keep" ? "The branch stays." : this.branchAction === "safe" ? "Deletes the branch only if Git considers it merged." : "Force-deletes the confirmed branch, including unmerged commits."}`')
    worktree.write_text(text)
    menu = ROOT / "mods/bootstrap-menu/main.js"
    replace(menu, '{ width: 440, height: 260 }', '{ width: 560, height: 420 }')
    new_menu = ROOT / "mods/bootstrap-new-menu/main.js"
    replace(new_menu, 'width: 460, height: 280', 'width: 520, height: 340')

    spaces = ROOT / "mods/bootstrap-spaces/main.js"
    replace(spaces, '// The sidebar\'s rail', '''import { jobForSpace, pollJobs, syncSetupView } from "./api.js";

// The sidebar's rail''')
    replace(spaces, '    this.git = {};', '''    this.bootstrapError = "";
    cx.timer.every(1000, cx => cx.spawn(async cx => {
      try { await pollJobs(); }
      catch (error) {
        if (this.bootstrapError !== String(error)) { this.bootstrapError = String(error); cx.notify(); }
      }
      syncSetupView();
    }));
    this.git = {};''')
    replace(spaces, '    const on = w.active;', '''    const job = jobForSpace(w);
    const loading = job && job.state !== "success";
    const busy = job && (job.state === "queued" || job.state === "running");
    const on = w.active;''')
    replace(spaces, '          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),', '''          .child(loading ? h_flex().flex_1().min_w(0).gap(5).items_center().justify_end()
            .when(busy, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.accent).spin(900)))
            .child(div().min_w(0).truncate().text_size(11).text_color(job.state === "failed" ? t.blocked : t.muted)
              .child(`${job.percent == null ? "" : `${job.percent}% · `}${job.step}`))
            : g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),''')
    replace(spaces, '    const now = Date.now();', '    syncSetupView();\n    const now = Date.now();')
    # Shared helpers must be local to each mod; the app forbids reading another mod's code.
    for directory in ROOT.joinpath("mods").iterdir():
        if directory.is_dir():
            shutil.copyfile(ROOT / "mods/api.js", directory / "api.js")


if __name__ == "__main__":
    build()
