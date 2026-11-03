import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay } from "herdr";
import { setupJob, allJobs, retry, readLog } from "./api.js";

export default class Setup extends View {
  init(_props, cx) {
    this.error = "";
    this.retrying = false;
    this.handle = cx.focus_handle();
    if (props()?.log) {
      const job = allJobs()[props().log];
      cx.spawn(async cx => {
        try { this.log = await readLog(job); } catch (error) { this.error = String(error); }
        cx.notify();
      });
    }
  }
  render(cx) {
    const t = theme();
    if (props()?.log) return v_flex().size_full().p(20).gap(10).bg(t.popover)
      .child(h_flex().justify_between().child("Worktree lifecycle log")
        .child(div().id("close-log").on_click(() => closeOverlay(props().overlay)).child("Close")))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().text_size(12).child(this.error || this.log || "Reading log…"));
    const job = setupJob();
    if (!job) return div().size_full().bg(t.background);
    const failed = job.state === "failed";
    const button = (id, label, action) => div().id(id).px(12).py(7).rounded(6)
      .border(1).border_color(t.border).hover(el => el.bg(t.hover)).on_click(action).child(label);
    return v_flex().size_full().bg(t.background).items_center().justify_center().gap(12)
      .id("worktree-setup").track_focus(this.handle)
      .on_click(() => this.handle.focus())
      .on_key_down((event, cx) => {
        // Keep application navigation shortcuts; ordinary text belongs to this panel.
        if (!event.modifiers.platform && !event.modifiers.control && !event.modifiers.alt) cx.stop_propagation();
      })
      .when(!failed, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(24).text_color(t.accent).spin(900)))
      .child(div().text_size(18).font_semibold().text_color(failed ? t.blocked : t.foreground)
        .child(failed ? "Worktree setup failed" : "Setup worktree…"))
      .child(div().max_w(580).px(16).text_size(13).text_color(t.muted).truncate()
        .child(failed ? job.error : `${job.percent == null ? "" : `${job.percent}% · `}${job.step}`))
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)))
      .child(h_flex().gap(10).text_size(12)
        .when(failed && job.retryable !== false, el => el.child(button("retry-setup", this.retrying ? "Retrying…" : "Retry setup", (_e, cx) => {
          if (this.retrying) return;
          this.retrying = true;
          cx.spawn(async cx => {
            try { await retry(job); this.error = ""; } catch (error) { this.error = String(error); }
            this.retrying = false; cx.notify();
          });
        })))
        .child(button("setup-log", "View log", () => openOverlay({ mod: "worktree-bootstrap-setup", kind: "dialog", width: 760, height: 520, props: { log: job.id } }))));
  }
}
