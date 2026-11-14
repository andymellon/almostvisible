import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: false },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      // Two pages: the piece itself and the Resonant Matter material proof.
      input: {
        main: page('./index.html'),
        matter: page('./matter.html'),
      },
    },
  },
  test: {
    // Tests are pure (puzzle logic, and the audio engine against a fake Web Audio graph).
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
