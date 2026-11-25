import mark from './artwork/hub-small.svg'

export const WORKSPACE_NAME = 'SuperHub'
export const OVERVIEW_NAME = '工作总览'
export const RETURN_TO_DSH = '返回 DSH'
export const DECISIONS_NAME = '等你决定'
export const NO_DECISIONS = '目前没有等你决定的事项。'

export function WorkspaceMark({ size = 25 }: { size?: number }) {
  return <img src={mark} width={size} height={size} alt="" aria-hidden="true"/>
}
