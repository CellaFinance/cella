import { defineConfig } from "vite";

// The app lives in web/ and imports the shared client from src/.
export default defineConfig({
  root: "web",
  server: { port: 5183, strictPort: true, fs: { allow: [".."] } },
  build: { outDir: "../build/web", emptyOutDir: true, target: "es2022",
    rollupOptions: { input: { landing: "web/index.html", app: "web/app/index.html" } } },
});
