import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Bubble from "./Bubble";
import "./styles.css";

const isBubble = window.location.hash === "#bubble";

createRoot(document.getElementById("root")!).render(<StrictMode>{isBubble ? <Bubble /> : <App />}</StrictMode>);
