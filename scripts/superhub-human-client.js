/* No product answers live in this client. Correctness is reviewed against server-side scenario facts. */
(() => {
  const $ = id => document.getElementById(id)
  const show = (id, yes = true) => { $(id).hidden = !yes }
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  let deviceId
  try { deviceId = localStorage.getItem('superhub-human-device') || randomId(); localStorage.setItem('superhub-human-device', deviceId) } catch { deviceId = randomId() }
  const documentId = randomId()
  let run, startAt, timer, prepared = false, productEvents = Promise.resolve()
  const viewport = () => ({ width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height, pixelRatio: devicePixelRatio })
  const request = async (path, value) => {
    const response = await fetch('/study/' + path, value === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-study-request': '1' },
      body: JSON.stringify({ documentId, ...value }) })
    const data = await response.json()
    if (!response.ok) throw Error(data.error || '操作失败，请重试')
    return data
  }
  const notice = error => { $('message').textContent = error?.message || ''; if (!$('lab').hidden) { $('toast').textContent = error?.message || ''; show('toast', !!error); setTimeout(() => show('toast', false), 7000) } }
  const busy = async (button, action) => { button.disabled = true; notice(); try { await action() } catch (error) { notice(error) } finally { button.disabled = false } }
  const home = () => { show('lab', false); show('answer', false); show('home'); clearInterval(timer); $('frame').removeAttribute('src') }
  const choices = () => { home(); for (const id of ['ready', 'preparing', 'finished', 'clock']) show(id, false); show('choices') }
  const completed = value => {
    run = value; home(); show('choices', false); show('finished'); show('resume', run.kind === 'review')
    $('resultText').textContent = `已记录 ${(run.elapsedMs / 1000).toFixed(1)} 秒${run.kind === 'review' ? '，复盘已保存到练习空间' : ''}。`
  }
  async function prepare(kind, button) {
    await busy(button, async () => {
      prepared = false
      show('choices', false); show('finished', false); show('ready', false); show('preparing')
      try {
        const result = await request('prepare', { kind }); run = result.run; prepared = true
        $('taskTitle').textContent = kind === 'locate' ? '快速定位 · 60 秒目标' : kind === 'review' ? '局势校准 · 5 分钟目标' : '找回刚才的工作'
        $('taskInstructions').textContent = kind === 'locate'
          ? `请查看“${run.goalName}”，找出目标负责人、目前的阻碍，以及关联工单在等谁做什么。找到后点击上方“填写答案”提交。`
          : kind === 'review'
            ? `请从“${run.goalName}”开始，核对这段工作的成果证据、尚未满足的条件和等待方。进入“局势校准”，选中这个目标，引用你核对过的交付版本，写出下一段重点与第一步，并保存三条复工线索。`
            : run.resumeTask
        show('ready')
      } finally { show('preparing', false); if (!prepared) show('choices') }
    })
  }
  $('loginForm').addEventListener('submit', event => { event.preventDefault(); void busy(event.submitter, async () => {
    await request('login', { code: $('accessCode').value }); $('accessCode').value = ''; show('login', false); show('registration')
  }) })
  $('registerForm').addEventListener('submit', event => { event.preventDefault(); void busy(event.submitter, async () => {
    const result = await request('register', { deviceId, participantCode: $('participantCode').value,
      device: $('device').value, experience: $('experience').value,
      physicalDevice: $('physical').checked, automation: navigator.webdriver === true, viewport: viewport(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    $('participant').textContent = `${result.participantId} · ${$('device').value === 'phone' ? '手机' : '电脑'}`
    show('registration', false); choices()
  }) })
  $('prepareLocate').onclick = event => prepare('locate', event.currentTarget)
  $('prepareReview').onclick = event => prepare('review', event.currentTarget)
  $('resume').onclick = event => prepare('resume', event.currentTarget)
  $('again').onclick = choices
  $('start').onclick = event => busy(event.currentTarget, async () => {
    const frame = $('frame'); frame.style.visibility = 'hidden'
    show('home', false); show('lab'); $('answerButton').hidden = run.kind === 'review'
    $('barTitle').textContent = run.kind === 'locate' ? '快速定位' : run.kind === 'review' ? '局势校准' : '复工练习'
    $('answerButton').textContent = run.kind === 'resume' ? '记录第一步' : '填写答案'
    $('timer').textContent = '准备中…'
    frame.src = run.startPath
    await new Promise((resolve, reject) => {
      const deadline = performance.now() + 30_000
      const poll = setInterval(() => {
        const main = frame.contentDocument?.querySelector('main[aria-label="工作总览"]')
        if (main && main.textContent.includes(run.kind === 'resume' ? '继续上次工作' : run.goalName)) { clearInterval(poll); resolve() }
        else if (performance.now() > deadline) { clearInterval(poll); reject(Error('场景还未显示，请联系主持人；当前尚未计时')) }
      }, 100)
    })
    startAt = performance.now()
    const started = request('start', { monotonicMs: startAt, wallMs: Date.now(), viewport: viewport() })
    // Queue observed product actions behind the server's start acknowledgement.
    // A participant may already act while that round trip is still in flight.
    run.status = 'running'
    productEvents = started
    frame.style.visibility = 'visible'
    const tick = () => { const seconds = Math.floor((performance.now() - startAt) / 1000); $('timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
    tick(); timer = setInterval(tick, 250)
    try { await started } catch (error) { clearInterval(timer); run.status = 'ready'; frame.style.visibility = 'hidden'; throw error }
  })
  $('answerButton').onclick = () => { show('answer'); show('locateAnswers', run.kind === 'locate'); show('resumeAnswers', run.kind === 'resume'); $('assisted').checked = false }
  $('backToApp').onclick = () => show('answer', false)
  $('cancelAttempt').onclick = event => busy(event.currentTarget, async () => { await productEvents.catch(() => {}); await request('cancel', {}); run.status = 'interrupted'; choices() })
  $('answerForm').addEventListener('submit', event => { event.preventDefault(); void busy(event.submitter, async () => {
    const monotonicMs = performance.now()
    await productEvents
    const result = await request('finish', { monotonicMs, assisted: $('assisted').checked,
      answers: { owner: $('answerOwner').value, blocker: $('answerBlocker').value, waiting: $('answerWaiting').value, resumeAt: $('answerResume').value } })
    completed(result.run); event.target.reset()
  }) })
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== $('frame').contentWindow || event.data?.channel !== 'superhub-human-study'
      || !run || run.status !== 'running') return
    const observed = { ...event.data, monotonicMs: performance.now() }
    productEvents = productEvents.then(async () => {
      if (run?.status !== 'running') return
      const result = await request('event', observed)
      if (observed.kind === 'saved') completed(result.run)
    }).catch(notice)
  })
  document.addEventListener('visibilitychange', () => {
    if (run?.status === 'running') void request('event', { kind: document.hidden ? 'hidden' : 'visible', monotonicMs: performance.now() }).catch(() => {})
  })
  window.addEventListener('pagehide', () => {
    if (run?.status === 'running') void fetch('/study/event', { method: 'POST', keepalive: true,
      headers: { 'content-type': 'application/json', 'x-study-request': '1' },
      body: JSON.stringify({ documentId, kind: 'interrupted', monotonicMs: performance.now() }) }).catch(() => {})
  })
  $('openClock').onclick = () => { show('choices', false); show('clock') }
  $('closeClock').onclick = choices
  $('sampleClock').onclick = event => busy(event.currentTarget, async () => {
    const samples = []
    for (let i = 0; i < 5; i++) {
      const clientSend = Date.now(), monoSend = performance.now()
      const server = await request('time')
      samples.push({ clientSend, monoSend, clientReceive: Date.now(), monoReceive: performance.now(), ...server })
    }
    const result = await request('clock-samples', { samples })
    const usable = result.samples.filter(row => row.usable)
    if (!usable.length) { $('clockSampleResult').textContent = '样本已保存，但检测到时钟跳变或不一致，不能据此计算偏差。请保持系统时间稳定后重试。'; return }
    const best = usable.reduce((a, b) => a.rttMs <= b.rttMs ? a : b)
    $('clockSampleResult').textContent = `已采集 5 次，其中 ${usable.length} 次时间稳定。最短往返 ${best.rttMs.toFixed(1)} 毫秒；本机相对服务器的偏差约 ${best.offsetCenterMs.toFixed(1)} 毫秒，网络不确定范围约 ±${best.uncertaintyMs.toFixed(1)} 毫秒。`
  })
  $('reserveClock').onclick = event => busy(event.currentTarget, async () => {
    const pairing = await request('clock-reserve', {})
    pairing.wallMs = Date.now(); pairing.monotonicMs = performance.now()
    await request('clock-pair', { id: pairing.id, action: 'announce' })
    $('clockCode').textContent = pairing.code; $('clockStatus').textContent = '请在手机输入这个同步码并回应。保持此页打开。'
    const poll = setInterval(async () => {
      try {
        const status = await request(`clock-pair?id=${encodeURIComponent(pairing.id)}`)
        if (status.status === 'result-received') {
          clearInterval(poll)
          const result = await request('clock-pair', { id: pairing.id, action: 'deliver', wallMs: pairing.wallMs, monotonicMs: pairing.monotonicMs })
          $('clockStatus').textContent = result.projection.explicitCausePreserved && result.projection.sourceTimestampsPreserved && result.projection.observedArrivalReversed
            ? '两台设备的回传已记录：先发消息后到达，来源时间和明确关联均保留。主持人会核对设备信息与偏差范围。' : '样本已记录，需要主持人检查投影结果。'
        }
      } catch (error) { clearInterval(poll); notice(error) }
    }, 1000)
  })
  $('respondClockForm').addEventListener('submit', event => { event.preventDefault(); void busy(event.submitter, async () => {
    await request('clock-pair', { code: $('pairCode').value, action: 'respond', wallMs: Date.now(), monotonicMs: performance.now() })
    $('clockStatus').textContent = '手机回应已收到，等待电脑自动补传先前产生的消息。'
  }) })
  void request('status').then(() => { show('login', false); show('registration') }).catch(() => {})
})()
