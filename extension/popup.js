const show = (on) => {
  document.getElementById("w").className = "w" + (on ? " on" : "");
  document.getElementById("t").textContent = on ? "Connected to Northstar" : "Northstar isn't running";
  document.getElementById("d").textContent = on
    ? "Northstar can work in this Chrome window. It asks you before anything final like submitting or sending."
    : "Start the Northstar app on this computer. The bridge reconnects on its own.";
};
const check = () => chrome.runtime.sendMessage("status", (r) => show(!!r?.connected));
document.getElementById("r").onclick = () => chrome.runtime.sendMessage("reconnect", () => setTimeout(check, 600));
check();
