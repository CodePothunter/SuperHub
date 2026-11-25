export const SUPERHUB_PREFIXES: readonly string[]
export const SOURCE_KINDS: readonly string[]
export const TEST_DIR_PREFIXES: readonly string[]
export const TEST_DIR_NAMES: readonly RegExp[]
export function acceptanceRoots(home: string): string[]
export function underAcceptanceRoot(path: unknown, roots: readonly string[]): boolean
export function inTestDirectory(path: unknown, roots: readonly string[]): boolean
export function isSuperhubPreview(preview: unknown): boolean
export function codexRollout(path: unknown, codexHome: string): boolean
export function claudeProjectName(path: string): string
export function isClaudeAcceptanceDir(name: string, roots: readonly string[]): boolean
export function isClaudeTestDirName(name: string, roots: readonly string[]): boolean
export function claudeRecordedCwds(dir: string, limit?: number): string[]

export interface ConfigSection { path: string; start: number; end: number; temporary: boolean }
export interface ConfigPlan {
  sections: ConfigSection[]
  remove: ConfigSection[]
  keep: ConfigSection[]
  problems: string[]
  text: string
  lines: string[]
}
export function planConfig(text: string, roots: readonly string[]): ConfigPlan
export function verifyConfig(original: string, plan: ConfigPlan, roots: readonly string[]): void

export interface CleanupOptions {
  apply?: boolean
  home?: string
  codexHome?: string
  claudeDir?: string
  codexBin?: string
  skipCodexThreads?: boolean
  /** Pack the Claude directories into a tarball before deleting them. */
  backup?: boolean
  now?: Date
  print?: (line: string) => void
}
export interface CodexThreadRow { id: string; cwd: string; archived: boolean; source: string; createdAt?: number; path?: string }
export interface CleanupSummary {
  apply: boolean
  roots: string[]
  codex?: { total: number; archivedTotal: number; superhub: number; selected: (CodexThreadRow & { reason: 'superhub' | 'test-dir' })[]; elsewhere: CodexThreadRow[];
    otherTemporary: (CodexThreadRow & { preview: string })[]; deleted: number; rolloutsRemoved: number; failed: { id: string; error: string }[] }
  claude: { total?: number; directories: string[]; elsewhere: { name: string; cwd: string }[]; otherTemporary: { name: string; cwd: string }[]; sessions: number; backup?: string; removed: number }
  config: { file: string; entries: string[]; kept: string[]; backup?: string; written: boolean }
  failures: string[]
}
export function cleanup(options?: CleanupOptions): Promise<CleanupSummary>
