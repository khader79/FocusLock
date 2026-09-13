import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    benchmark: {
      reporters: ['basic'],
    },
    include: ['src/**/*.{test,spec}.ts'],
    benchInclude: ['src/**/*.bench.ts'],
  },
})