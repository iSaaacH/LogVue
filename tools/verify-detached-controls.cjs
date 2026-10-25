// Run with Windows Node while the development build is open with --remote-debugging-port=9347.
// Usage: node --experimental-websocket tools/verify-detached-controls.cjs <robot-project>
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0
  const pending = new Map()
  socket.onmessage = ({ data }) => { const m = JSON.parse(data); pending.get(m.id)?.(m); pending.delete(m.id) }
  const call = (method, params) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => reject(Error('CDP timeout')), 30000)
    pending.set(n, m => { clearTimeout(timer); resolve(m) })
    socket.send(JSON.stringify({ id: n, method, params }))
  })
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert(!r.result.exceptionDetails, JSON.stringify(r))
    return r.result.result.value
  }
  const invoke = (channel, ...args) => evaluate(`window.api.invoke(${[channel, ...args].map(x => JSON.stringify(x)).join(',')})`)
  return { socket, call, evaluate, invoke }
}
(async () => {
  const root = path.resolve(process.argv[2]), port = process.env.LOGVUE_DEBUG_PORT || 9347
  const pages = () => fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())
  const main = await connect((await pages()).find(p => p.type === 'page' && !p.url.includes('simulationControls')))
  let panel
  try {
    await main.evaluate(`localStorage.setItem('logvue.sim.project',${JSON.stringify(root)});[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Simulate').click();true`)
    const catalog = await main.invoke('simulation:listCatalog', root)
    const red = catalog.opModes.find(o => o.name.includes('Red')) || catalog.opModes[0]
    if ((await main.invoke('simulation:getStatus')).pid) await main.invoke('simulation:stop')
    await main.invoke('simulation:init', {
      projectDirectory: root, opModeId: red.id, pluginId: red.pluginId, scenarioId: 'preloaded',
      gamepad1: { kind: 'LIVE' }, gamepad2: { kind: 'NONE' }, rateHz: 50, rlogPort: 5810
    })
    await wait(700)
    assert(await main.evaluate(`(()=>{const s=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='keyboard'));if(!s)return false;s.value='keyboard';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`))
    await main.invoke('simulation:start')
    await main.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Library').click();true`)
    assert(await main.evaluate(`(()=>{const button=document.querySelector('.sim-mini-launch');if(!button)return false;button.click();return true})()`),'Mini controls toolbar button must work outside Simulate')
    await wait(1000)
    panel = await connect((await pages()).find(p => p.type === 'page' && p.url.includes('simulationControls')))
    await panel.call('Page.bringToFront')
    assert.equal(await panel.evaluate(`document.querySelector('[aria-label="Driving input"]').value`), 'keyboard')
    assert(await panel.evaluate(`document.documentElement.scrollHeight <= innerHeight + 2`), 'Controls must fit without scrolling')
    await panel.evaluate(`document.querySelector('.sim-keyboard-pad').focus();window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',bubbles:true}));true`)
    await wait(400)
    assert.equal((await panel.invoke('simulation:getStatus')).runner.gamepad1.connected, true)
    // Old/hidden renderer frames must not neutralise the panel's held key.
    await main.evaluate(`(()=>{const t=setInterval(()=>window.api.publishSimulationGamepads({gamepad1:{connected:false}}),10);setTimeout(()=>clearInterval(t),450);return true})()`)
    await wait(300)
    assert.equal((await panel.invoke('simulation:getStatus')).runner.gamepad1.connected, true)
    await panel.evaluate(`window.dispatchEvent(new Event('blur'));true`)
    await wait(400)
    assert.equal((await panel.invoke('simulation:getStatus')).runner.gamepad1.connected, false)
    await panel.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Pause').click();true`)
    await wait(350)
    const paused = await panel.invoke('simulation:getStatus')
    assert.equal(paused.phase, 'paused')
    await panel.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Step').click();true`)
    await wait(350)
    assert.equal((await panel.invoke('simulation:getStatus')).runner.tick, paused.runner.tick + 1)
    await panel.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Run').click();true`)
    await wait(350)
    const coords = await panel.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Aim'),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await panel.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...coords, button: 'left', clickCount: 1 })
    await wait(350)
    assert.equal((await panel.invoke('simulation:getStatus')).runner.gamepad1.connected, true)
    await panel.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...coords, button: 'left', clickCount: 1 })
    const before = await panel.invoke('simulation:getStatus')
    await main.invoke('simulation:closeControls')
    panel.socket.close(); panel = undefined
    await wait(400)
    assert.equal(await main.invoke('simulation:getControlsWindow'), false)
    const after = await main.invoke('simulation:getStatus')
    assert.equal(after.pid, before.pid)
    assert.equal(after.phase, 'running')
    await main.invoke('simulation:openControls')
    await wait(700)
    panel = await connect((await pages()).find(p => p.type === 'page' && p.url.includes('simulationControls')))
    await panel.call('Page.bringToFront')
    await panel.evaluate(`document.querySelector('.sim-keyboard-pad').focus();true`)
    const screenshot = await panel.call('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync('out/verification', { recursive: true })
    fs.writeFileSync('out/verification/detached-controls.png', Buffer.from(screenshot.result.data, 'base64'))
    console.log('PASS: compact layout, exclusive keyboard input, blur release, pause/step/resume, held Aim, attach without restarting; panel left open')
  } finally { main.socket.close(); panel?.socket.close() }
})().catch(error => { console.error(error); process.exit(1) })
