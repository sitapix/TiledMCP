import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * This suite boots MCP servers in-memory, spawns real Node subprocesses,
     * rasterises PNGs through sharp and regenerates a 4 MB contract twice.
     * Vitest's 5s default acts as a per-test performance budget those cannot
     * meet under parallel load, and it was surfacing as timeouts in a
     * different test almost every run -- noise that trains people to ignore
     * a red suite.
     *
     * 30s is still a hang detector: nothing here legitimately runs that long
     * (the slowest observed test is ~21s under full contention). Tests that
     * need longer keep their own explicit timeout argument.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
