import { app, type ModelStatus } from "../app.ts";
import { ASR_MODELS } from "../models.ts";
import { SAMPLE_RATE, type Session } from "../store.ts";
import { formatClock, sessionDayGroup, sessionTime, sessionTitle } from "../transcript.ts";
import { h, icon } from "./dom.ts";
import { showPane } from "./layout.ts";

const MB = 1024 * 1024;
/** Levels arrive about 10 times a second, so the waveform shows about 3 seconds. */
const WAVE_BARS = 32;

interface Region {
  element: HTMLElement;
  /** Brings the region in line with app.state, touching only what differs. */
  update(): void;
}

/** Maps an RMS level to 0..1 over -60 dB..0 dB. */
function levelOf(rms: number): number {
  if (rms <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60));
}

function setText(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

/** Shown under the switch while it is on, so Chrome's share picker is expected and answered right. */
const SHARE_HINT =
  "Recording opens Chrome's share picker. For a meeting app like Zoom, pick its window or the entire screen; for a meeting in a tab, pick the tab. Then check that the audio switch at the bottom is on.";

/** The card shows one switch and the top of the list shows the other. CSS shows one of them per layout. */
function computerAudioSwitch(placement: "switch-row-card" | "switch-row-list"): Region {
  const hint = h("span", { className: "switch-hint muted", textContent: SHARE_HINT, hidden: true });
  const element = h(
    "button",
    {
      type: "button",
      className: `switch-row ${placement}`,
      role: "switch",
      onclick: () => app.setIncludeComputerAudio(!app.state.includeComputerAudio),
    },
    h("span", { className: "switch-label" }, "Also record computer audio", hint),
    h("span", { className: "switch-track" }, h("span", { className: "switch-thumb" })),
  );

  return {
    element,
    update() {
      const { canShareAudio, includeComputerAudio, recording } = app.state;
      element.hidden = !canShareAudio;
      const checked = String(includeComputerAudio);
      if (element.ariaChecked !== checked) element.ariaChecked = checked;
      element.disabled = recording !== null;
      hint.hidden = !includeComputerAudio || recording !== null;
    },
  };
}

function recorder(): Region {
  const button = h(
    "button",
    { type: "button", className: "record-btn", onclick: () => void app.toggleRecording() },
    h("span", { className: "record-glyph" }),
  );
  const source = h("p", { className: "recorder-source muted" });
  const idle = h(
    "div",
    { className: "recorder-idle" },
    h("p", { className: "recorder-title", textContent: "New memo" }),
    source,
  );
  const time = h("span", { className: "recorder-time" });
  const bars = Array.from({ length: WAVE_BARS }, () => h("span", { className: "wave-bar" }));
  const live = h(
    "div",
    { className: "recorder-live", hidden: true },
    time,
    h("div", { className: "waveform", ariaHidden: "true" }, ...bars),
  );
  const toggle = computerAudioSwitch("switch-row-card");
  const element = h(
    "section",
    { className: "recorder card", ariaLabel: "Recorder" },
    h("div", { className: "recorder-main" }, button, h("div", { className: "recorder-info" }, idle, live)),
    toggle.element,
  );

  // A ring buffer: `head` is the oldest level and the next slot to write.
  const levels = new Float32Array(WAVE_BARS);
  let head = 0;
  const draw = () => {
    bars.forEach((bar, index) => bar.style.setProperty("--h", levels[(head + index) % WAVE_BARS].toFixed(3)));
  };
  app.onLevels((next) => {
    levels[head] = levelOf(Math.max(next.me, next.others));
    head = (head + 1) % WAVE_BARS;
    draw();
  });

  return {
    element,
    update() {
      const { recording, recordBusy, includeComputerAudio } = app.state;
      if (recording && live.hidden) {
        levels.fill(0);
        draw();
      }
      const label = recording ? "Stop" : "Record";
      if (button.ariaLabel !== label) button.ariaLabel = label;
      button.disabled = recordBusy;
      button.classList.toggle("is-recording", recording !== null);
      idle.hidden = recording !== null;
      live.hidden = recording === null;
      setText(source, includeComputerAudio ? "Microphone and computer audio" : "Microphone");
      if (recording) setText(time, formatClock((performance.now() - recording.startedAt) / 1000));
      toggle.update();
    },
  };
}

function noticeList(): Region {
  const element = h("div", { className: "notices", hidden: true });
  let shown = "[]";

  return {
    element,
    update() {
      const { notices } = app.state;
      const next = JSON.stringify(notices.map((n) => [n.level, n.text, n.action?.label]));
      if (next === shown) return;
      shown = next;
      element.replaceChildren(
        ...notices.map((notice, index) => {
          const row = h(
            "div",
            { className: `callout ${notice.level === "error" ? "callout-danger" : "callout-warn"}` },
            icon("alert"),
            h("p", { textContent: notice.text }),
          );
          if (notice.action) {
            row.append(
              h("button", {
                type: "button",
                className: "btn",
                textContent: notice.action.label,
                onclick: () => app.state.notices[index]?.action?.run(),
              }),
            );
          }
          return row;
        }),
      );
      element.hidden = notices.length === 0;
    },
  };
}

function downloadPercent(status: { loaded: number; total: number }): number {
  return status.total > 0 ? Math.min(100, Math.floor((100 * status.loaded) / status.total)) : 0;
}

function pillText(status: ModelStatus): string {
  switch (status.kind) {
    case "checking":
      return "Starting";
    case "downloading":
      return `Downloading ${downloadPercent(status)}%`;
    case "loading":
      return "Loading";
    case "ready":
      return "Ready";
    case "removed":
      return "No model";
    case "error":
      return "Problem";
  }
}

function statusSentence(status: ModelStatus): string {
  switch (status.kind) {
    case "checking":
      return "Starting speech model";
    case "downloading":
      return `Downloading speech model, ${Math.round(status.loaded / MB)} of ${Math.round(status.total / MB)} MB`;
    case "loading":
      return "Loading speech model";
    case "ready":
      return "Ready on this computer";
    case "removed":
      return "Speech model not downloaded";
    case "error":
      return "Speech model failed";
  }
}

function appBar(): Region {
  const dot = h("span", { className: "status-dot" });
  const text = h("span");
  const pill = h(
    "button",
    {
      type: "button",
      className: "status-pill",
      ariaExpanded: "false",
      onclick: () => (popover.hidden ? open() : close(false)),
    },
    dot,
    text,
  );
  pill.setAttribute("aria-haspopup", "dialog");
  const progressFill = h("span", { className: "progress-fill" });
  const progress = h("div", { className: "progress app-bar-progress", hidden: true }, progressFill);

  const sentence = h("p", { className: "model-status" });
  const select = h(
    "select",
    { onchange: () => void app.setModel(select.value) },
    ...ASR_MODELS.map((m) => h("option", { value: m.id, textContent: `${m.label}, ${m.sizeMB} MB` })),
  );
  const action = h("button", {
    type: "button",
    className: "btn",
    hidden: true,
    onclick: () => {
      const { modelStatus, model } = app.state;
      if (modelStatus.kind === "ready") void app.removeModelDownload();
      else if (modelStatus.kind === "removed") void app.setModel(model.id);
    },
  });
  const popover = h(
    "div",
    { className: "card model-popover", role: "dialog", ariaLabel: "Speech model", hidden: true },
    sentence,
    h("label", { className: "field" }, h("span", { textContent: "Speech model" }), select),
    h("p", { className: "muted", textContent: "Runs on this computer. Nothing is uploaded." }),
    action,
  );
  const mark = h("span", { className: "app-mark" }, icon("audio-lines"));
  const element = h(
    "header",
    { className: "app-bar" },
    h("div", { className: "app-brand" }, mark, h("span", { className: "app-name", textContent: "Memos" })),
    pill,
    progress,
    popover,
  );

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!pill.contains(target) && !popover.contains(target)) close(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close(true);
  };
  function open() {
    popover.hidden = false;
    pill.ariaExpanded = "true";
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
  }
  function close(refocus: boolean) {
    popover.hidden = true;
    pill.ariaExpanded = "false";
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown);
    if (refocus) pill.focus();
  }

  return {
    element,
    update() {
      const { modelStatus: status, model, transcribing } = app.state;
      const short = pillText(status);
      setText(text, short);
      const label = `Speech model, ${short}`;
      if (pill.ariaLabel !== label) pill.ariaLabel = label;
      if (dot.dataset.kind !== status.kind) dot.dataset.kind = status.kind;
      setText(sentence, statusSentence(status));

      progress.hidden = status.kind !== "downloading";
      if (status.kind === "downloading") progressFill.style.width = `${downloadPercent(status)}%`;

      if (select.value !== model.id) select.value = model.id;
      select.disabled = status.kind === "downloading" || status.kind === "loading" || transcribing !== null;
      action.hidden = status.kind !== "ready" && status.kind !== "removed";
      setText(action, status.kind === "ready" ? "Remove download" : "Download");
    },
  };
}

interface MemoStatus {
  text: string;
  /** Class list of the status chip. */
  chip: string;
}

function memoStatus(session: Session): MemoStatus {
  const { recording, transcribing, queued } = app.state;
  if (recording?.sessionId === session.id) return { text: "Recording", chip: "chip chip-record" };
  if (transcribing?.sessionId === session.id) {
    const progress = transcribing.progress;
    if (!progress) return { text: "Starting", chip: "chip chip-accent" };
    const percent = progress.totalSeconds > 0 ? Math.round((progress.doneSeconds / progress.totalSeconds) * 100) : 0;
    const stage = progress.stage === "speakers" ? "Finding speakers" : "Transcribing";
    return { text: `${stage} ${Math.min(100, percent)}%`, chip: "chip chip-accent" };
  }
  if (queued.includes(session.id)) return { text: "Waiting", chip: "chip" };
  if (session.error) return { text: "Failed", chip: "chip chip-danger" };
  return { text: "", chip: "chip" };
}

interface MemoRow {
  item: HTMLLIElement;
  button: HTMLButtonElement;
  title: HTMLElement;
  meta: HTMLElement;
  status: HTMLElement;
}

interface MemoGroup {
  section: HTMLElement;
  list: HTMLUListElement;
}

function memoList(): Region {
  const toggle = computerAudioSwitch("switch-row-list");
  const empty = h(
    "div",
    { className: "memo-empty" },
    h("span", { className: "memo-empty-icon" }, icon("mic", 24)),
    h("p", { className: "memo-empty-title", textContent: "No memos yet" }),
    h("p", { className: "muted", textContent: "Press the red button to record your first memo." }),
  );
  const groupHost = h("div", { className: "memo-groups", hidden: true });
  const element = h("nav", { className: "memos", ariaLabel: "Memos" }, toggle.element, empty, groupHost);
  const rows = new Map<string, MemoRow>();
  /** Keyed by the day label. */
  const groups = new Map<string, MemoGroup>();

  function createRow(id: string): MemoRow {
    const title = h("span", { className: "memo-title" });
    const status = h("span", { className: "chip", hidden: true });
    const meta = h("span", { className: "memo-meta" });
    const button = h(
      "button",
      {
        type: "button",
        className: "memo",
        onclick: () => {
          void app.select(id);
          showPane("detail");
        },
      },
      h("span", { className: "memo-line" }, title, status),
      meta,
    );
    const row = { item: h("li", {}, button), button, title, meta, status };
    rows.set(id, row);
    return row;
  }

  function createGroup(label: string): MemoGroup {
    const list = h("ul", { className: "memo-list" });
    const section = h(
      "section",
      { className: "memo-group" },
      h("h2", { className: "memo-group-title", textContent: label }),
      list,
    );
    const group = { section, list };
    groups.set(label, group);
    return group;
  }

  return {
    element,
    update() {
      const { sessions, selectedId, recording } = app.state;
      toggle.update();
      empty.hidden = sessions.length > 0;
      groupHost.hidden = sessions.length === 0;

      const live = new Set(sessions.map((s) => s.id));
      for (const [id, row] of rows) {
        if (live.has(id)) continue;
        row.item.remove();
        rows.delete(id);
      }

      const byDay = new Map<string, Session[]>();
      for (const session of sessions) {
        const label = sessionDayGroup(session);
        const members = byDay.get(label);
        if (members) members.push(session);
        else byDay.set(label, [session]);
      }

      let groupIndex = 0;
      for (const [label, members] of byDay) {
        const group = groups.get(label) ?? createGroup(label);
        // Moving only groups and rows that are out of place keeps focus and scroll position.
        if (groupHost.children[groupIndex] !== group.section) {
          groupHost.insertBefore(group.section, groupHost.children[groupIndex] ?? null);
        }
        groupIndex += 1;

        members.forEach((session, index) => {
          const row = rows.get(session.id) ?? createRow(session.id);
          const seconds =
            recording?.sessionId === session.id
              ? (performance.now() - recording.startedAt) / 1000
              : session.samples / SAMPLE_RATE;
          const status = memoStatus(session);
          setText(row.title, sessionTitle(session));
          setText(row.meta, `${sessionTime(session)} · ${formatClock(seconds)}`);
          setText(row.status, status.text);
          if (row.status.className !== status.chip) row.status.className = status.chip;
          row.status.hidden = status.text === "";
          if (session.id === selectedId) row.button.setAttribute("aria-current", "true");
          else row.button.removeAttribute("aria-current");
          if (group.list.children[index] !== row.item) {
            group.list.insertBefore(row.item, group.list.children[index] ?? null);
          }
        });
      }

      for (const [label, group] of groups) {
        if (byDay.has(label)) continue;
        group.section.remove();
        groups.delete(label);
      }
    },
  };
}

export function mountSidebar(root: HTMLElement): void {
  const regions = [appBar(), recorder(), noticeList(), memoList()];
  root.replaceChildren(...regions.map((region) => region.element));

  let timer = 0;
  let wasRecording = false;
  const update = () => {
    for (const region of regions) region.update();
    const recording = app.state.recording !== null;
    // A stop brings the new memo into view on a narrow window.
    if (wasRecording && !recording) showPane("detail");
    wasRecording = recording;
    if (recording && !timer) {
      timer = window.setInterval(update, 250);
    } else if (!recording && timer) {
      window.clearInterval(timer);
      timer = 0;
    }
  };
  app.subscribe(update);
  update();
}
