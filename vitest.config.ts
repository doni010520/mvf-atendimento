import { defineConfig } from "vitest/config";
import path from "node:path";

// Só testa as funções PURAS do app (formatação, classificação, cálculo de janela).
// Módulos que falam com Supabase/provider ficam de fora — são verificados por
// typecheck + build + teste manual.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
