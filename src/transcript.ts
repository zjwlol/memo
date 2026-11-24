import type { Session, Track, TranscriptLine, WindowResult } from "./store.ts";
import { SAMPLE_RATE } from "./store.ts";

/** Consecutive lines from the same speaker closer than this become one paragraph. */
const PARAGRAPH_GAP_S = 1.5;

const PREVIEW_WORDS = 6;

export function speakerKey(track: Track, speaker: number): string {
  return `${track}:${speaker}`;
}

export function speakerLabel(session: Session, line: { track: Track; speaker: number }): string {
  const name = session.speakerNames?.[speakerKey(line.track, line.speaker)];
  if (name) return name;
  if (line.track === "me" && session.tracks.includes("others")) return "Me";
  return `Speaker ${line.speaker + 1}`;
}

/** A memo with one track and one speaker reads better without labels. */
export function hasSpeakerLabels(session: Session, lines: TranscriptLine[]): boolean {
  if (session.tracks.length > 1) return true;
  return new Set(lines.map((l) => speakerKey(l.track, l.speaker))).size > 1;
}

/** Whisper's markers for non-speech ("[BLANK_AUDIO]", "(music)", "[Music]") are not transcript text. */
export function isSpokenText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !/^(\[[^\]]*\]|\([^)]*\)|\s)+$/.test(trimmed);
}

/** All window results in time order, same-speaker runs merged into paragraphs. */
export function buildTranscript(results: WindowResult[]): TranscriptLine[] {
  const lines = results.flatMap((r) => r.lines).sort((a, b) => a.start - b.start);
  const merged: TranscriptLine[] = [];
  for (const line of lines) {
    const last = merged.at(-1);
    if (last && last.track === line.track && last.speaker === line.speaker && line.start - last.end < PARAGRAPH_GAP_S) {
      last.text = `${last.text} ${line.text}`;
      last.end = Math.max(last.end, line.end);
    } else {
      merged.push({ ...line });
    }
  }
  return merged;
}

export function previewOf(lines: TranscriptLine[]): string | undefined {
  if (lines.length === 0) return undefined;
  const words = lines[0].text.trim().split(/\s+/);
  const kept = words.slice(0, PREVIEW_WORDS).join(" ");
  return words.length > PREVIEW_WORDS ? `${kept}…` : kept;
}

export function sessionTitle(session: Session): string {
  return session.title ?? session.preview ?? "New recording";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Start of the local day that is `daysBack` days before `date`. */
function dayStart(date: Date, daysBack = 0): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysBack).getTime();
}

/** `Today` or `Yesterday`, or undefined for an older day. */
function recentDay(created: Date): string | undefined {
  const now = new Date();
  const day = dayStart(created);
  if (day === dayStart(now)) return "Today";
  if (day === dayStart(now, 1)) return "Yesterday";
  return undefined;
}

/** Local 24-hour time, `HH:MM`. */
export function sessionTime(session: Session): string {
  const created = new Date(session.createdAt);
  return `${pad2(created.getHours())}:${pad2(created.getMinutes())}`;
}

export function sessionDate(session: Session): string {
  const created = new Date(session.createdAt);
  const day = recentDay(created) ?? created.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${day} ${sessionTime(session)}`;
}

/** `Today`, `Yesterday`, or the month and year. */
export function sessionDayGroup(session: Session): string {
  const created = new Date(session.createdAt);
  return recentDay(created) ?? created.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function formatClock(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${pad2(m)}:${pad2(s)}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

export function fileStem(session: Session): string {
  const d = new Date(session.createdAt);
  const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `memo-${day}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

export function toPlainText(session: Session, lines: TranscriptLine[]): string {
  const duration = formatClock(session.samples / SAMPLE_RATE);
  const header = `${sessionTitle(session)} (${sessionDate(session)}, ${duration})`;
  const labelled = hasSpeakerLabels(session, lines);
  const body = lines.map((l) => {
    const clock = `[${formatClock(l.start)}]`;
    return labelled ? `${clock} ${speakerLabel(session, l)}: ${l.text}` : `${clock} ${l.text}`;
  });
  return [header, "", ...body, ""].join("\n");
}

export function toMarkdown(session: Session, lines: TranscriptLine[]): string {
  const header = [
    `# ${sessionTitle(session)}`,
    "",
    `- Date: ${new Date(session.createdAt).toISOString()}`,
    `- Duration: ${formatClock(session.samples / SAMPLE_RATE)}`,
    "",
    "## Transcript",
    "",
  ];
  const labelled = hasSpeakerLabels(session, lines);
  const body = lines.map((l) => {
    const clock = `[${formatClock(l.start)}]`;
    return labelled ? `**${clock} ${speakerLabel(session, l)}:** ${l.text}` : `**${clock}** ${l.text}`;
  });
  return [...header, body.join("\n\n"), ""].join("\n");
}
