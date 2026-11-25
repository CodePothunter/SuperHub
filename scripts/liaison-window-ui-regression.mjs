/**
 * The liaison is the owner's single entry, so its dialog is a working window rather than a form-sized popup:
 * min(960px, 100vw - 48px) wide and min(88dvh, 940px) tall on desktop, the full screen at 640px and below. Other
 * dialogs keep their 570px width. Runs on the desktop DSH frame and the authenticated phone gateway.
 * CHIEF_ACCEPTANCE_PACKAGE=<tgz> CHIEF_PLAYWRIGHT_PATH=<playwright/index.mjs> [CHIEF_CHROMIUM_PATH=<binary>]
 * [CHIEF_SCREENSHOT_DIR=<dir>] node scripts/liaison-window-ui-regression.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { button, signIn } from './workspace-browser-fixture.mjs'

const area = mkdtempSync(join(tmpdir(), 'chief-liaison-window-ui-'))
const shots = process.env.CHIEF_SCREENSHOT_DIR
if (shots) mkdirSync(shots, { recursive: true })
const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 1.5, `${what}：实际 ${actual}，应为 ${expected}`)
const long = '请把这段很长的说明完整保留：' + '接口人窗口应当能舒适地阅读长段落，'.repeat(12) + ' https://example.invalid/' + 'a'.repeat(160)

let browser, host
try {
  host = await acceptanceHost({ directory: area, mobile: true, probe: 'workspace-v2-probe.mjs' })
  await host.start()
  await host.api('/pause', { paused: true })
  const scope = (await host.api('/v2/bootstrap')).scope
  const password = randomUUID()
  await host.api('/settings/password', { password })
  browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH && { executablePath: process.env.CHIEF_CHROMIUM_PATH }) })

  /** Open the liaison from the header, measure it in the frame that renders it, then close it with Escape. */
  async function measure(page, label, { sendLong = false } = {}) {
    const opener = page.getByRole('button', { name: /^一句话交办(，|$)/ }).first()
    await opener.click()
    const dialog = page.getByRole('dialog', { name: '接口人' })
    await dialog.waitFor()
    const text = dialog.getByRole('textbox', { name: '对接口人说', exact: true })
    await until(async () => text.isEnabled(), '接口人输入框可用')
    if (sendLong) {
      await text.fill(long)
      await text.press('Enter')
      await dialog.locator('.v2-turn.mine').filter({ hasText: '请把这段很长的说明完整保留' }).first().waitFor()
    }
    const box = await dialog.evaluate(node => {
      const rect = node.getBoundingClientRect(), history = node.querySelector('.v2-liaison-history')
      const bubble = node.querySelector('.v2-turn.mine .v2-message')
      return { width: rect.width, height: rect.height, left: rect.left, top: rect.top, vw: innerWidth, vh: innerHeight,
        history: history.getBoundingClientRect().height, overflow: history.scrollWidth - history.clientWidth,
        bubble: bubble ? bubble.getBoundingClientRect().width : 0, font: parseFloat(getComputedStyle(node).fontSize) }
    })
    if (shots) await page.screenshot({ path: join(shots, `liaison-${label}.png`) })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    await until(() => opener.evaluate(node => node === document.activeElement), 'Escape 关闭后焦点回到「一句话交办」')
    return box
  }

  // Desktop DSH frame: wide and tall, and other dialogs unchanged.
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768]]) {
    const page = await browser.newPage({ viewport: { width, height }, locale: 'zh-CN' })
    page.setDefaultTimeout(20_000)
    await signIn(page, host)
    await page.goto(host.base + '/#v2?' + new URLSearchParams({ scope, view: 'today' }))
    await page.getByRole('heading', { name: '我的工作区', exact: true }).waitFor()
    const box = await measure(page, `${width}x${height}`, { sendLong: width === 1440 })
    near(box.width, Math.min(960, box.vw - 48), `${width}px 下接口人宽度`)
    near(box.height, Math.min(box.vh * 0.88, 940), `${width}px 下接口人高度`)
    assert.ok(box.history >= box.height * 0.5, `对话区应占弹窗主体：${box.history}/${box.height}`)
    assert.ok(box.overflow <= 0, '长文本不横向溢出')
    if (width === 1440) {
      assert.ok(box.bubble > 0 && box.bubble <= 55 * box.font * 0.7 + 60, `气泡仍守 55ch 阅读宽度：${box.bubble}`)
      await button(page, '创建工作区').click()
      const form = page.getByRole('dialog', { name: '创建工作区' })
      await form.waitFor()
      near(await form.evaluate(node => node.getBoundingClientRect().width), 570, '其他弹窗宽度不变')
      await page.keyboard.press('Escape')
      await form.waitFor({ state: 'detached' })
    }
    console.log(`PASS desktop ${width}x${height}`, JSON.stringify(box))
    await page.close()
  }

  // Phone gateway: the liaison takes the whole screen; dark theme on one size.
  for (const [width, height, scheme] of [[390, 844, 'light'], [360, 740, 'dark']]) {
    const page = await browser.newPage({ viewport: { width, height }, locale: 'zh-CN', isMobile: true, hasTouch: true, colorScheme: scheme })
    page.setDefaultTimeout(20_000)
    await page.goto(host.mobileBase)
    await page.getByLabel('密码').fill(password)
    await button(page, '进入').click()
    await page.getByRole('heading', { name: '今天', exact: true }).waitFor()
    const box = await measure(page, `${width}x${height}-${scheme}`)
    near(box.width, box.vw, `${width}px 手机全屏宽度`)
    near(box.height, box.vh, `${width}px 手机全屏高度`)
    near(box.left, 0, '全屏面板贴左'); near(box.top, 0, '全屏面板贴顶')
    assert.ok(box.overflow <= 0, '手机上不横向溢出')
    console.log(`PASS phone ${width}x${height} ${scheme}`, JSON.stringify(box))
    await page.close()
  }
  console.log('PASS liaison window regression')
} finally {
  await browser?.close()
  await host?.dispose()
  rmSync(area, { recursive: true, force: true })
}
