import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Load .env from the repo root (shared with apps/api)
  envDir: "../../",
  server: {
    port: 5173,
  },
});
