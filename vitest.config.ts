import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// 只在 test/ 下发现本仓库的测试。
// CODEX_HOME 指向不存在的目录：编程会话读取 Codex 会话记录时不碰本机真实的 ~/.codex。
// globalSetup：本次运行专用的临时根目录，结束（含失败与中断）后整体删除，测试不在 /tmp 留下任何目录。
export default defineConfig({ test: { include: ['test/**/*.{test,spec}.{ts,tsx,js,mjs,jsx}'], globalSetup: ['test/global-temp.ts'],
  env: { CODEX_HOME: join(tmpdir(), 'chief-test-no-codex-home') } } })
