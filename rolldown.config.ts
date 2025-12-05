import { defineConfig } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';

import { dependencies } from './package.json';

const basic = defineConfig({
  input: {
    index: 'src/index.ts'
  },
  platform: 'node',
  treeshake: true,
  external: Object.keys(dependencies || {}).concat(/^@gquittet\/graceful-server/i)
});

export default defineConfig([
  {
    ...basic,
    output: {
      dir: 'dist',
      format: 'commonjs',
      exports: 'named',
      cleanDir: true,
      chunkFileNames: `chunk.js`,
      entryFileNames: '[name].js'
    }
  },
  {
    ...basic,
    plugins: [
      dts({
        emitDtsOnly: true,
        compilerOptions: { removeComments: false }
      })
    ],
    output: {
      dir: 'dist',
      format: 'esm',
      chunkFileNames: `chunk.js`,
      entryFileNames: '[name].js'
    }
  }
]);
