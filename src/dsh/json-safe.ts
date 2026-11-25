/**
 * DSH 工具管道只接受“无损 JSON”返回值（@deepseek-ai/dsh-util-values 的 walkJsonValue）：
 * null、布尔、字符串、有限数（不含 -0）、普通对象与稠密普通数组，不含循环引用、符号键、不可枚举键。
 * 这里按同一规则检查。jsonSafe 只做一件改写：省略对象里值为 undefined 的属性（JSON.stringify 的语义）；
 * 其余无法无损表示的值按路径报错，不静默改写。
 */

export interface JsonViolation { path: string; reason: string }

const isIntrinsicObjectPrototype = (value: object) => {
  if (Object.getPrototypeOf(value) !== null) return false
  const constructor = Object.getOwnPropertyDescriptor(value, 'constructor')?.value as unknown
  return typeof constructor === 'function' && constructor.name === 'Object' && constructor.prototype === value
}

const plainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === null || isIntrinsicObjectPrototype(prototype)
}

const plainArray = (value: unknown[]) => {
  const prototype = Object.getPrototypeOf(value) as unknown
  if (!Array.isArray(prototype)) return false
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value as unknown
  const objectPrototype = Object.getPrototypeOf(prototype) as object | null
  return typeof constructor === 'function' && constructor.name === 'Array' && constructor.prototype === prototype
    && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype)
}

const describe = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value)
  if (typeof value === 'bigint') return 'bigint'
  if (typeof value === 'function') return '函数'
  if (typeof value === 'symbol') return 'symbol'
  const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name
  return name ? `${name} 对象` : '非普通对象'
}

const childPath = (path: string, key: string | number) =>
  typeof key === 'number' ? `${path}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`

/**
 * 走一遍值。omitUndefined 为真时，对象属性里的 undefined 被省略（数组里的 undefined 仍是错误）。
 * 返回副本（仅在 copy 时）与发现的违规。
 */
function walk(value: unknown, omitUndefined: boolean): { copy: unknown; violations: JsonViolation[] } {
  const violations: JsonViolation[] = []
  const ancestors = new Set<object>()
  const visit = (current: unknown, path: string): unknown => {
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return current
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) violations.push({ path, reason: `${describe(current)} 不是有限 JSON 数` })
      return current
    }
    if (typeof current !== 'object') {
      violations.push({ path, reason: `${describe(current)} 不能表示为 JSON` })
      return undefined
    }
    if (ancestors.has(current)) {
      violations.push({ path, reason: '循环引用' })
      return undefined
    }
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        if (!plainArray(current)) { violations.push({ path, reason: `${describe(current)} 不是普通数组` }); return undefined }
        const keys = Reflect.ownKeys(current)
        if (keys.length !== current.length + 1) violations.push({ path, reason: '数组有空位或额外属性' })
        const out: unknown[] = []
        for (let index = 0; index < current.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) continue
          out.push(visit(current[index], childPath(path, index)))
        }
        return out
      }
      if (!plainObject(current)) { violations.push({ path, reason: `${describe(current)} 不是普通对象` }); return undefined }
      const out: Record<string, unknown> = {}
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== 'string') { violations.push({ path, reason: '含 symbol 键' }); continue }
        if (!Object.prototype.propertyIsEnumerable.call(current, key)) { violations.push({ path: childPath(path, key), reason: '不可枚举的属性' }); continue }
        const item = (current as Record<string, unknown>)[key]
        if (item === undefined && omitUndefined) continue
        Object.defineProperty(out, key, { value: visit(item, childPath(path, key)), enumerable: true, configurable: true, writable: true })
      }
      return out
    } finally {
      ancestors.delete(current)
    }
  }
  const copy = visit(value, 'value')
  return { copy, violations }
}

/** 与 DSH 工具管道相同的无损 JSON 检查；空数组表示可以原样交给 DSH。 */
export function losslessViolations(value: unknown): JsonViolation[] {
  return walk(value, false).violations
}

/** 工具出口：省略对象中的 undefined 属性，其余不能无损表示的值按路径报错。字符串原样返回。 */
export function jsonSafe<T>(value: T, tool: string): T {
  if (typeof value === 'string') return value
  const { copy, violations } = walk(value, true)
  if (violations.length) {
    const [first] = violations
    throw new Error(`工具 ${tool} 返回值 ${first!.path} 不是 JSON：${first!.reason}${violations.length > 1 ? `（另有 ${violations.length - 1} 处）` : ''}`)
  }
  return copy as T
}
