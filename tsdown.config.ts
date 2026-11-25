import { cpSync, mkdirSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/** 每次打包一个编号：作战台据此发现新版本并自动刷新。 */
const build = process.env.CHIEF_BUILD_ID || new Date().toISOString()
const out = process.env.CHIEF_OUT_DIR || 'lib'
// Both browser entries are single scripts, including artwork on offline mobile clients.
export const browserArtwork = { moduleTypes: { '.webp': 'dataurl', '.svg': 'dataurl' } } as const

export default defineConfig([
  // Host 侧：ESM，yaml 打包进来，运行时不需要额外依赖。
  { entry: { index: 'src/index.ts' }, outDir: out, format: 'esm', platform: 'node', target: 'es2024', dts: false, clean: false, define: { __BUILD__: JSON.stringify(build) },
    fixedExtension: false, deps: { neverBundle: [/^@deepseek-ai\//], alwaysBundle: ['yaml', 'ical.js'] } },
  // 编程工具的命令把关钩子（Codex / Claude Code 的 PreToolUse）：独立脚本，连同分类器一起打包，启动要快。
  { entry: { 'coding-gate-hook': 'src/hook/coding-gate-hook.ts' }, outDir: out, format: 'esm', platform: 'node', target: 'es2024', dts: false, clean: false, fixedExtension: false },
  // 命令行用的导出逻辑（bin/cli.mjs 的 export 子命令）：纯函数，不依赖 DSH。
  { entry: { export: 'src/core/export.ts' }, outDir: out, format: 'esm', platform: 'node', target: 'es2024', dts: false, clean: false, fixedExtension: false },
  { entry: { 'legacy-order-cleanup': 'src/dsh/legacy-order-cleanup.ts' }, outDir: out, format: 'esm', platform: 'node', target: 'es2024', dts: false, clean: false, fixedExtension: false },
  // 浏览器侧：按 DSH Web 的模块加载器约定输出 CJS，React 由宿主提供（与官方 superagent 原型相同的包装方式）。
  { entry: { client: 'src/client/index.tsx' }, outDir: out, format: 'cjs', platform: 'browser', dts: false, clean: false, define: { __BUILD__: JSON.stringify(build) },
    inputOptions: browserArtwork,
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-chief", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    } },
  // 手机页面（手机访问端口提供）：React 一起打包成单个文件，静态文件一并复制。
  { entry: { app: 'src/mobile/main.tsx' }, outDir: `${out}/mobile`, format: 'iife', platform: 'browser', dts: false, clean: false, minify: true,
    inputOptions: browserArtwork,
    deps: { alwaysBundle: [/./] }, outputOptions: { entryFileNames: 'app.js' }, define: { 'process.env.NODE_ENV': '"production"', __BUILD__: JSON.stringify(build) },
    hooks: { 'build:done': () => { mkdirSync(`${out}/mobile`, { recursive: true }); cpSync('src/mobile/public', `${out}/mobile`, { recursive: true }) } } },
])
