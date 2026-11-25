import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'tsdown'
import { browserArtwork } from '../tsdown.config.ts'

// The historical reader has its own navigation. Packaged Web and mobile entry points have a separate acceptance suite.
const outDir = mkdtempSync(join(tmpdir(), 'chief-record-reader-'))
await build({
  config: false, entry: { app: 'preview/record-reader.tsx' }, outDir, format: 'iife',
  platform: 'browser', dts: false, minify: true, clean: false, deps: { alwaysBundle: [/./] },
  inputOptions: browserArtwork,
  outputOptions: { entryFileNames: 'app.js' }, define: { 'process.env.NODE_ENV': '"production"', __BUILD__: '"dev"' },
})
export function recordAsset(name) {
  return name === 'app.js' ? join(outDir, name) : join(process.env.CHIEF_LIB_DIR ?? 'lib', 'mobile', name)
}
