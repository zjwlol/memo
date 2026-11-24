/** 16-bit mono PCM WAV, for playing back or downloading a recorded track. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
  };
  const dataBytes = pcm.length * 2;
  ascii(0, "RIFF");
  header.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  header.setUint32(16, 16, true); // fmt chunk size
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true); // byte rate
  header.setUint16(32, 2, true); // block align
  header.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  header.setUint32(40, dataBytes, true);
  return new Blob([header, pcm as Int16Array<ArrayBuffer>], { type: "audio/wav" });
}

/** Sums equal-length tracks into one, clamped to 16 bits. One track is returned as is. */
export function mixTracks(tracks: Int16Array[]): Int16Array {
  if (tracks.length === 1) return tracks[0];
  const mixed = new Int16Array(tracks[0]?.length ?? 0);
  for (let i = 0; i < mixed.length; i++) {
    let sum = 0;
    for (const track of tracks) sum += track[i];
    mixed[i] = Math.max(-32768, Math.min(32767, sum));
  }
  return mixed;
}
