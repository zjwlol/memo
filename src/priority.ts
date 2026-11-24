/**
 * Keeps this tab's process at full speed while the tab is hidden.
 *
 * Chrome gives the process of a hidden tab background priority, and macOS then runs it on the
 * efficiency cores: the speaker models measured about five times slower there. A process with a
 * running audio stream keeps its priority, so this plays silence until the result is called.
 */
export function holdPriority(): () => void {
  const context = new AudioContext({ latencyHint: "playback" });
  const silence = new ConstantSourceNode(context, { offset: 0 });
  silence.connect(context.destination);
  silence.start();

  // A page that got no click or key since it loaded may not start audio. The first one starts it.
  const resume = () => void context.resume();
  const gestures = ["pointerdown", "keydown"] as const;
  for (const type of gestures) addEventListener(type, resume);

  return () => {
    for (const type of gestures) removeEventListener(type, resume);
    void context.close();
  };
}
