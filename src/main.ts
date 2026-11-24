import "./style.css";
import { app } from "./app.ts";
import { mountDetail } from "./view/detail.ts";
import { mountSidebar } from "./view/sidebar.ts";

mountSidebar(document.getElementById("sidebar")!);
mountDetail(document.getElementById("detail")!);

window.addEventListener("beforeunload", (event) => {
  if (app.state.recording || app.state.transcribing) event.preventDefault();
});

void app.init();
