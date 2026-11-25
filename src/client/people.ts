/** 组织是主归属；旧卡和清空归属的卡统一放进未分组，不从团队或关系标签推断。 */
export function groupPeople<T extends { organization?: string }>(people: readonly T[]): { key: string; label: string; people: T[] }[] {
  const organizations = new Map<string, T[]>()
  const ungrouped: T[] = []
  for (const person of people) {
    const name = person.organization?.trim()
    if (!name) { ungrouped.push(person); continue }
    const members = organizations.get(name) ?? []
    members.push(person); organizations.set(name, members)
  }
  return [
    ...[...organizations].sort(([a], [b]) => a.localeCompare(b, 'zh')).map(([name, members]) => ({ key: `organization:${name}`, label: name, people: members })),
    ...ungrouped.length ? [{ key: 'ungrouped', label: '未分组', people: ungrouped }] : [],
  ]
}
