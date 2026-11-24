export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
}

export type IconName =
  | "play"
  | "pause"
  | "copy"
  | "check"
  | "more"
  | "mic"
  | "monitor"
  | "trash"
  | "download"
  | "refresh"
  | "pencil"
  | "alert"
  | "chevron-down"
  | "chevron-left"
  | "audio-lines"
  | "users";

/** Path data on a 16 by 16 grid. */
const ICON_PATHS: Record<IconName, string[]> = {
  play: ["M5 3.5v9l7-4.5z"],
  pause: ["M5.5 3.5v9", "M10.5 3.5v9"],
  copy: [
    "M7 5.5h5A1.5 1.5 0 0 1 13.5 7v5a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 12V7A1.5 1.5 0 0 1 7 5.5z",
    "M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5",
  ],
  check: ["M3 8.5 6.5 12 13 4.5"],
  more: ["M3.5 8h.01", "M8 8h.01", "M12.5 8h.01"],
  mic: ["M8 2a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0V4a2 2 0 0 0-2-2z", "M3.5 7.5a4.5 4.5 0 0 0 9 0", "M8 12v2.5"],
  monitor: ["M3 3h10a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M5.5 14h5", "M8 11.5V14"],
  trash: [
    "M2.5 4.5h11",
    "M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5",
    "M4 4.5l.6 8.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.1",
  ],
  download: ["M8 2.5v8", "M4.5 7.5 8 11l3.5-3.5", "M3 13.5h10"],
  refresh: ["M13 8a5 5 0 1 1-1.5-3.6", "M13 2.5v3h-3"],
  pencil: ["M11 2.5 13.5 5l-8 8H3v-2.5z", "M9.5 4 12 6.5"],
  alert: ["M8 2.5 14 13H2z", "M8 6.5v3", "M8 11.5h.01"],
  "chevron-down": ["M4 6l4 4 4-4"],
  "chevron-left": ["M10 4 6 8l4 4"],
  "audio-lines": ["M3.5 6.5v3", "M6.5 3.5v9", "M9.5 5.5v5", "M12.5 7v2"],
  users: [
    "M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
    "M1.5 13.5V13A3.5 3.5 0 0 1 5 9.5h2a3.5 3.5 0 0 1 3.5 3.5v.5",
    "M10.5 2.7a2.5 2.5 0 0 1 0 4.6",
    "M12.5 9.8a3.5 3.5 0 0 1 2 3.2v.5",
  ],
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** Inline SVG, `size` px square, stroke currentColor, no fill, aria-hidden. */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attributes = {
    width: String(size),
    height: String(size),
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
