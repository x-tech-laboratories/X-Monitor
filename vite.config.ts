import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const server_port = Number(process.env.PORT ?? 8080);

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    // The dev page reaches the API and the agents' socket through the separately running server.
    proxy: {
      "/api": { target: `http://127.0.0.1:${server_port}`, ws: true },
      "/metrics": `http://127.0.0.1:${server_port}`,
    },
  },
  test: {
    // Tests live in tests/, outside the web page's root.
    root: import.meta.dirname,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
