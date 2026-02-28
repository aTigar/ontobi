import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'mcp',
          root: './packages/mcp',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
})
