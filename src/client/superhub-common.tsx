import { timeLabel } from './superhub-api.ts'

export function ReadIssue({ error, at, retry }: { error?: string; at?: string; retry?: () => void }) {
  if (!error) return null
  return <p className="hub-error" role="status">{error}{at && <> · 保留 {timeLabel(at)} 读取的快照</>}{retry && <> <button type="button" onClick={retry}>重试读取</button></>}</p>
}
