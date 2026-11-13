import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Bubble from "./Bubble";
import "./styles.css";

const isBubble = window.location.hash === "#bubble";

// In Electron both windows are transparent; the app draws its own rounded black surface so it can zoom from the orb.
if ((window as any).northstar) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

createRoot(document.getElementById("root")!).render(<StrictMode>{isBubble ? <Bubble /> : <App />}</StrictMode>);
