export const UI_PATHS: readonly string[]
export const UI_SOURCE_PROOF_FILENAME: string

export interface UiSourceProof {
  readonly digest: string
  readonly proof: string
  readonly paths: readonly string[]
}

export function captureUiSource(workspace: string): UiSourceProof
