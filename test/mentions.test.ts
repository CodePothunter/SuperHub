import { describe, expect, it } from 'vitest'
import { ALL_WORDS, mentionSegments, mentionSpans, nameProblem, parseMentions, referenceSpans } from '../src/core/mentions.ts'

// DS-Bot test/mention-rule.test.js 的成员表。
const bots = [{ id: 'a', name: '新 Bot' }, { id: 'b', name: '新 Bot 2' }, { id: 'c', name: 'Chief' }, { id: 'k', name: 'K' }]
const called = (text: string) => mentionSpans(text, bots).map(span => (span.all ? '@all' : span.member!.name))
// DS-Bot test/groups.test.js 的成员表。
const members = [{ id: 'm', name: 'M' }, { id: 'mx', name: 'Mx' }, { id: 'k', name: 'K' }, { id: 'w', name: 'Writer' }]
const names = (text: string, references: string[] = []) => {
  const { ids, all } = parseMentions(text, members, { references })
  return { all, found: ids.map(id => members.find(member => member.id === id)!.name) }
}
const staff = [{ id: 'liaison', name: '接口人' }, { id: 'eng', name: '工程师' }, { id: 'res', name: '研究员' }, { id: 'adv', name: '谋士' }]

describe('mention rule (ported from DS-Bot mention-rule.test.js)', () => {
  it('a name may hold spaces, and the longest name wins', () => {
    expect(called('@新 Bot 提权')).toEqual(['新 Bot'])
    expect(called('@新 Bot 2 和 @新 Bot，还有@chief')).toEqual(['新 Bot 2', '新 Bot', 'Chief'])
    expect(called('@Kate 不是 K，@K你好')).toEqual(['K'])
    expect(called('@everyone @所有人')).toEqual(['@all', '@all'])
  })

  it('addresses, code and links never call', () => {
    expect(called('mail a@K.com')).toEqual([])
    expect(called('run `@Chief` now')).toEqual([])
    expect(called('```\n@Chief\n```\n@K')).toEqual(['K'])
    expect(called('[@Chief](https://example.com) @K')).toEqual(['K'])
    expect(called('[read @Chief](https://example.com "docs") @K')).toEqual(['K'])
    expect(called("[read @Chief](https://example.com 'docs')")).toEqual([])
    expect(called('https://medium.com/@Chief')).toEqual([])
  })

  it('a file or folder reference that starts with a member name is not a call', () => {
    expect(called('看 @Chief.md 和 @chief/notes.md、@Chief\\a.txt')).toEqual([])
    expect(called('@Chief. @K。@Chief...')).toEqual(['Chief', 'K', 'Chief'])
  })

  it('a referenced conversation\'s "@label" is a reference, once per label', () => {
    expect(referenceSpans('see @K notes and @K', ['K notes'])).toEqual([{ start: 4, end: 12, label: 'K notes' }])
    expect(mentionSpans('Read @Chief, then @Chief please', bots, { references: ['Chief'] }).map(span => span.start)).toEqual([18])
  })

  it('the bubble segments keep the text around a mention and call the same members as the host', () => {
    expect(mentionSegments('@新 Bot 提权', bots)).toEqual([{ memberId: 'a', label: '新 Bot' }, { text: ' 提权' }])
    expect(mentionSegments('看 @a/b.md', bots)).toEqual([{ text: '看 @a/b.md' }])
    expect(mentionSegments('打开 @K.md', bots)).toEqual([{ text: '打开 @K.md' }])
    for (const text of ['@新 Bot 提权', '@新 Bot 2 来一下', 'a@K.com @K', '`@Chief` @新 Bot', '@Chief，@K。', '@Chief.md @K', '[see @K](https://x.dev "t") @Chief']) {
      const drawn = mentionSegments(text, bots).flatMap(part => 'memberId' in part ? [part.memberId] : [])
      expect(drawn, text).toEqual(parseMentions(text, bots).ids)
    }
  })

  it('a member name is something "@" can call without a second reading', () => {
    expect(nameProblem('新 Bot')).toBeUndefined()
    expect(nameProblem('  ')).toBe('成员需要名字')
    for (const name of ['a@b', 'x`y', 'two\nlines']) expect(nameProblem(name)).toBe('成员名不能含 @、` 或换行')
    for (const word of [...ALL_WORDS, 'All', '全体']) expect(nameProblem(word)).toMatch(/会叫到群里所有人/)
    for (const name of ['User', 'you', ' USER ']) expect(nameProblem(name)).toMatch(/代表主人/)
    expect(nameProblem('Users')).toBeUndefined()
  })
})

describe('parseMentions (ported from DS-Bot groups.test.js mentionsIn)', () => {
  it('finds members in order, longest name first, each once', () => {
    expect(names('@Mx and @M, then @writer')).toEqual({ all: false, found: ['Mx', 'M', 'Writer'] })
    expect(names('@K你好 @K again')).toEqual({ all: false, found: ['K'] })
    expect(names('@Kate is not K')).toEqual({ all: false, found: [] })
    expect(names('mail a@K.com')).toEqual({ all: false, found: [] })
    expect(names('@all please, @所有人')).toEqual({ all: true, found: [] })
    expect(names('@everyone and @M')).toEqual({ all: true, found: ['M'] })
    expect(names('no mentions')).toEqual({ all: false, found: [] })
  })

  it('a reference label is not a call, and takes out only its own "@label"', () => {
    expect(names('see @K notes, then @Writer', ['K notes', 'K'])).toEqual({ all: false, found: ['Writer'] })
    expect(names('@K notes')).toEqual({ all: false, found: ['K'] })
    expect(names('Read @Writer, then @Writer please answer.', ['Writer'])).toEqual({ all: false, found: ['Writer'] })
    expect(names('see @Writer', ['Writer'])).toEqual({ all: false, found: [] })
    expect(names('@K notes and @K', ['K notes'])).toEqual({ all: false, found: ['K'] })
  })

  it('drops the speaker when asked, after matching against everyone', () => {
    const roster = [{ id: 'a', name: '新 Bot' }, { id: 'b', name: '新 Bot 2' }]
    // 新 Bot 2 说「@新 Bot 2」不会被读成叫「新 Bot」。
    expect(parseMentions('我是 @新 Bot 2', roster, { except: 'b' })).toEqual({ ids: [], all: false })
    expect(parseMentions('@新 Bot 2 @新 Bot', roster, { except: 'b' })).toEqual({ ids: ['a'], all: false })
  })
})

describe('mention rule in Chinese group chat', () => {
  it('calls staff by Chinese name, case-insensitively and with all-words', () => {
    expect(parseMentions('@工程师 看一下 arkcli，@研究员查资料', staff)).toEqual({ ids: ['eng', 'res'], all: false })
    expect(parseMentions('@所有人 开会', staff)).toEqual({ ids: [], all: true })
    expect(parseMentions('@ALL 注意', staff)).toEqual({ ids: [], all: true })
    expect(parseMentions('@全体成员', staff).all).toBe(true)
    expect(parseMentions('谋士你怎么看', staff)).toEqual({ ids: [], all: false })
  })

  it('a member name shadows an all-word only when it is a member (member names are matched first)', () => {
    expect(parseMentions('@Alla 你好', [{ id: 'x', name: 'Alla' }])).toEqual({ ids: ['x'], all: false })
  })

  it('bare URLs and quoted lines are literal text (SuperHub addition)', () => {
    expect(parseMentions('看 https://example.com/?u=@工程师 这个', staff).ids).toEqual([])
    expect(parseMentions('看 https://example.com，@工程师 跑一下', staff).ids).toEqual(['eng'])
    expect(parseMentions('(https://x.dev/a) @谋士', staff).ids).toEqual(['adv'])
    expect(parseMentions('> @工程师 去跑一下\n这句是之前说的，@研究员 你看呢', staff).ids).toEqual(['res'])
    expect(parseMentions('  > @工程师\n> @谋士', staff).ids).toEqual([])
  })

  it('segments render all-words too', () => {
    expect(mentionSegments('@所有人 看 @工程师', staff)).toEqual([{ all: true, label: '所有人' }, { text: ' 看 ' }, { memberId: 'eng', label: '工程师' }])
    expect(mentionSegments('', staff)).toEqual([])
  })
})
