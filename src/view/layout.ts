export type Pane = "list" | "detail";

/** Chooses the pane shown when the window is too narrow for both. No effect on a wide window. */
export function showPane(pane: Pane): void {
  document.documentElement.dataset.pane = pane;
}

showPane("list");
