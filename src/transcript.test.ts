import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, Track, TranscriptLine, WindowResult } from "./store.ts";
import {
  buildTranscript,
  hasSpeakerLabels,
  previewOf,
  sessionDate,
  sessionDayGroup,
  sessionTime,
  sessionTitle,
  speakerLabel,
  toPlainText,
} from "./transcript.ts";

function session(tracks: Track[], extra: Partial<Session> = {}): Session {
  return { id: "s1", createdAt: 0, samples: 0, status: "transcribed", tracks, ...extra };
}

function line(track: Track, speaker: number, start: number, end: number, text = "hello"): TranscriptLine {
  return { track, speaker, start, end, text };
}

function result(index: number, lines: TranscriptLine[]): WindowResult {
  return { sessionId: "s1", track: lines[0].track, index, lines };
}

describe("speakerLabel", () => {
  it("prefers the name the user gave", () => {
    const memo = session(["others", "me"], { speakerNames: { "others:0": "Ada" } });
    expect(speakerLabel(memo, { track: "others", speaker: 0 })).toBe("Ada");
  });

  it("calls the microphone Me when computer audio is recorded", () => {
    expect(speakerLabel(session(["others", "me"]), { track: "me", speaker: 0 })).toBe("Me");
  });

  it("numbers microphone speakers in a microphone-only session", () => {
    expect(speakerLabel(session(["me"]), { track: "me", speaker: 1 })).toBe("Speaker 2");
  });

  it("numbers computer audio speakers from 1", () => {
    expect(speakerLabel(session(["others", "me"]), { track: "others", speaker: 0 })).toBe("Speaker 1");
  });
});

describe("hasSpeakerLabels", () => {
  it("is false for one track with one speaker", () => {
    expect(hasSpeakerLabels(session(["me"]), [line("me", 0, 0, 1), line("me", 0, 5, 6)])).toBe(false);
  });

  it("is true for one track with two speakers", () => {
    expect(hasSpeakerLabels(session(["me"]), [line("me", 0, 0, 1), line("me", 1, 5, 6)])).toBe(true);
  });

  it("is true for a two-track session", () => {
    expect(hasSpeakerLabels(session(["others", "me"]), [line("me", 0, 0, 1)])).toBe(true);
  });
});

describe("buildTranscript", () => {
  it("merges lines of the same track and speaker 1 s apart", () => {
    const first = line("me", 0, 0, 2, "one");
    const merged = buildTranscript([result(0, [first, line("me", 0, 3, 4, "two")])]);
    expect(merged).toEqual([line("me", 0, 0, 4, "one two")]);
    expect(first).toEqual(line("me", 0, 0, 2, "one"));
  });

  it("keeps lines apart when the speaker differs", () => {
    const lines = [line("me", 0, 0, 2, "one"), line("me", 1, 3, 4, "two")];
    expect(buildTranscript([result(0, lines)])).toEqual(lines);
  });

  it("keeps lines apart when the gap is 2 s", () => {
    const lines = [line("me", 0, 0, 2, "one"), line("me", 0, 4, 5, "two")];
    expect(buildTranscript([result(0, lines)])).toEqual(lines);
  });

  it("returns time order across windows", () => {
    const late = result(1, [line("me", 0, 20, 21, "late")]);
    const early = result(0, [line("others", 0, 5, 6, "early")]);
    expect(buildTranscript([late, early]).map((l) => l.text)).toEqual(["early", "late"]);
  });
});

describe("previewOf", () => {
  it("is undefined without lines", () => {
    expect(previewOf([])).toBeUndefined();
  });

  it("keeps a 4-word line whole", () => {
    expect(previewOf([line("me", 0, 0, 1, "buy milk and eggs")])).toBe("buy milk and eggs");
  });

  it("cuts a 9-word line to 6 words and an ellipsis", () => {
    const text = "one two three four five six seven eight nine";
    expect(previewOf([line("me", 0, 0, 1, text)])).toBe("one two three four five six…");
  });
});

describe("sessionTitle", () => {
  it("uses the title first", () => {
    expect(sessionTitle(session(["me"], { title: "Standup", preview: "buy milk" }))).toBe("Standup");
  });

  it("falls back to the preview", () => {
    expect(sessionTitle(session(["me"], { preview: "buy milk" }))).toBe("buy milk");
  });

  it("falls back to New recording", () => {
    expect(sessionTitle(session(["me"]))).toBe("New recording");
  });
});

describe("sessionDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says Today for the same local day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 18, 30));
    const createdAt = new Date(2026, 10, 12, 14, 2).getTime();
    expect(sessionDate(session(["me"], { createdAt }))).toBe("Today 14:02");
  });

  it("says Yesterday for the local day before", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 0, 10));
    const createdAt = new Date(2026, 10, 11, 9, 15).getTime();
    expect(sessionDate(session(["me"], { createdAt }))).toBe("Yesterday 09:15");
  });
});

describe("sessionTime", () => {
  it("pads the hour and the minute to 2 digits", () => {
    const createdAt = new Date(2026, 10, 12, 9, 5).getTime();
    expect(sessionTime(session(["me"], { createdAt }))).toBe("09:05");
  });
});

describe("sessionDayGroup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says Today for the same local day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 18, 30));
    const createdAt = new Date(2026, 10, 12, 0, 5).getTime();
    expect(sessionDayGroup(session(["me"], { createdAt }))).toBe("Today");
  });

  it("says Yesterday for the local day before", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 0, 10));
    const createdAt = new Date(2026, 10, 11, 23, 50).getTime();
    expect(sessionDayGroup(session(["me"], { createdAt }))).toBe("Yesterday");
  });

  it("gives the month and the year for a day 40 days back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 18, 30));
    const createdAt = new Date(2026, 10, 12 - 40, 9, 0).getTime();
    const group = sessionDayGroup(session(["me"], { createdAt }));
    expect(group).toContain("2026");
    expect(group).not.toMatch(/Today|Yesterday/);
  });
});

describe("toPlainText", () => {
  it("leaves out labels for a one-speaker memo", () => {
    const text = toPlainText(session(["me"]), [line("me", 0, 65, 66, "buy milk")]);
    expect(text.split("\n")[2]).toBe("[01:05] buy milk");
  });

  it("labels both tracks of a session with computer audio", () => {
    const lines = [line("others", 0, 0, 1, "hi there"), line("me", 0, 5, 6, "hello")];
    const text = toPlainText(session(["others", "me"]), lines);
    expect(text.split("\n").slice(2, 4)).toEqual(["[00:00] Speaker 1: hi there", "[00:05] Me: hello"]);
  });
});
