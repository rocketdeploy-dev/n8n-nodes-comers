import { defineConfig } from 'vitest/config';

export default defineConfig({
	// n8n-workflow ships source maps that point at sources it does not ship.
	// That is harmless and not ours to fix, but Vite warns about every one of
	// them, which buries the test results in CI.
	logLevel: 'error',
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
	},
});
