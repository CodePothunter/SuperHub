export const INHERITED_TOOL_ENV: RegExp
export function withoutToolEnv(env: Record<string, string | undefined>): Record<string, string | undefined>
export function codexModelConfig(text: string): string
export function claudeLoginSettings(settings: unknown): { env?: Record<string, string>; model?: unknown; effortLevel?: unknown; modelSettings?: unknown }

export interface ToolHomesReport {
  codexAuth: 'unchanged' | 'written-back' | 'conflict' | 'missing'
  codexBackup?: string
  claudeLogin: 'unchanged' | 'changed'
  warnings: string[]
  removed?: boolean
}
export interface ToolHomes {
  root: string
  codexHome: string
  claudeConfigDir: string
  apply(env: Record<string, string | undefined>): Record<string, string | undefined>
  teardown(): ToolHomesReport
  /** Runs (synchronously) before the homes are removed, also on process exit. */
  onTeardown(stop: () => void): void
}
export function sweepStaleHomes(base: string, log?: (message: string) => void): (ToolHomesReport & { root: string })[]
export function isolateToolHomes(options?: {
  ownerHome?: string
  codexHome?: string
  claudeDir?: string
  base?: string
  env?: Record<string, string | undefined>
  log?: (message: string) => void
  onExit?: boolean
}): ToolHomes | undefined
