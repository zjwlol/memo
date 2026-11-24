import "./detail.css";
import { app } from "../app.ts";
import { SAMPLE_RATE } from "../store.ts";
import type { Session } from "../store.ts";
import {
  fileStem,
  formatClock,
  hasSpeakerLabels,
  sessionDate,
  sessionTitle,
  speakerKey,
  speakerLabel,
  toMarkdown,
  toPlainText,
} from "../transcript.ts";
import { h, icon } from "./dom.ts";
import type { IconName } from "./dom.ts";
import { showPane } from "./layout.ts";
import { openMenu } from "./menu.ts";
import type { MenuItem } from "./menu.ts";

const COPY_FEEDBACK_MS = 1500;
const FLASH_MS = 4000;
const SPEAKER_COLOURS = 6;

interface Row {
  el: HTMLDivElement;
  time: HTMLSpanElement;
  /** The circle with the speaker's initial. null in a transcript without labels. */
  avatar: HTMLSpanElement | null;
  /** Holds the speaker button or the rename field. null in a transcript without labels. */
  speaker: HTMLDivElement | null;
  text: HTMLParagraphElement;
  /** What the speaker cell shows now, so it is rebuilt only on change. */
  speakerShown: string;
}

function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  h("a", { href: url, download: name }).click();
  // The download starts from the click, so the URL can go shortly after.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Writes text only when it differs, so a selection in unchanged text survives. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function backButton(): HTMLButtonElement {
  const button = h("button", { type: "button", className: "icon-btn detail-back" }, icon("chevron-left", 20));
  button.setAttribute("aria-label", "Back to memos");
  button.addEventListener("click", () => showPane("list"));
  return button;
}

export function mountDetail(root: HTMLElement): void {
  const empty = h(
    "div",
    { className: "detail-empty" },
    h("div", { className: "detail-empty-bar" }, backButton()),
    h(
      "div",
      { className: "detail-empty-body" },
      h("span", { className: "detail-empty-mark" }, icon("audio-lines", 24)),
      h("p", { className: "detail-empty-title", textContent: "No memo selected" }),
      h("p", {
        className: "muted",
        textContent: "Choose a memo from the list, or press the red button to record.",
      }),
    ),
  );

  const titleSlot = h("div");
  const metaText = h("span");
  const speakerCount = h("span");
  const metaSpeakers = h("span", { className: "detail-meta-speakers", hidden: true }, icon("users", 14), speakerCount);
  const meta = h("p", { className: "detail-meta" }, metaText, metaSpeakers);
  const copyBtn = h("button", { type: "button", className: "btn detail-copy" });
  const moreBtn = h("button", { type: "button", className: "icon-btn" }, icon("more"));
  moreBtn.setAttribute("aria-label", "More");
  const bar = h(
    "header",
    { className: "detail-bar" },
    h(
      "div",
      { className: "detail-bar-inner" },
      backButton(),
      h("div", { className: "detail-heading" }, titleSlot, meta),
      h("div", { className: "detail-actions" }, copyBtn, moreBtn),
    ),
  );

  const flashLine = h("p", { className: "detail-flash", hidden: true });
  flashLine.setAttribute("role", "status");

  const playBtn = h("button", { type: "button", className: "player-play" });
  const seek = h("input", { type: "range", className: "player-seek", min: "0", step: "any" });
  seek.setAttribute("aria-label", "Playback position");
  const playerCurrent = h("span");
  const playerTotal = h("span");
  const player = h(
    "div",
    { className: "player card", hidden: true },
    playBtn,
    seek,
    h(
      "div",
      { className: "player-times" },
      playerCurrent,
      h("span", { className: "player-times-sep", textContent: "/" }),
      playerTotal,
    ),
  );

  const status = h("div", { className: "detail-status", hidden: true });
  const transcript = h("div", { className: "transcript" });
  const noSpeech = h("p", {
    className: "transcript-none muted",
    textContent: "No speech found in this recording.",
    hidden: true,
  });

  // Leaves the view as soon as the pane scrolls, which turns the hairline of the bar on.
  const sentinel = h("div", { className: "detail-sentinel" });
  new IntersectionObserver((entries) => {
    for (const entry of entries) bar.classList.toggle("is-scrolled", !entry.isIntersecting);
  }).observe(sentinel);

  const article = h(
    "article",
    { className: "detail", hidden: true },
    sentinel,
    bar,
    h("div", { className: "detail-body" }, flashLine, player, status, transcript, noSpeech),
  );
  root.replaceChildren(empty, article);

  let shownId: string | null = null;

  const selected = (): Session | undefined => {
    const state = app.state;
    return state.sessions.find((session) => session.id === state.selectedId);
  };

  // Transient message

  let flashTimer: number | undefined;
  const setFlash = (text: string | null): void => {
    clearTimeout(flashTimer);
    flashLine.textContent = text ?? "";
    flashLine.hidden = text === null;
    if (text !== null) flashTimer = window.setTimeout(() => setFlash(null), FLASH_MS);
  };

  // Title

  let titleShown: string | null = null;
  let abandonTitleEdit: (() => void) | null = null;

  const renderTitle = (session: Session): void => {
    if (abandonTitleEdit) return;
    const title = sessionTitle(session);
    if (title === titleShown) return;
    titleShown = title;
    const button = h(
      "button",
      { type: "button", className: "detail-title-btn", title: "Rename" },
      h("span", { className: "detail-title-text", textContent: title }),
    );
    button.addEventListener("click", startRename);
    const hadFocus = titleSlot.contains(document.activeElement);
    titleSlot.replaceChildren(h("h1", { className: "detail-title" }, button));
    if (hadFocus) button.focus();
  };

  function startRename(): void {
    const session = selected();
    if (!session || abandonTitleEdit) return;
    const id = session.id;
    const before = sessionTitle(session);
    const input = h("input", { type: "text", className: "detail-title-input", value: before });
    input.setAttribute("aria-label", "Memo name");

    let done = false;
    abandonTitleEdit = () => {
      done = true;
      abandonTitleEdit = null;
      titleShown = null;
    };
    const finish = (save: boolean, refocus: boolean): void => {
      if (done) return;
      abandonTitleEdit?.();
      const value = input.value.trim();
      const current = selected();
      if (current) renderTitle(current);
      if (refocus) titleSlot.querySelector("button")?.focus();
      if (save && value !== before) void app.rename(id, value);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true, true);
      else if (event.key === "Escape") finish(false, true);
    });
    input.addEventListener("blur", () => finish(true, false));

    titleSlot.replaceChildren(input);
    input.focus();
    input.select();
  }

  // Copy

  let copyTimer: number | undefined;
  let copyRun = 0;
  const showCopy = (name: IconName, label: string, failed: boolean): void => {
    copyBtn.replaceChildren(icon(name), h("span", { className: "detail-copy-label", textContent: label }));
    copyBtn.classList.toggle("is-failed", failed);
  };
  const resetCopy = (): void => {
    copyRun++;
    clearTimeout(copyTimer);
    showCopy("copy", "Copy", false);
  };
  resetCopy();

  copyBtn.addEventListener("click", () => {
    const session = selected();
    if (!session) return;
    resetCopy();
    const run = copyRun;
    const feedback = (name: IconName, label: string, failed: boolean): void => {
      if (run !== copyRun) return;
      showCopy(name, label, failed);
      copyTimer = window.setTimeout(resetCopy, COPY_FEEDBACK_MS);
    };
    navigator.clipboard.writeText(toPlainText(session, app.state.lines)).then(
      () => feedback("check", "Copied", false),
      // The alert icon carries the failure where the label is not shown.
      () => feedback("alert", "Copy failed", true),
    );
  });

  // Menu

  const downloadAudio = async (session: Session): Promise<void> => {
    const name = `${fileStem(session)}.wav`;
    try {
      saveFile(await app.audio(session.id), name);
    } catch {
      if (shownId === session.id) setFlash("Could not prepare the audio file.");
    }
  };

  moreBtn.addEventListener("click", () => {
    const session = selected();
    if (!session) return;
    const state = app.state;
    const id = session.id;
    const busy =
      state.recording?.sessionId === id || state.queued.includes(id) || state.transcribing?.sessionId === id;

    const items: MenuItem[] = [{ label: "Rename", icon: "pencil", run: startRename }];
    if (state.lines.length > 0) {
      items.push(
        {
          label: "Download transcript (.md)",
          icon: "download",
          run: () =>
            saveFile(
              new Blob([toMarkdown(session, app.state.lines)], { type: "text/markdown;charset=utf-8" }),
              `${fileStem(session)}.md`,
            ),
        },
        {
          label: "Download transcript (.txt)",
          icon: "download",
          run: () =>
            saveFile(
              new Blob([toPlainText(session, app.state.lines)], { type: "text/plain;charset=utf-8" }),
              `${fileStem(session)}.txt`,
            ),
        },
      );
    }
    items.push({ label: "Download audio (.wav)", icon: "download", run: () => void downloadAudio(session) });
    if (!busy) {
      items.push(
        { label: "Transcribe again", icon: "refresh", run: () => void app.retranscribe(id) },
        {
          label: "Delete",
          icon: "trash",
          danger: true,
          confirm: "Click again to delete",
          run: () => void app.remove(id),
        },
      );
    }
    openMenu(moreBtn, items);
  });

  // Player

  const audio = new Audio();
  let audioUrl: string | null = null;
  let loading = false;
  /** Changes on every load and reset, so a late load can tell it is stale. */
  let loadRun = 0;
  /** Position the user picked before the audio was loaded. */
  let pendingSeek: number | null = null;
  let playShown: boolean | null = null;

  const renderPlayer = (): void => {
    const session = selected();
    if (!session) return;
    player.hidden = app.state.recording?.sessionId === session.id || session.samples === 0;

    const loaded = audioUrl !== null;
    const playing = loaded && !audio.paused && !audio.ended;
    if (playing !== playShown) {
      playShown = playing;
      playBtn.replaceChildren(icon(playing ? "pause" : "play"));
      playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    }
    playBtn.disabled = loading;

    const total = loaded && Number.isFinite(audio.duration) ? audio.duration : session.samples / SAMPLE_RATE;
    const position = Math.min(loaded ? audio.currentTime : (pendingSeek ?? 0), total);
    seek.max = String(total);
    seek.value = String(position);
    seek.style.setProperty("--fill", `${total > 0 ? (position / total) * 100 : 0}%`);
    seek.setAttribute("aria-valuetext", formatClock(position));
    setText(playerCurrent, formatClock(position));
    setText(playerTotal, formatClock(total));
  };

  const resetPlayer = (): void => {
    loadRun++;
    loading = false;
    pendingSeek = null;
    audio.pause();
    if (audioUrl !== null) {
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
  };

  /** Resolves true when the audio of this session is attached to the player. */
  const loadAudio = async (id: string): Promise<boolean> => {
    const run = ++loadRun;
    const hadFocus = document.activeElement === playBtn;
    loading = true;
    renderPlayer();
    let blob: Blob | null = null;
    try {
      blob = await app.audio(id);
    } catch {
      if (run === loadRun) setFlash("Could not load the audio.");
    }
    if (run !== loadRun) return false;
    if (blob) {
      audioUrl = URL.createObjectURL(blob);
      audio.src = audioUrl;
      if (pendingSeek !== null) audio.currentTime = pendingSeek;
    }
    loading = false;
    pendingSeek = null;
    renderPlayer();
    // The button lost focus when it was disabled for the load.
    if (hadFocus && document.activeElement === document.body) playBtn.focus();
    return blob !== null;
  };

  playBtn.addEventListener("click", async () => {
    const session = selected();
    if (!session || loading) return;
    if (audioUrl === null && !(await loadAudio(session.id))) return;
    if (audio.paused || audio.ended) audio.play().catch(renderPlayer);
    else audio.pause();
  });

  seek.addEventListener("input", () => {
    const session = selected();
    if (!session) return;
    if (audioUrl !== null) audio.currentTime = seek.valueAsNumber;
    else {
      pendingSeek = seek.valueAsNumber;
      if (!loading) void loadAudio(session.id);
    }
    renderPlayer();
  });

  for (const type of ["play", "pause", "ended", "timeupdate", "durationchange", "seeked"]) {
    audio.addEventListener(type, renderPlayer);
  }

  // Status

  let statusShown = "";
  let progressFill: HTMLDivElement | null = null;
  let progressText: HTMLParagraphElement | null = null;

  const renderStatus = (session: Session): void => {
    const state = app.state;
    const id = session.id;
    const progress = state.transcribing?.sessionId === id ? state.transcribing.progress : undefined;

    let kind = "";
    let line = "";
    if (state.recording?.sessionId === id) {
      kind = "recording";
      line = "Recording. The transcript appears after you stop.";
    } else if (progress) kind = "progress";
    else if (progress === null) line = "Starting…";
    else if (state.queued.includes(id)) {
      line = state.modelStatus.kind === "ready" ? "Waiting…" : "Waiting for the speech model…";
    } else if (session.error !== undefined) {
      kind = "error";
      line = `Transcription failed: ${session.error}`;
    }

    const shown = `${id}\n${kind}\n${line}`;
    if (shown !== statusShown) {
      statusShown = shown;
      progressFill = null;
      progressText = null;
      status.hidden = kind === "" && line === "";
      if (kind === "progress") {
        progressFill = h("div", { className: "progress-fill" });
        progressText = h("p");
        const track = h("div", { className: "progress" }, progressFill);
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-label", "Transcription progress");
        status.replaceChildren(track, progressText);
      } else if (kind === "error") {
        const retry = h("button", { type: "button", className: "btn", textContent: "Try again" });
        retry.addEventListener("click", () => void app.retranscribe(id));
        const callout = h(
          "div",
          { className: "callout callout-danger" },
          icon("alert"),
          h("p", { textContent: line }),
          retry,
        );
        callout.setAttribute("role", "alert");
        status.replaceChildren(callout);
      } else if (line !== "") {
        const dot = h("span", { className: kind === "recording" ? "status-dot status-dot-record" : "status-dot" });
        dot.setAttribute("aria-hidden", "true");
        status.replaceChildren(h("p", { className: "status-line" }, dot, line));
      } else {
        status.replaceChildren();
      }
    }

    if (progress && progressFill && progressText) {
      const { stage, doneSeconds, totalSeconds, secondsPerSecond } = progress;
      const percent = totalSeconds > 0 ? Math.min(100, Math.floor((doneSeconds / totalSeconds) * 100)) : 0;
      const left =
        secondsPerSecond === null
          ? ""
          : `, about ${formatClock(Math.max(0, (totalSeconds - doneSeconds) * secondsPerSecond))} left`;
      progressFill.style.width = `${percent}%`;
      progressFill.parentElement?.setAttribute("aria-valuenow", String(percent));
      setText(progressText, `${stage === "speakers" ? "Finding speakers" : "Transcribing"} ${percent}%${left}`);
    }
  };

  // Transcript

  let rows: Row[] = [];
  let labelled: boolean | null = null;
  let speakerEdit: { row: Row; abandon: () => void } | null = null;

  const clearTranscript = (): void => {
    speakerEdit?.abandon();
    rows = [];
    labelled = null;
    transcript.replaceChildren();
  };

  const startSpeakerEdit = (row: Row, id: string, key: string, before: string): void => {
    const cell = row.speaker;
    if (!cell) return;
    const input = h("input", { type: "text", className: "speaker-input", value: before });
    input.setAttribute("aria-label", "Speaker name");

    let done = false;
    const abandon = (): void => {
      done = true;
      speakerEdit = null;
      row.speakerShown = "";
    };
    const finish = (save: boolean, refocus: boolean): void => {
      if (done) return;
      abandon();
      const value = input.value.trim();
      render();
      if (refocus) cell.querySelector("button")?.focus();
      if (save && value !== before) void app.renameSpeaker(id, key, value);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true, true);
      else if (event.key === "Escape") finish(false, true);
    });
    input.addEventListener("blur", () => finish(true, false));

    speakerEdit = { row, abandon };
    cell.replaceChildren(input);
    input.focus();
    input.select();
  };

  const renderTranscript = (session: Session): void => {
    const lines = app.state.lines;
    const labels = hasSpeakerLabels(session, lines);
    if (labels !== labelled) {
      clearTranscript();
      labelled = labels;
      transcript.classList.toggle("transcript-labelled", labels);
    }

    const colours = new Map<string, number>();
    lines.forEach((line, index) => {
      let row = rows[index];
      if (!row) {
        const time = h("span", { className: "transcript-time" });
        const text = h("p", { className: "transcript-text" });
        const el = h("div", { className: "transcript-block" });
        let avatar: HTMLSpanElement | null = null;
        let speaker: HTMLDivElement | null = null;
        if (labels) {
          avatar = h("span", { className: "speaker-avatar" });
          avatar.setAttribute("aria-hidden", "true");
          speaker = h("div", { className: "transcript-speaker" });
          el.append(h("div", { className: "transcript-head" }, avatar, speaker, time), text);
        } else {
          el.append(time, text);
        }
        row = { el, time, avatar, speaker, text, speakerShown: "" };
        rows.push(row);
        transcript.append(el);
      }

      setText(row.time, formatClock(line.start));
      setText(row.text, line.text);

      if (!row.speaker || !row.avatar) return;
      const key = speakerKey(line.track, line.speaker);
      let colour = colours.get(key);
      if (colour === undefined) {
        colour = (colours.size % SPEAKER_COLOURS) + 1;
        colours.set(key, colour);
      }
      const label = speakerLabel(session, line);
      const shown = `${key}\n${colour}\n${label}`;
      if (row === speakerEdit?.row || shown === row.speakerShown) return;
      row.speakerShown = shown;
      row.el.dataset.speaker = String(colour);
      // The default names differ only in their number, so the number is the initial.
      const numbered = /^Speaker (\d+)$/.exec(label);
      row.avatar.textContent = numbered ? numbered[1] : (Array.from(label)[0] ?? "").toUpperCase();
      const button = h("button", { type: "button", className: "speaker-btn", title: "Rename speaker", textContent: label });
      const cells = row;
      button.addEventListener("click", () => startSpeakerEdit(cells, session.id, key, label));
      const hadFocus = row.speaker.contains(document.activeElement);
      row.speaker.replaceChildren(button);
      if (hadFocus) button.focus();
    });

    for (const row of rows.splice(lines.length)) {
      if (row === speakerEdit?.row) speakerEdit.abandon();
      row.el.remove();
    }
    noSpeech.hidden = lines.length > 0 || session.status !== "transcribed";
  };

  function render(): void {
    const session = selected();
    const id = session?.id ?? null;
    if (id !== shownId) {
      shownId = id;
      abandonTitleEdit?.();
      titleShown = null;
      clearTranscript();
      resetPlayer();
      resetCopy();
      setFlash(null);
      empty.hidden = id !== null;
      article.hidden = id === null;
      root.scrollTop = 0;
    }
    if (!session) return;

    const lines = app.state.lines;
    renderTitle(session);
    const live = app.state.recording?.sessionId === session.id;
    const duration = formatClock(session.samples / SAMPLE_RATE);
    setText(metaText, live ? sessionDate(session) : `${sessionDate(session)} · ${duration}`);
    const speakers = hasSpeakerLabels(session, lines)
      ? new Set(lines.map((line) => speakerKey(line.track, line.speaker))).size
      : 0;
    metaSpeakers.hidden = speakers < 2;
    setText(speakerCount, `${speakers} speakers`);
    copyBtn.disabled = lines.length === 0;
    renderPlayer();
    renderStatus(session);
    renderTranscript(session);
  }

  app.subscribe(render);
  render();
}
