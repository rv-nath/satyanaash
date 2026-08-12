import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    /**
     * 8081, because 8080 is a krakend port-forward on the dev box.
     *
     * `strictPort` so a clash fails loudly instead of Vite silently moving to the next free
     * port. A dev server that quietly rehomes itself hands out URLs that don't work and
     * bookmarks that stop matching — and you only find out by reading the startup banner you
     * had no reason to read. Override for a one-off with `npm run dev -- --port 9090`, or
     * permanently with `PORT=9090`.
     */
    port: Number(process.env.PORT) || 8081,
    strictPort: true,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
