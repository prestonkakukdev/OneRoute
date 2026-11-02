import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests run code sessions; keep them from touching the real OneRoute's record of active runs.
    env: { ONEROUTE_ACTIVE_RUNS_FILE: join(tmpdir(), `oneroute-test-active-runs-${process.pid}.json`) },
  },
});
