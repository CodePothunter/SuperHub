import { defineConfig } from 'tsdown'
import { browserArtwork } from '../tsdown.config.ts'
export default defineConfig({ entry: { preview: './main.tsx' }, outDir: '.', format: 'iife', platform: 'browser', dts: false, clean: false,
  inputOptions: browserArtwork, deps: { alwaysBundle: [/./] }, outputOptions: { entryFileNames: 'preview.js' }, define: { 'process.env.NODE_ENV': '"production"' } })
