import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/settings.ts"],
      thresholds: {
        // Lines/statements/functions stay at 95. Branch coverage is allowed
        // to dip to 94 because the streaming + recording delegates each have
        // a couple of defensive null/undefined-check branches that only fire
        // under conditions iOS / HAP-NodeJS won't reproduce in unit tests
        // (e.g. iOS misordering prepareStream/startStream). Tightening these
        // would require mocking the entire HAP camera stack.
        lines: 95,
        branches: 94,
        functions: 95,
        statements: 95,
      },
    },
  },
});
