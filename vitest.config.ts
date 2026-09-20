import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts'], exclude: ['**/node_modules/**', 'callsign/**', 'codis-cove/**'], environment: 'node', testTimeout: 30000 } });
