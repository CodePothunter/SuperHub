/**
 * 第二大脑里只属于主人本机的数据目录：不进 git 提交，也不经资料视图读出。
 * 单独成文件、不引第三方依赖，免依赖回归（scripts/workflow-regression.mjs）也能加载。
 */
import { PROFILE_IMPORT_FOLDER } from './profile-import-files.ts'
import { LIAISON_SEEN_FILE } from './liaison-seen.ts'

/** 群聊上线迁移的清单与逐项日志（`ops/superhub-group-migration/`）：列着要删的旧会话与原生会话，只留在本机。 */
export const GROUP_MIGRATION_FOLDER = 'superhub-group-migration'
export const CHAT_INPUT_FOLDER = 'chat-input-attachments'

/** 接口人已读点随主人每次打开对话变化，也只属于本机，不进 git。 */
export const PRIVATE_OPS = [PROFILE_IMPORT_FOLDER, 'legacy-order-cleanup', 'legacy-order-cleanup.pending', LIAISON_SEEN_FILE, GROUP_MIGRATION_FOLDER, CHAT_INPUT_FOLDER, 'superhub-experience-learning']

export function privateBrainData(parts: readonly string[]): boolean {
  return parts[0] === 'ops' && PRIVATE_OPS.some(name => name === parts[1])
}
