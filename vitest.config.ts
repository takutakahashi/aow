import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 10_000,
  },
});
