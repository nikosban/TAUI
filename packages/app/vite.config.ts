import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consume core from source in dev so edits are picked up without a rebuild.
    // The published `exports` map is exercised separately by `pnpm lint:pkg`.
    alias: { "@tui-designer/core": new URL("../core/src/index.ts", import.meta.url).pathname },
  },
  server: { port: 5273 },
});
