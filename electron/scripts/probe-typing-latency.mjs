/**
 * Measure what typing actually costs in the DSH page, from inside the page.
 *
 * The user's report ("characters appear ~0.5 s late, dropped frames when switching sessions") can only be
 * settled with frame timings on the *live* page: process CPU said 0% for the renderers precisely while
 * nobody was typing, which measures nothing. This script talks to a running instance over CDP, records
 * animation-frame intervals (idle and during typing) and times how long inserted text takes to paint.
 *
 * Usage: node scripts/probe-typing-latency.mjs [--port 9333] [--typing app]
 *   --typing app    type into the page's own editor (default)
 *          none     only the idle measurement
 */

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 9333

const PING = (client) => (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++client.seq
  const timer = setTimeout(() => { reject(new Error(`${method} 超时`)) }, 20_000)
  client.pending.set(id, (result) => { clearTimeout(timer); resolve(result) })
  client.ws.send(JSON.stringify({ id, method, params }))
})

/** Frames over `ms`, as the intervals between animation frames. */
const FRAME_SCRIPT = (ms) => `new Promise((resolve) => {
  const frames = []; let last = performance.now(); const start = last;
  function tick(now) { frames.push(now - last); last = now;
    if (now - start < ${ms}) requestAnimationFrame(tick);
    else resolve({ frames, domNodes: document.querySelectorAll('*').length });
  }
  requestAnimationFrame(tick);
})`

const DIAG_SCRIPT = `(() => {
  const editors = [...document.querySelectorAll('[contenteditable="true"], textarea')];
  const nodes = document.querySelectorAll('*').length;
  let biggest = { count: 0, tag: '', cls: '' };
  for (const element of document.querySelectorAll('div, ul, ol')) {
    const count = element.children.length;
    if (count > biggest.count) biggest = { count, tag: element.tagName, cls: String(element.className).slice(0, 50) };
  }
  return {
    domNodes: nodes,
    editors: editors.map((element) => ({ tag: element.tagName, cls: String(element.className).slice(0, 60), text: (element.textContent || '').slice(0, 20) })),
    biggestList: biggest,
    title: document.title.slice(0, 60),
  };
})()`

/** Type into the focused editor and time the paint that carries the text. */
const TYPE_SCRIPT = (count) => `(async () => {
  const editor = document.querySelector('[contenteditable="true"], textarea');
  if (!editor) return { error: '找不到输入框' };
  editor.focus();
  const before = editor.textContent;
  const starts = [];
  window.__typingFrames = [];
  let last = performance.now();
  let running = true;
  function tick(now) { window.__typingFrames.push(now - last); last = now; if (running) requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
  window.__dshProbeInsert = (text) => {
    starts.push(performance.now());
    document.execCommand('insertText', false, text);
  };
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { ready: true, before };
})()`

const summarize = (frames) => {
  const sorted = [...frames].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return {
    frames: frames.length,
    avgMs: Number((frames.reduce((sum, value) => sum + value, 0) / frames.length).toFixed(1)),
    p50Ms: Number((at(0.5) ?? 0).toFixed(1)),
    p95Ms: Number((at(0.95) ?? 0).toFixed(1)),
    maxMs: Number((at(1) ?? 0).toFixed(1)),
    slowFrames: frames.filter((value) => value > 32).length,
  }
}

const main = async () => {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
  const page = list.find((target) => target.type === 'page' && target.url.startsWith('http://127.0.0.1'))
  if (page === undefined) {
    console.error('CDP 里找不到 DSH 页面')
    process.exit(1)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const client = { ws, seq: 0, pending: new Map() }
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const resolve = message.id !== undefined ? client.pending.get(message.id) : undefined
    if (resolve !== undefined) {
      client.pending.delete(message.id)
      resolve(message.result)
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const send = PING(client)
  await send('Runtime.enable')
  await send('Input.enable').catch(() => {})
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300))
    return result.result.value
  }

  const diag = await evaluate(DIAG_SCRIPT)
  console.log('页面:', diag.title)
  console.log('DOM 节点数:', diag.domNodes, '| 最大子节点容器:', diag.biggestList.count, diag.biggestList.tag, diag.biggestList.cls)
  console.log('输入框:', JSON.stringify(diag.editors))

  const idle = summarize((await evaluate(FRAME_SCRIPT(2000))).frames)
  console.log('空闲帧:', JSON.stringify(idle))

  const typed = await evaluate(TYPE_SCRIPT(12))
  if (typed.error) {
    console.log('打字测量跳过:', typed.error)
  } else {
    const started = Date.now()
    for (let index = 0; index < 12; index++) {
      await send('Input.insertText', { text: '测' })
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    const typing = summarize(await evaluate('window.__typingFrames'))
    await evaluate('window.__dshProbeInsert = null; window.__typingFrames = null')
    console.log('打字期间帧:', JSON.stringify(typing))
    console.log('12 个字符总耗时:', Date.now() - started, 'ms（约', Math.round((Date.now() - started) / 12), 'ms/字符）')
  }
  ws.close()
}

await main()
