import type { AsrClient } from "./asr-client.ts";
import type { AsrModel } from "./models.ts";
import { ownVoiceLevels } from "./bleed.ts";
import { planWindows, renderWindow, speakerAt, toSourceTime, type AudioWindow } from "./segment.ts";
import { diarizeTrack } from "./speakers.ts";
import {
  clearWindowResults,
  getTurns,
  listWindowResults,
  putTurns,
  putWindowResult,
  readTrack,
  SAMPLE_RATE,
  updateSession,
  type Session,
  type SpeakerTurn,
  type Track,
  type TranscriptLine,
  type WindowResult,
} from "./store.ts";
import { buildTranscript, isSpokenText, previewOf } from "./transcript.ts";

export interface TranscribeProgress {
  stage: "speakers" | "text";
  doneSeconds: number;
  totalSeconds: number;
  /** Wall seconds per audio second in the text stage, null until the first window. */
  secondsPerSecond: number | null;
}

interface Job {
  track: Track;
  index: number;
  window: AudioWindow;
}

const jobKey = (job: { track: Track; index: number }): string => `${job.track}:${job.index}`;

/**
 * Finds the speakers, then transcribes every speech window of every track,
 * oldest first, storing each result as soon as it is ready. Turns and windows
 * already stored (from an interrupted run) are reused, so calling this again
 * resumes.
 */
export async function transcribeSession(
  session: Session,
  asr: AsrClient,
  model: AsrModel,
  onProgress: (progress: TranscribeProgress, result: WindowResult | null) => void,
): Promise<void> {
  if (session.modelId !== undefined && session.modelId !== model.id) await clearWindowResults(session.id);
  await updateSession(session.id, { status: "transcribing", modelId: model.id, error: undefined });
  try {
    const pcm = new Map<Track, Int16Array>();
    for (const track of session.tracks) pcm.set(track, await readTrack(session, track));

    const turns = new Map<Track, SpeakerTurn[]>();
    const newlyDiarized = new Set<Track>();
    for (const track of session.tracks) {
      if (track !== "others" && session.tracks.length > 1) continue;
      const stored = await getTurns(session.id, track);
      if (Array.isArray(stored)) {
        turns.set(track, stored);
        continue;
      }
      try {
        const found = await diarizeTrack(pcm.get(track)!, asr, (doneSeconds, totalSeconds) =>
          onProgress({ stage: "speakers", doneSeconds, totalSeconds, secondsPerSecond: null }, null),
        );
        await putTurns(session.id, track, found);
        turns.set(track, found);
        newlyDiarized.add(track);
      } catch (error) {
        console.warn(`Could not tell the speakers apart in track "${track}"`, error);
      }
    }

    let stored = await listWindowResults(session.id);
    // Windows stored before the turns existed were planned without them, so their indexes no longer match.
    if (stored.some((result) => newlyDiarized.has(result.track))) {
      await clearWindowResults(session.id);
      stored = [];
    }

    // Without headphones the microphone also hears the others through the speakers. Only the user's own voice is transcribed from it.
    const others = pcm.get("others");
    const ownLevels = others && (await ownVoiceLevels(pcm.get("me")!, others, SAMPLE_RATE));

    const jobs: Job[] = session.tracks
      .flatMap((track) =>
        planWindows(pcm.get(track)!, SAMPLE_RATE, turns.get(track), track === "me" ? ownLevels : undefined).map(
          (window, index) => ({ track, index, window }),
        ),
      )
      .sort((a, b) => a.window.pieces[0].srcStart - b.window.pieces[0].srcStart);

    const done = new Set(stored.map(jobKey));
    const totalSeconds = jobs.reduce((sum, job) => sum + job.window.length, 0) / SAMPLE_RATE;
    let doneSeconds = jobs
      .filter((job) => done.has(jobKey(job)))
      .reduce((sum, job) => sum + job.window.length / SAMPLE_RATE, 0);
    let runAudioSeconds = 0;
    let runWallSeconds = 0;
    onProgress({ stage: "text", doneSeconds, totalSeconds, secondsPerSecond: null }, null);

    for (const job of jobs) {
      if (done.has(jobKey(job))) continue;
      const { chunks, ms } = await asr.transcribe(renderWindow(pcm.get(job.track)!, job.window));
      const windowEnd = job.window.length / SAMPLE_RATE;
      const lines: TranscriptLine[] = chunks
        .filter((chunk) => isSpokenText(chunk.text))
        .map((chunk) => {
          const chunkEnd = chunk.end ?? windowEnd;
          const start = toSourceTime(job.window, chunk.start, SAMPLE_RATE, "start");
          return {
            track: job.track,
            speaker: speakerAt(job.window, chunk.start, chunkEnd, SAMPLE_RATE),
            start,
            end: Math.max(start, toSourceTime(job.window, chunkEnd, SAMPLE_RATE, "end")),
            text: chunk.text.trim(),
          };
        });
      const result: WindowResult = { sessionId: session.id, track: job.track, index: job.index, lines };
      await putWindowResult(result);

      const seconds = job.window.length / SAMPLE_RATE;
      doneSeconds += seconds;
      runAudioSeconds += seconds;
      runWallSeconds += ms / 1000;
      onProgress(
        { stage: "text", doneSeconds, totalSeconds, secondsPerSecond: runWallSeconds / runAudioSeconds },
        result,
      );
    }

    const preview = previewOf(buildTranscript(await listWindowResults(session.id)));
    await updateSession(session.id, { status: "transcribed", preview });
  } catch (error) {
    await updateSession(session.id, {
      status: "recorded",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
