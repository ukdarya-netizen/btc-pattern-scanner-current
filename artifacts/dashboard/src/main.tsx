import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installI18n } from "./lib/i18n";

// RU / EN (owner 2026-11-13, as in CAB / Nihilist): English replaces the Russian text on the page from lib/i18n/en.json.
void installI18n().finally(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
