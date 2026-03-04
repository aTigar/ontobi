import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
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
