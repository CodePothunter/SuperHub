/**
 * Risk of one command or tool call run by a coding tool on the owner's machine. Pure and dependency-free, so the
 * command gate and its hook script classify with exactly the same rules (the hook falls back to it when the gate
 * cannot be reached).
 *
 * Only a short list counts as high risk: deleting, irreversible Git, installing or removing packages, privilege
 * and system control, piping a remote script into a shell, cloud writes and paid inference. Everything else is
 * normal and runs in every tier. Text that cannot be read reliably (`eval`, a listed verb nested in a command
 * substitution, `base64 … | sh`) is high risk.
 *
 * Quoted text is an argument, not a command: `echo "rm -rf /"` is normal, while `bash -c "rm -rf x"` is high
 * because the shell runs its `-c` string, which is classified again.
 */
export type CodingRiskLevel = 'high' | 'normal'
export interface CodingRisk { risk: CodingRiskLevel; reason: string }

const NORMAL: CodingRisk = { risk: 'normal', reason: '不在高危清单内' }
const high = (reason: string): CodingRisk => ({ risk: 'high', reason })
const MAX_DEPTH = 6

interface Segment { words: string[]; piped: boolean }
interface Parsed { segments: Segment[]; substitutions: string[]; error?: string }

/** Split shell text into simple commands on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes. */
function parse(text: string): Parsed {
  const segments: Segment[] = [], substitutions: string[] = []
  let words: string[] = [], word = '', inWord = false, piped = false
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false }
  const endSegment = (nextPiped: boolean) => {
    endWord()
    if (words.length) segments.push({ words, piped })
    words = []
    piped = nextPiped
  }
  /** Read a `$(…)` body starting after `$(`; returns the index after the closing parenthesis. */
  const substitution = (start: number): number => {
    let depth = 1, i = start, quote = ''
    for (; i < text.length; i++) {
      const c = text[i]!
      if (quote) {
        if (c === '\\' && quote === '"') { i++; continue }
        if (c === quote) quote = ''
        continue
      }
      if (c === '\\') { i++; continue }
      if (c === '\'' || c === '"') { quote = c; continue }
      if (c === '(') depth++
      if (c === ')' && --depth === 0) break
    }
    substitutions.push(text.slice(start, i))
    return i + 1
  }
  const backtick = (start: number): number => {
    let i = start
    for (; i < text.length && text[i] !== '`'; i++) if (text[i] === '\\') i++
    substitutions.push(text.slice(start, i).replace(/\\(.)/g, '$1'))
    return i + 1
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '\\') {
      if (text[i + 1] === '\n') { i += 2; continue }
      word += text[i + 1] ?? ''; inWord = true; i += 2; continue
    }
    if (c === '\'') {
      const end = text.indexOf('\'', i + 1)
      if (end === -1) return { segments, substitutions, error: '引号未闭合' }
      word += text.slice(i + 1, end); inWord = true; i = end + 1; continue
    }
    if (c === '"') {
      inWord = true
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) { word += text[i + 1]; i += 2; continue }
        if (text[i] === '$' && text[i + 1] === '(') { const from = i; i = substitution(i + 2); word += text.slice(from, i); continue }
        if (text[i] === '`') { const from = i; i = backtick(i + 1); word += text.slice(from, i); continue }
        word += text[i]; i++
      }
      if (i >= text.length) return { segments, substitutions, error: '引号未闭合' }
      i++
      continue
    }
    if (c === '$' && text[i + 1] === '(') { const from = i; i = substitution(i + 2); word += text.slice(from, i); inWord = true; continue }
    if ((c === '<' || c === '>') && text[i + 1] === '(') { const from = i; i = substitution(i + 2); word += text.slice(from, i); inWord = true; continue }
    if (c === '`') { const from = i; i = backtick(i + 1); word += text.slice(from, i); inWord = true; continue }
    if (c === '#' && !inWord) {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '\n' || c === ';') { endSegment(false); i++; continue }
    if (c === '&' && text[i + 1] === '&') { endSegment(false); i += 2; continue }
    if (c === '|' && text[i + 1] === '|') { endSegment(false); i += 2; continue }
    if (c === '|') { endSegment(true); i += text[i + 1] === '&' ? 2 : 1; continue }
    if (c === '&' && text[i + 1] !== '>' && !word.endsWith('>') && !word.endsWith('<')) { endSegment(false); i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue }
    // Subshells run their contents like any other command list.
    if (c === ')' || c === '(' && !inWord) { endSegment(false); i++; continue }
    word += c; inWord = true; i++
  }
  endSegment(false)
  return { segments, substitutions }
}

const base = (word: string) => word.slice(word.lastIndexOf('/') + 1)
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const REMOTE_SUBSTITUTION = /(?:\$\(|`)\s*(?:\S*\/)?(?:curl|wget)\b/
const isFlag = (word: string) => word.startsWith('-')
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECT = /^\d*(?:>>?|<<?<?|&>>?|>&|<&)(?!\()/

/** Drop redirections (`>out`, `2>&1`, `< in`) so they are not mistaken for arguments. */
function withoutRedirects(words: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const match = REDIRECT.exec(word)
    if (match) { if (match[0] === word) i++; continue }
    out.push(word)
  }
  return out
}

/** Strip harmless launchers so the command they start is judged. Returns the remaining words. */
function unwrapLaunchers(words: string[]): string[] {
  let rest = words
  for (let guard = 0; guard < 8 && rest.length; guard++) {
    // Leading assignments, group braces, negation and compound-command keywords (`if …; then rm x; fi`,
    // `for …; do rm $f; done`) do not change which command runs.
    while (rest.length && (ASSIGNMENT.test(rest[0]!) || KEYWORDS.has(rest[0]!))) rest = rest.slice(1)
    const name = base(rest[0] ?? '')
    if (['command', 'builtin', 'exec', 'nohup', 'time', 'setsid', 'stdbuf', 'ionice', 'chronic', 'busybox'].includes(name)) {
      rest = rest.slice(1)
      while (rest.length && isFlag(rest[0]!)) rest = rest.slice(rest[0] === '-n' || rest[0] === '-c' ? 2 : 1)
      continue
    }
    if (name === 'npx' || name === 'bunx') {
      rest = rest.slice(1)
      while (rest.length && isFlag(rest[0]!)) {
        // `npx -c "<shell text>"` runs the text in a shell.
        if (rest[0] === '-c' || rest[0] === '--call') return ['sh', '-c', ...rest.slice(1, 2)]
        rest = rest.slice(rest[0] === '-p' || rest[0] === '--package' ? 2 : 1)
      }
      continue
    }
    if (name === 'env') {
      rest = rest.slice(1)
      while (rest.length && (isFlag(rest[0]!) || ASSIGNMENT.test(rest[0]!))) rest = rest.slice(rest[0] === '-u' || rest[0] === '-C' ? 2 : 1)
      continue
    }
    if (name === 'nice') {
      rest = rest.slice(1)
      while (rest.length && isFlag(rest[0]!)) rest = rest.slice(rest[0] === '-n' ? 2 : 1)
      continue
    }
    if (name === 'timeout') {
      rest = rest.slice(1)
      while (rest.length && isFlag(rest[0]!)) rest = rest.slice(rest[0] === '-s' || rest[0] === '-k' ? 2 : 1)
      rest = rest.slice(1) // duration
      continue
    }
    if (name === 'xargs') {
      rest = rest.slice(1)
      while (rest.length && isFlag(rest[0]!)) rest = rest.slice(/^-[IdEsLnP]$/.test(rest[0]!) ? 2 : 1)
      continue
    }
    break
  }
  return rest
}

/** Words that open or continue a compound command; the command after them is what runs. */
const KEYWORDS = new Set(['{', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])

const ARK_VERBS = new Set(['create', 'delete', 'update', 'deploy', '+deploy', '+gen', '+chat', 'infer', 'train', '+new', '+new-agent', '+iterate', 'stop', 'start'])
const PACKAGE_VERBS: Record<string, Set<string>> = {
  npm: new Set(['install', 'i', 'add', 'ci', 'remove', 'rm', 'uninstall', 'un', 'r', 'isntall', 'in', 'update', 'up', 'upgrade']),
  pnpm: new Set(['add', 'install', 'i', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade']),
  yarn: new Set(['add', 'install', 'remove', 'upgrade', 'up']),
  bun: new Set(['add', 'install', 'i', 'remove', 'rm', 'update']),
  pip: new Set(['install', 'uninstall']),
  pip3: new Set(['install', 'uninstall']),
  pipx: new Set(['install', 'uninstall', 'reinstall']),
  apt: new Set(['install', 'remove', 'purge', 'reinstall', 'autoremove', 'upgrade', 'full-upgrade', 'dist-upgrade']),
  'apt-get': new Set(['install', 'remove', 'purge', 'reinstall', 'autoremove', 'upgrade', 'dist-upgrade']),
  dnf: new Set(['install', 'remove', 'erase', 'reinstall', 'upgrade', 'update']),
  yum: new Set(['install', 'remove', 'erase', 'reinstall', 'upgrade', 'update']),
  brew: new Set(['install', 'uninstall', 'remove', 'rm', 'reinstall', 'upgrade']),
  snap: new Set(['install', 'remove', 'refresh']),
  cargo: new Set(['install', 'uninstall', 'remove', 'rm']),
  go: new Set(['install']),
}
/** Package manager options that take a value before the subcommand (`npm --prefix dir install`). */
const PACKAGE_VALUE_OPTIONS = new Set(['--prefix', '-C', '--dir', '--cwd', '--filter', '-F', '--workspace', '-w', '--registry', '--userconfig', '--cache'])
const SYSTEMCTL_READ = new Set(['status', 'show', 'cat', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'help'])
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

function gitRisk(args: string[]): CodingRisk | undefined {
  let i = 0
  while (i < args.length && isFlag(args[i]!)) i += GIT_VALUE_OPTIONS.has(args[i]!) ? 2 : 1
  const sub = args[i], rest = args.slice(i + 1)
  const has = (...flags: string[]) => rest.some(arg => flags.includes(arg))
  const shortFlag = (letter: string) => rest.some(arg => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter))
  switch (sub) {
    case 'push': return high('不可逆的 Git 操作：git push')
    case 'reset': return has('--hard', '--merge', '--keep') ? high('不可逆的 Git 操作：git reset --hard') : undefined
    case 'branch':
      return shortFlag('D') || (has('-d', '--delete') && (shortFlag('f') || has('--force'))) ? high('不可逆的 Git 操作：强制删除分支') : undefined
    case 'checkout':
      return has('--', '.', '-f', '--force') ? high('不可逆的 Git 操作：git checkout 覆盖未提交修改') : undefined
    case 'restore':
      return rest.some(arg => arg === '--staged' || arg === '-S') && !rest.some(arg => arg === '--worktree' || arg === '-W')
        ? undefined : high('不可逆的 Git 操作：git restore 覆盖未提交修改')
    case 'clean': return shortFlag('f') || has('--force') ? high('删除文件：git clean -f') : undefined
    case 'switch': return shortFlag('f') || has('--force', '--discard-changes') ? high('不可逆的 Git 操作：git switch 丢弃未提交修改') : undefined
    case 'stash': return rest[0] === 'drop' || rest[0] === 'clear' ? high('不可逆的 Git 操作：git stash ' + rest[0]) : undefined
    default: return undefined
  }
}

function packageRisk(name: string, args: string[]): CodingRisk | undefined {
  if (name === 'uv' && args[0] === 'pip' && (args[1] === 'install' || args[1] === 'uninstall')) return high('安装或卸载软件包：uv pip ' + args[1])
  if (name === 'uv' && (args[0] === 'add' || args[0] === 'remove')) return high('安装或卸载软件包：uv ' + args[0])
  if ((name === 'uv' || name === 'uvx') && args[0] === 'tool' && (args[1] === 'install' || args[1] === 'uninstall')) return high('安装或卸载软件包：uv tool ' + args[1])
  if (/^python[0-9.]*$/.test(name)) {
    const m = args.indexOf('-m')
    if (m !== -1 && /^pip[0-9]?$/.test(args[m + 1] ?? '') && /^(install|uninstall)$/.test(args[m + 2] ?? '')) return high('安装或卸载软件包：pip ' + args[m + 2])
    return undefined
  }
  const verbs = PACKAGE_VERBS[name]
  if (!verbs) return undefined
  let at = 0
  while (at < args.length && isFlag(args[at]!)) at += PACKAGE_VALUE_OPTIONS.has(args[at]!) ? 2 : 1
  const sub = args[at]
  if (name === 'yarn' && sub === undefined) return high('安装或卸载软件包：yarn')
  if (name === 'npm' && sub === 'ci') return high('安装或卸载软件包：npm ci')
  return sub !== undefined && verbs.has(sub) ? high('安装或卸载软件包：' + name + ' ' + sub) : undefined
}

function killRisk(name: string, args: string[]): CodingRisk | undefined {
  if (name === 'pkill' || name === 'killall') return high('结束进程：' + name)
  if (name !== 'kill') return undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (/^-(9|KILL|SIGKILL)$/i.test(arg)) return high('强制结束进程：kill -9')
    if ((arg === '-s' || arg === '-n') && /^(9|KILL|SIGKILL)$/i.test(args[i + 1] ?? '')) return high('强制结束进程：kill -9')
  }
  return undefined
}

/** `feeders`: earlier commands of the same pipeline (`curl … | tee x | sh` feeds sh from curl). */
function segmentRisk(segment: Segment, feeders: readonly Segment[], depth: number): CodingRisk {
  const words = unwrapLaunchers(withoutRedirects(segment.words))
  if (!words.length) return NORMAL
  const name = base(words[0]!), args = words.slice(1)
  if (name === 'eval') return high('无法可靠解析的写法：eval')
  if (name === 'sudo' || name === 'su' || name === 'doas' || name === 'pkexec') return high('提权：' + name)
  if (SHELLS.has(name)) {
    // `bash <<< "rm -rf x"` runs the here-string.
    for (let i = 0; i < segment.words.length; i++) {
      const match = /^\d*<<</.exec(segment.words[i]!)
      if (!match) continue
      const body = segment.words[i] === match[0] ? segment.words[i + 1] : segment.words[i]!.slice(match[0].length)
      const inner = body === undefined ? undefined : classifyText(body, depth + 1)
      if (inner?.risk === 'high') return inner
    }
    const flag = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg))
    if (flag !== -1 && args[flag + 1] !== undefined) {
      // `bash -c "$(curl -fsSL …)"` runs whatever the download says.
      if (REMOTE_SUBSTITUTION.test(args[flag + 1]!)) return high('执行远程脚本：' + name + ' -c "$(curl …)"')
      const inner = classifyText(args[flag + 1]!, depth + 1)
      return inner.risk === 'high' ? inner : NORMAL
    }
    const script = args.includes('-s') ? undefined : args.find(arg => !isFlag(arg))
    if (script === undefined || script === '-' || script.startsWith('<(') || script.startsWith('/dev/stdin') || script.startsWith('/dev/fd/')) {
      for (const feeder of feeders) {
        const source = base(unwrapLaunchers(withoutRedirects(feeder.words))[0] ?? '')
        if (source === 'curl' || source === 'wget') return high('管道执行远程脚本：' + source + ' | ' + name)
        if (source === 'base64' || source === 'xxd' || source === 'openssl') return high('无法可靠解析的写法：' + source + ' | ' + name)
      }
      // Any other text piped into a shell (`echo "rm x" | sh`) runs as commands that cannot be read here.
      if (feeders.length) return high('无法可靠解析的写法：管道把文本交给 ' + name + ' 执行')
      if (script?.startsWith('<(') && /\b(curl|wget)\b/.test(script)) return high('执行远程脚本：' + name + ' <(curl …)')
    }
    return NORMAL
  }
  if ((name === 'source' || name === '.') && args.some(arg => arg.startsWith('<(') && /\b(curl|wget)\b/.test(arg))) return high('执行远程脚本：' + name + ' <(curl …)')
  if (['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'srm', 'rimraf'].includes(name)) return high('删除文件：' + name)
  if (name === 'find') {
    if (args.includes('-delete')) return high('删除文件：find -delete')
    // `find … -exec <command> {} ;` runs a command per file: judge that command.
    for (let i = 0; i < args.length; i++) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i]!)) continue
      let end = i + 1
      while (end < args.length && args[end] !== ';' && args[end] !== '+') end++
      const inner = segmentRisk({words: args.slice(i + 1, end), piped: false}, [], depth + 1)
      if (inner.risk === 'high') return inner
      i = end
    }
    return NORMAL
  }
  if (name === 'git') return gitRisk(args) ?? NORMAL
  const install = packageRisk(name, args)
  if (install) return install
  if (name === 'systemctl') {
    const sub = args.find(arg => !isFlag(arg))
    return sub !== undefined && SYSTEMCTL_READ.has(sub) ? NORMAL : high('系统服务操作：systemctl' + (sub ? ' ' + sub : ''))
  }
  if ((name === 'chmod' || name === 'chown' || name === 'chgrp') && args.some(arg => arg === '--recursive' || /^-[A-Za-z]*R/.test(arg))) return high('递归修改权限：' + name + ' -R')
  const kill = killRisk(name, args)
  if (kill) return kill
  if (name === 'arkcli') {
    const verb = args.find(arg => ARK_VERBS.has(arg))
    return verb ? high('云资源写操作或产生费用的推理：arkcli ' + verb) : NORMAL
  }
  if (name === 'kubectl') {
    const verb = args.find(arg => ['apply', 'delete', 'create', 'replace', 'patch', 'scale'].includes(arg))
    return verb ? high('云资源写操作：kubectl ' + verb) : NORMAL
  }
  if (name === 'terraform' || name === 'tofu') {
    const verb = args.find(arg => arg === 'apply' || arg === 'destroy')
    return verb ? high('云资源写操作：' + name + ' ' + verb) : NORMAL
  }
  if (name === 'docker' || name === 'podman') {
    const verb = args.find(arg => arg === 'rm' || arg === 'rmi' || arg === 'prune')
    return verb ? high('删除容器资源：' + name + ' ' + verb) : NORMAL
  }
  return NORMAL
}

function classifyText(text: string, depth: number): CodingRisk {
  if (depth > MAX_DEPTH) return high('无法可靠解析的写法：嵌套过深')
  const parsed = parse(text)
  if (parsed.error) return high('无法可靠解析的写法：' + parsed.error)
  for (const inner of parsed.substitutions) {
    const risk = classifyText(inner, depth + 1)
    if (risk.risk === 'high') return high('命令替换中嵌套高危操作：' + risk.reason)
  }
  for (let i = 0; i < parsed.segments.length; i++) {
    const feeders: Segment[] = []
    for (let j = i; j > 0 && parsed.segments[j]!.piped; j--) feeders.push(parsed.segments[j - 1]!)
    const risk = segmentRisk(parsed.segments[i]!, feeders, depth)
    if (risk.risk === 'high') return risk
  }
  return NORMAL
}

/** Shell text, or an argv array as some tools report it (`["bash", "-lc", "…"]`). */
export function classifyCommand(command: string | readonly string[]): CodingRisk {
  if (typeof command === 'string') return classifyText(command, 0)
  if (!command.length) return NORMAL
  const name = base(command[0]!)
  const flag = command.findIndex((arg, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(arg))
  if (SHELLS.has(name) && flag !== -1 && command[flag + 1] !== undefined) return classifyText(command[flag + 1]!, 0)
  return classifyText(command.map(arg => /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : '\'' + arg.replaceAll('\'', '\'\\\'\'') + '\'').join(' '), 0)
}

/** File, search and planning tools of Claude Code never count as commands. */
const NON_SHELL_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'ExitPlanMode', 'apply_patch'])

/** A hook request: shell tools carry `tool_input.command` (or `cmd`); other tools are normal. */
export function classifyToolCall(toolName: string, input: unknown): CodingRisk {
  if (NON_SHELL_TOOLS.has(toolName) || toolName.startsWith('mcp__')) return NORMAL
  const fields = input !== null && typeof input === 'object' ? input as Record<string, unknown> : undefined
  // Claude Code's Bash and Codex's shell send `command`; Codex's unified exec tool names it `cmd`.
  const command = fields?.command ?? fields?.cmd
  if (typeof command === 'string') return classifyCommand(command)
  // Codex's `write_stdin` types into a running process, e.g. an interactive shell.
  if (typeof fields?.chars === 'string') return classifyCommand(fields.chars)
  if (Array.isArray(command) && command.every(part => typeof part === 'string')) return classifyCommand(command as string[])
  return NORMAL
}

/** The command a shell wrapper runs (`/bin/bash -lc 'ls'` → `ls`), whitespace collapsed; used to pair records. */
export function commandBody(command: string | readonly string[]): string {
  let text: string
  if (typeof command === 'string') {
    const parsed = parse(command)
    const only = parsed.segments.length === 1 && !parsed.error ? parsed.segments[0]!.words : undefined
    const flag = only ? only.findIndex((arg, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(arg)) : -1
    text = only && SHELLS.has(base(only[0]!)) && flag !== -1 && only[flag + 1] !== undefined ? only[flag + 1]! : command
  } else {
    const flag = command.findIndex((arg, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(arg))
    text = command.length && SHELLS.has(base(command[0]!)) && flag !== -1 && command[flag + 1] !== undefined ? command[flag + 1]! : command.join(' ')
  }
  return text.replace(/\s+/g, ' ').trim()
}
