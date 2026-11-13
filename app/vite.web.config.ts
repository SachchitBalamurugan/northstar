// Runs the renderer in a plain browser (http://localhost:5199) for fast screenshots / UI review.
import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  resolve: { alias: { "@": resolve(__dirname, "src/renderer/src"), "@contracts": resolve(__dirname, "../contracts") } },
  plugins: [react(), tailwindcss()],
  server: { port: 5199, strictPort: true, fs: { allow: [resolve(__dirname, "..")] } },
});
