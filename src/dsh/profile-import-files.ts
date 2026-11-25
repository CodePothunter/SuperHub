import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProfileTargetVersion } from '../core/profile-import.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'

export const PROFILE_IMPORT_FOLDER = 'profile-imports'

export function profileDirectory(path: string, create = false): boolean {
  let found = lstatSync(path, {throwIfNoEntry: false})
  if (!found && create) {
    mkdirSync(path, {mode: 0o700})
    found = lstatSync(path)
  }
  if (!found) return false
  if (!found.isDirectory() || realpathSync(path) !== path) workspaceError(503, '个人资料目录不可用')
  return true
}

export function readProfileFile(path: string): {text: string; version: ProfileTargetVersion} {
  if (!profileDirectory(dirname(path))) return {text: '', version: 0}
  const found = lstatSync(path, {throwIfNoEntry: false})
  if (!found) return {text: '', version: 0}
  if (!found.isFile()) workspaceError(503, '个人资料文件不可用')
  const bytes = readFileSync(path)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) workspaceError(503, '个人资料文件不是有效的 UTF-8')
  return {text, version: workspaceFingerprint(text)}
}

export function writeProfileFile(path: string, text: string): void {
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temp, text, {flag: 'wx', mode: 0o600})
    renameSync(temp, path)
  } finally {
    if (lstatSync(temp, {throwIfNoEntry: false})) unlinkSync(temp)
  }
}
