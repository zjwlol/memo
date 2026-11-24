import "./detail.css";
import { h, icon } from "./dom.ts";
import type { IconName } from "./dom.ts";

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  /** The first choice shows this text instead of the label, the second choice runs the item. */
  confirm?: string;
  run: () => void;
}

const GAP = 4;
const EDGE = 8;
const ONE_PANE = "(max-width: 719.98px)";

let current: { anchor: HTMLElement; close: () => void } | null = null;

/**
 * Opens a menu for the anchor: a popover under it on a wide window, a bottom sheet on a narrow one.
 * Closes on an outside press, Escape, or a choice. Arrow keys move, Enter chooses.
 */
export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  const reopened = current?.anchor === anchor;
  current?.close();
  if (reopened || items.length === 0) return;

  const narrow = window.matchMedia(ONE_PANE);
  const sheet = narrow.matches;
  const menu = h("div", { className: sheet ? "menu menu-sheet card" : "menu card" });
  menu.setAttribute("role", "menu");
  const label = anchor.getAttribute("aria-label");
  if (label) menu.setAttribute("aria-label", label);
  const backdrop = sheet ? h("div", { className: "menu-backdrop" }) : null;
  const listeners = new AbortController();
  const signal = listeners.signal;

  const place = (): void => {
    if (sheet) return;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(EDGE, Math.min(rect.right - width, window.innerWidth - width - EDGE));
    const below = rect.bottom + GAP;
    const fitsBelow = below + height <= window.innerHeight - EDGE;
    const top = fitsBelow ? below : Math.max(EDGE, rect.top - GAP - height);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };

  const close = (): void => {
    if (current?.close !== close) return;
    current = null;
    listeners.abort();
    menu.remove();
    backdrop?.remove();
    anchor.setAttribute("aria-expanded", "false");
    anchor.focus();
  };

  const buttons = items.map((item) => {
    const text = h("span", { textContent: item.label });
    const button = h("button", { type: "button", className: "menu-item", tabIndex: -1 });
    if (item.danger) button.classList.add("menu-item-danger");
    button.setAttribute("role", "menuitem");
    if (item.icon) button.append(icon(item.icon));
    button.append(text);

    let armed = false;
    button.addEventListener("click", () => {
      if (item.confirm !== undefined && !armed) {
        armed = true;
        text.textContent = item.confirm;
        place();
        return;
      }
      close();
      item.run();
    });
    button.addEventListener("blur", () => {
      if (!armed) return;
      armed = false;
      text.textContent = item.label;
      place();
    });
    button.addEventListener("pointermove", () => button.focus());
    return button;
  });
  menu.append(...buttons);

  const focusAt = (index: number): void => {
    buttons[(index + buttons.length) % buttons.length].focus();
  };

  menu.addEventListener("keydown", (event) => {
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index < 0 ? -1 : index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(-1);
    else if (event.key === "Escape") close();
    else if (event.key === "Tab") {
      // Focus goes back to the anchor and the browser then tabs on from there.
      close();
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });

  if (backdrop) {
    // Closing on the click, not the press, keeps the tap from reaching what lies under the backdrop.
    backdrop.addEventListener("click", close);
  } else {
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target;
        if (!(target instanceof Node && (menu.contains(target) || anchor.contains(target)))) close();
      },
      { capture: true, signal },
    );
    window.addEventListener("resize", close, { signal });
  }
  document.addEventListener(
    "scroll",
    (event) => {
      if (!(event.target instanceof Node && menu.contains(event.target))) close();
    },
    { capture: true, signal },
  );
  narrow.addEventListener("change", close, { signal });
  window.addEventListener("blur", close, { signal });

  if (backdrop) document.body.append(backdrop);
  document.body.append(menu);
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "true");
  current = { anchor, close };
  place();
  buttons[0].focus();
}
