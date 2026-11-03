// Worktree scripts: edit a repository's lifecycle hooks and copy list.
// Opened as a dialog from a main checkout's space menu with props { space }.
// Saves .herdr/worktree-setup.json and .herdr/worktree-copy.list in the
// primary checkout. Commands are typed like in a terminal and stored as argv:
// they are never run through a shell.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { props, closeOverlay, theme, spaces, notify, settings } from "herdr";
import { place, readScripts, saveScripts } from "./api.js";
import { PHASES, DEFAULT_TIMEOUT, splitCommandLine, formatCommandLine, validateCopyPaths } from "./engine.js";

const SECTIONS = {
  on_created: ["When a worktree is created", "Runs in the new worktree, after the files below are copied."],
  before_remove: ["Before a worktree is removed", "Runs in the worktree. A failure keeps it."],
  after_remove: ["After a worktree is removed", "Runs in the main checkout."],
};

export default class Scripts extends View {
  init(_props, cx) {
    this.space = spaces().find((s) => s.id === props()?.space);
    this.machine = this.space?.machine ?? null;
    this.loaded = null;
    this.rows = Object.fromEntries(PHASES.map((phase) => [phase, []]));
    this.copy = TextareaState.new({ placeholder: ".env\n.env.local", rows: 4 });
    this.error = "";
    this.notice = "";
    this.busy = false;
    this.next = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        const folder = place(this.space);
        if (!folder) throw new Error("This space has no folder.");
        this.loaded = await readScripts(folder, this.machine);
        if (this.loaded.repo.linked) throw new Error("Open this from the repository's main checkout.");
        for (const phase of PHASES) for (const command of this.loaded.hooks?.[phase] ?? []) this.add(phase, command);
        this.copy.set_value((this.loaded.copyPaths ?? []).join("\n"));
        if (this.loaded.error) this.notice = `The current file can't be read (${this.loaded.error}). Saving replaces it.`;
      } catch (error) { this.error = error.message ?? String(error); }
      cx.notify();
    });
  }

  add(phase, command = null) {
    const row = {
      id: this.next++,
      name: InputState.new({ placeholder: "Name", value: command?.name ?? "" }),
      line: InputState.new({ placeholder: "npm ci", value: command ? formatCommandLine(command.argv) : "" }),
      timeout: InputState.new({ placeholder: String(DEFAULT_TIMEOUT), value: String(command?.timeout_seconds ?? DEFAULT_TIMEOUT) }),
    };
    this.rows[phase].push(row);
    return row;
  }

  // The form as configuration; throws with where the problem is.
  collect() {
    const hooks = {};
    for (const phase of PHASES) {
      hooks[phase] = [];
      this.rows[phase].forEach((row, i) => {
        const where = `${SECTIONS[phase][0]}, command ${i + 1}`;
        const line = row.line.value().trim();
        const name = row.name.value().trim();
        if (!line && !name) return;
        let argv;
        try { argv = splitCommandLine(line); } catch (error) { throw new Error(`${where}: ${error.message}`); }
        const text = row.timeout.value().trim();
        const timeout = text === "" ? DEFAULT_TIMEOUT : Number(text);
        if (!/^\d+$/.test(text || "0") || !Number.isInteger(timeout) || timeout <= 0)
          throw new Error(`${where}: the timeout is a whole number of seconds`);
        hooks[phase].push({ name: name || argv[0].split("/").pop(), argv, timeout_seconds: timeout });
      });
    }
    const paths = this.copy.value().split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    try { validateCopyPaths(paths); } catch (error) { throw new Error(`Files to copy: ${error.message}`); }
    return { hooks, paths };
  }

  save(cx) {
    if (this.busy || !this.loaded || this.loaded.repo.linked) return;
    let form;
    try { form = this.collect(); } catch (error) { this.error = error.message; cx.notify(); return; }
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const written = await saveScripts(this.loaded, form.hooks, form.paths, this.machine);
        if (written) notify({ title: "Worktree scripts saved", body: this.loaded.repo.primary, level: "success" });
        closeOverlay(props().overlay);
      } catch (error) { this.error = error.message ?? String(error); }
      this.busy = false;
      cx.notify();
    });
  }

  input(state, t) {
    return Input.new(state).h(30).px(8).items_center().rounded(6).border(1).border_color(t.input)
      .bg(t.background).text_color(t.foreground);
  }

  icon(id, name, t, action) {
    return div().id(id).flex_none().p(5).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(action).child(svg(`mods/worktree-bootstrap-scripts/${name}.svg`).size(13).text_color(t.muted));
  }

  section(phase, t) {
    const [title, hint] = SECTIONS[phase];
    const rows = this.rows[phase];
    return v_flex().gap(6)
      .child(v_flex().gap(1)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11.5).text_color(t.dim).child(hint)))
      .when(rows.length > 0, (el) => el.child(h_flex().gap(6).text_size(11).text_color(t.dim)
        .child(div().w(150).flex_none().child("Name"))
        .child(div().flex_1().child("Command"))
        .child(div().w(108).flex_none().child("Timeout (s)"))))
      .children(rows.map((row, i) => h_flex().id(`row-${phase}-${row.id}`).gap(6).items_center()
        .child(this.input(row.name, t).w(150).flex_none())
        .child(this.input(row.line, t).flex_1().min_w(0).font_family(settings().font_family))
        .child(this.input(row.timeout, t).w(60).flex_none())
        .child(i > 0 ? this.icon(`up-${phase}-${row.id}`, "chevron-up", t, (_e, cx) => {
          [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
          cx.notify();
        }) : div().w(23).flex_none())
        .child(this.icon(`rm-${phase}-${row.id}`, "x", t, (_e, cx) => {
          rows.splice(i, 1);
          cx.notify();
        }))))
      .child(h_flex().id(`add-${phase}`).gap(6).items_center().py(3).text_size(12).text_color(t.accent)
        .cursor_pointer().on_click((_e, cx) => { this.add(phase).line.focus(); cx.notify(); })
        .child(svg("mods/worktree-bootstrap-scripts/plus.svg").size(12).text_color(t.accent))
        .child("Add command"));
  }

  button(id, label, t, primary, action) {
    return div().id(id).px(14).py(6).rounded(6).cursor_pointer().text_size(12.5)
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.border(1).border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(action).child(label);
  }

  render(cx) {
    const t = theme();
    const repo = this.loaded?.repo;
    const ready = repo && !repo.linked;
    return v_flex().id("worktree-scripts").track_focus(this.handle).size_full().bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "s" && (e.modifiers.platform || e.modifiers.control)) { this.save(cx); cx.stop_propagation(); }
        else if (e.key === "escape") closeOverlay(props().overlay);
      })
      .child(v_flex().gap(3).px(18).pt(16).pb(10)
        .child(div().font_semibold().text_color(t.foreground)
          .child(`Worktree scripts${repo ? ` · ${repo.primary.split("/").pop()}` : ""}`))
        .child(div().text_size(11.5).text_color(t.dim).truncate()
          .child(repo ? `${repo.primary}/.herdr/` : "Reading the repository…")))
      .child(div().h(1).bg(t.border))
      .child(v_flex().id("scripts-body").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).gap(18)
        .when(Boolean(this.notice), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.notice)))
        .when(Boolean(ready), (el) => el
          .children(PHASES.map((phase) => this.section(phase, t)))
          .child(v_flex().gap(6)
            .child(v_flex().gap(1)
              .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("Files to copy into new worktrees"))
              .child(div().text_size(11.5).text_color(t.dim)
                .child("One path per line, relative to the repository. Only Git-ignored files are copied; tracked files are never overwritten.")))
            .child(Textarea.new(this.copy).h(92).p(8).rounded(6).border(1).border_color(t.input)
              .bg(t.background).text_color(t.foreground).font_family(settings().font_family))))
        .child(div().text_size(11.5).text_color(t.dim)
          .child("Commands run directly, not in a shell: quotes group words, and $VARS, globs and pipes stay literal. For shell syntax, use sh -c '…'.")))
      .child(div().h(1).bg(t.border))
      .child(h_flex().px(18).py(12).gap(10).items_center()
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.blocked).child(this.error))
        .child(this.button("scripts-cancel", "Cancel", t, false, () => closeOverlay(props().overlay)))
        .when(Boolean(ready), (el) => el.child(this.button("scripts-save", this.busy ? "Saving…" : "Save", t, true, (_e, cx) => this.save(cx)))));
  }
}
