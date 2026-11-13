import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Bubble from "./Bubble";
import { AskRoot } from "./Ask";
import "./styles.css";

const isBubble = window.location.hash === "#bubble";
const isAsk = window.location.hash === "#ask";

// In Electron both windows are transparent; the app draws its own rounded black surface so it can zoom from the orb.
if ((window as any).northstar) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

createRoot(document.getElementById("root")!).render(<StrictMode>{isBubble ? <Bubble /> : isAsk ? <AskRoot app={<App />} /> : <App />}</StrictMode>);
