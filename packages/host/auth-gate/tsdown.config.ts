import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js'],
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  outDir: 'lib',
  clean: false,
  external: [/^@deepseek-ai\//],
})
