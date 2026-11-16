import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "/client-demo/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  define: { __APP_VERSION__: JSON.stringify("website-demo") },
  build: {
    outDir: "dist-client-demo",
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./client-demo.html", import.meta.url)) },
  },
});
