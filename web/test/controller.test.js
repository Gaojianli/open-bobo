import test from 'node:test'
import assert from 'node:assert/strict'
import { packets, motor, stopCommand, notificationReader, readStatus, SERVICE, WRITE, NOTIFY } from '../src/protocol.js'
import { fromAdvertisement, readModel, discoveryOptions, scanModels } from '../src/identity.js'
import { timedMotor } from '../src/protocol.js'
import { useDevice } from '../src/useDevice.js'

const fromHex = s => Uint8Array.from(Buffer.from(s.replaceAll(' ', ''), 'hex'))
test('官方发送路径的固定字节和分片边界', () => {
  assert.deepEqual(packets(motor('vibration', 25, 1), 42), [fromHex('2a0100020001111900021101')])
  assert.deepEqual(packets(stopCommand(), 42), [fromHex('2a010003000111000003110000071100')])
  for (const size of [16, 17, 18, 35]) {
    const body = Uint8Array.from({ length: size }, (_, i) => i)
    const frames = packets(body, 42)
    assert.equal(frames.at(-1).length, 2 + (size + 1) % 18)
    const read = notificationReader()
    assert.deepEqual(frames.map(read).filter(Boolean), [body])
  }
  assert.deepEqual(motor('vibration', 37, 1), fromHex('020001112500021101'))
  assert.throws(() => motor('vibration', 1.5, 1))
  assert.throws(() => motor('vibration', 101, 1))
})
test('复合状态通知、缺片、截断和未知字段', () => {
  assert.deepEqual(readStatus(fromHex('020005114b000a12012c')), { battery: 75, remaining: 300 })
  assert.deepEqual(readStatus(fromHex('01000a1200')), {})
  assert.deepEqual(readStatus(fromHex('0200ff110000051164')), {})
  const read = notificationReader()
  read(Uint8Array.of(42, 1, ...new Uint8Array(18)))
  assert.equal(read(Uint8Array.of(42, 3)), undefined)
})

function fixture({ withoutResponse = false, logger, bluetooth = new EventTarget() } = {}) {
  const writes = []
  const notify = new EventTarget()
  notify.startNotifications = async () => notify
  const record = async p => { writes.push(p) }
  const write = withoutResponse
    ? { properties: { writeWithoutResponse: true }, writeValueWithoutResponse: record }
    : { properties: { write: true }, writeValueWithResponse: record }
  const service = { async getCharacteristic(id) {
    assert.ok([WRITE, NOTIFY].includes(id))
    return id === WRITE ? write : notify
  } }
  const device = new EventTarget()
  device.name = 'SOSEXY'
  device.id = 'test-bobo'
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return this },
    async getPrimaryService(id) { assert.equal(id, SERVICE); return service },
    disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')) }
  }
  bluetooth.requestDevice = async options => {
    assert.deepEqual(options.filters, [{ namePrefix: 'SOSEXY' }])
    assert.ok(options.optionalServices.includes(SERVICE))
    assert.equal(options.acceptAllDevices, undefined)
    return device
  }
  const model = useDevice({ console: logger, isSecureContext: true, navigator: { bluetooth } })
  function report(hex) {
    const bytes = fromHex(hex)
    notify.value = new DataView(bytes.buffer)
    notify.dispatchEvent(new Event('characteristicvaluechanged'))
  }
  return { model, writes, report, device, write, notify }
}
test('蓝牙调试可在连接中切换，记录解析前的通知和实际写入的分片', async () => {
  const logs = []
  const { model, writes, report } = fixture({ logger: { info: message => logs.push(message) } })
  await model.connect()
  report('2a0100010005114b')
  assert.deepEqual(logs, [])

  model.debugBluetooth.value = true
  await model.refresh()
  report('000102030405060708090a0b0c0d0e')
  report('2a01000100031100')
  const sent = Buffer.from(writes.at(-1)).toString('hex').match(/../g).join(' ').toUpperCase()
  assert.deepEqual(logs, [
    `[BLE TX EE03] ${sent}`,
    '[BLE RX EE02] 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E',
    '[BLE RX EE02] 2A 01 00 01 00 03 11 00'
  ])
  assert.equal(model.motorReadings.value.electric, 0)

  model.debugBluetooth.value = false
  await model.refresh()
  report('2a01000100051164')
  assert.equal(logs.length, 3)
  assert.equal(model.battery.value, 100)
})
for (const withoutResponse of [false, true]) {
  test('订阅、控制和停止，两种 GATT 写入属性 ' + withoutResponse, async () => {
    const { model, writes, report } = fixture({ withoutResponse })
    await model.connect()
    assert.equal(model.phase.value, 'ready')
    assert.deepEqual(writes.shift().slice(3), fromHex('0100c81101'))
    report('2a0100020005114b000a12012c')
    assert.equal(model.remaining.value, 300)
    assert.equal(model.battery.value, 75)
    assert.equal(await model.apply('suction', 50, 1), false)
    assert.equal(await model.stop(), true)
    report('2a010001000a120000')
    assert.equal(await model.apply('suction', 50, 1), true)
    await model.disconnect()
    assert.deepEqual(writes.map(p => p.slice(3)), [stopCommand(), fromHex('0100c81101'), motor('suction', 50, 1), stopCommand()])
    assert.equal(model.battery.value, null)
    assert.equal(model.phase.value, 'idle')
  })
}
test('停止等待正在写入的指令，同时阻止新的普通写入', async () => {
  const { model, write } = fixture()
  await model.connect()
  let release
  const commands = []
  write.writeValueWithResponse = async p => {
    commands.push(p.slice(3))
    if (commands.length === 1) await new Promise(resolve => { release = resolve })
  }
  const first = model.apply('vibration', 25, 1)
  await Promise.resolve()
  const stopping = model.stop()
  assert.equal(await model.apply('suction', 50, 1), false)
  release()
  await Promise.all([first, stopping])
  assert.deepEqual(commands, [motor('vibration', 25, 1), stopCommand()])
})
test('意外断连清空数据，旧监听器不影响下次连接', async () => {
  const { model, device, report } = fixture()
  await model.connect()
  await model.apply('vibration', 25, 2)
  device.gatt.disconnect()
  report('2a0100010005114b')
  assert.equal(model.battery.value, null)
  assert.match(model.message.value, /未知/)
  await model.connect()
  assert.equal(model.phase.value, 'ready')
})
test('订阅失败时断开并报告错误', async () => {
  const { model, device, notify } = fixture()
  notify.startNotifications = async () => { throw Error('订阅失败') }
  await model.connect()
  assert.equal(model.phase.value, 'idle')
  assert.equal(device.gatt.connected, false)
  assert.match(model.message.value, /订阅失败/)
})
test('用户取消选择和缺少浏览器支持', async () => {
  const model = useDevice({ isSecureContext: true, navigator: { bluetooth: {
    async requestDevice() { throw new DOMException('cancel', 'NotFoundError') }
  } } })
  await model.connect()
  assert.equal(model.phase.value, 'idle')
  assert.match(model.message.value, /未选择/)
  assert.equal(useDevice({ isSecureContext: false }).available, false)
})

test('选择器排除维修设备，广播 PID 区分普通版、Pro 和未知产品', () => {
  assert.deepEqual(discoveryOptions().exclusionFilters, [{ manufacturerData: [{ companyIdentifier: 0x05d6 }] }])
  const data = pid => new DataView(Uint8Array.of(0xab, 0, pid).buffer)
  for (const pid of [2, 3, 5, 7, 40]) {
    const result = fromAdvertisement(new Map([[0x1234, data(pid)]]))
    assert.equal(result.model, pid === 40 ? '啵啵贝 · 版本待确认' : pid < 5 ? 'FUNF 啵啵贝' : 'FUNF 啵啵贝 Pro')
  }
  assert.equal(fromAdvertisement(new Map([[0x05d6, data(5)]])), null)
  assert.equal(fromAdvertisement(new Map([[0x1234, new DataView(new ArrayBuffer(2))]])), null)
})
test('可选扫描按设备 ID 区分同名设备并清理监听，忽略耳机', async () => {
  const bluetooth = new EventTarget()
  const controller = new AbortController()
  let stopped = false
  const found = new Map()
  bluetooth.requestLEScan = async () => ({ stop() { stopped = true } })
  const scan = scanModels(bluetooth, (id, model) => found.set(id, model), controller.signal)
  function report(id, name, company, pid) {
    bluetooth.dispatchEvent(Object.assign(new Event('advertisementreceived'), {
      device: { id, name }, manufacturerData: new Map([[company, new DataView(Uint8Array.of(0, 0, pid).buffer)]])
    }))
  }
  report('one', 'SOSEXY', 0x1234, 3)
  report('two', 'SOSEXY', 0x1234, 5)
  report('dfu', 'SOSEXY', 0x05d6, 5)
  report('other', '耳机', 0x1234, 5)
  controller.abort()
  await scan
  assert.equal(found.get('one').pid, '0003')
  assert.equal(found.get('two').pid, '0005')
  assert.equal(found.get('dfu').repair, true)
  assert.equal(found.has('other'), false)
  assert.equal(stopped, true)
  report('late', 'SOSEXY', 0x1234, 5)
  assert.equal(found.has('late'), false)
})
test('读取可选 GATT 型号，通用广播名保留版本未知', async () => {
  const server = label => ({ async getPrimaryService() {
    return { async getCharacteristic() { return { async readValue() { return new DataView(new TextEncoder().encode(label).buffer) } } } }
  } })
  assert.equal((await readModel(server('FUNF 啵啵贝 Pro'))).model, 'FUNF 啵啵贝 Pro')
  assert.match((await readModel(server('SOSEXY'))).model, /待确认/)
})
test('连接后重试型号识别时只使用已连接设备的厂商广播', async () => {
  const bluetooth = new EventTarget()
  bluetooth.requestLEScan = async () => ({ stop() {} })
  const logs = []
  const { model, device } = fixture({ bluetooth, logger: { info: message => logs.push(message) } })
  model.debugBluetooth.value = true
  await model.connect()
  assert.equal(model.identity.value.source, null)
  assert.equal(model.modelUnconfirmed.value, true)
  assert.ok(logs.some(message => message.startsWith('[BLE MODEL] 无法读取型号字段')))
  const scan = model.identify()
  function advertise(candidate, pid) {
    bluetooth.dispatchEvent(Object.assign(new Event('advertisementreceived'), {
      device: candidate,
      manufacturerData: new Map([[0x1234, new DataView(Uint8Array.of(0, 0, pid).buffer)]])
    }))
  }
  advertise({ id: 'another-bobo', name: device.name }, 3)
  assert.equal(model.identity.value.source, null)
  advertise(device, 5)
  assert.equal(model.identity.value.model, 'FUNF 啵啵贝 Pro')
  assert.equal(model.identity.value.pid, '0005')
  assert.equal(model.modelUnconfirmed.value, false)
  assert.deepEqual(logs.filter(message => message.startsWith('[BLE ADV')), ['[BLE ADV 1234] 00 00 05'])
  await model.disconnect()
  await scan
  assert.equal(model.identity.value, null)
  assert.equal(model.scanning.value, false)
})
test('强度历史保留实际通道上报和零值，断开时清空', async () => {
  const { model, report } = fixture()
  await model.connect()
  report('2a010003000111190003110000071132')
  report('2a0100010005115a')
  report('2a01000100011100')
  const [sample, next] = model.intensityHistory.value
  assert.equal(model.intensityHistory.value.length, 2)
  assert.deepEqual(sample, { time: sample.time, vibration: 25, suction: 50, electric: 0 })
  assert.deepEqual(next, { time: next.time, vibration: 0, suction: undefined, electric: undefined })
  assert.ok(sample.time <= next.time)
  await model.disconnect()
  assert.deepEqual(model.intensityHistory.value, [])
})
test('四片设备状态通知保留微电流强度和模式的零值', async () => {
  const { model, report } = fixture()
  await model.connect()
  report('01 01 00 0D 00 05 11 5A 00 01 11 00 00 02 11 00 00 03 11 00')
  report('01 02 00 04 11 00 00 07 11 00 00 08 11 00 00 09 11 00 00 0A')
  report('01 03 12 00 00 00 0B 11 00 00 0C AF 00 0D 00 00 00 00 00 00')
  assert.deepEqual(model.motorReadings.value, {})
  report('01 04 00 00 00 00 00 00 00 00 0D 11 01 00 0E 11 01')
  assert.deepEqual(model.motorReadings.value, { vibration: 0, suction: 0, electric: 0, electricMode: 0 })
  assert.equal(model.battery.value, 90)
  assert.deepEqual(model.reportedTimerChannels.value, [])
  assert.equal(model.identity.value.source, null)
})
test('定时运行中重连只收到配置时，定时归零后自动请求一次普通状态', async () => {
  const { model, writes, report } = fixture()
  await model.connect()
  report('64 01 00 04 00 05 11 50 00 09 11 01 00 0A 12 00 1A 00 0B 11')
  report('64 02 07')
  assert.equal(model.battery.value, 80)
  assert.equal(model.remaining.value, 26)
  assert.deepEqual(model.reportedTimerChannels.value, ['vibration', 'suction', 'electric'])
  assert.equal(model.hasElectric.value, false)
  report('66 01 00 01 00 0A 12 00 00')
  report('67 01 00 01 00 0A 12 00 00')
  await Promise.resolve()
  assert.deepEqual(writes.map(p => p.slice(3)), [fromHex('0100c81101'), fromHex('0100c81101')])
  report('68 01 00 02 00 03 11 00 00 04 11 00')
  assert.equal(model.hasElectric.value, true)
})
test('单独停止一个电机，能力由设备通知确认并在断开后清理', async () => {
  const { model, writes, report } = fixture()
  await model.connect()
  assert.deepEqual(model.motorReadings.value, {})
  report('2a010003000311000001111900071132')
  assert.deepEqual(model.motorReadings.value, { electric: 0, vibration: 25, suction: 50 })
  report('2a01000100041102')
  assert.equal(model.motorReadings.value.electricMode, 2)
  await model.apply('suction', 0, 1)
  assert.deepEqual(writes.at(-1).slice(3), motor('suction', 0, 1))
  await model.disconnect()
  assert.deepEqual(model.motorReadings.value, {})
})
test('微电流上报后可以启动和单独停止，重连后需要重新确认通道', async () => {
  const { model, writes, report } = fixture()
  await model.connect()
  assert.equal(await model.apply('electric', 25, 1), false)
  assert.equal(writes.length, 1)
  report('2a0100020003110000041100')
  assert.equal(model.hasElectric.value, true)
  assert.equal(await model.apply('electric', 25, 1), true)
  assert.deepEqual(writes.at(-1).slice(3), fromHex('020003111900041101'))
  assert.match(model.message.value, /微电流/)
  assert.equal(await model.apply('electric', 0, 1), true)
  assert.deepEqual(writes.at(-1).slice(3), fromHex('0100031100'))
  await model.disconnect()
  assert.equal(model.hasElectric.value, false)
  await model.connect()
  assert.equal(await model.apply('electric', 25, 1), false)
})
test('机械通道定时指令、重复点击、设备回报和停止语义', async () => {
  assert.deepEqual(timedMotor(1, 'vibration'), fromHex('0200091101000b1101'))
  assert.deepEqual(timedMotor(2, 'suction'), fromHex('0200091102000b1102'))
  assert.throws(() => timedMotor(2, ['vibration', 'unknown']))
  assert.throws(() => timedMotor(2, []))
  const { model, writes, report } = fixture()
  await model.connect()
  assert.equal(await model.startTimer(1, ['vibration', 'suction']), true)
  assert.deepEqual(writes.at(-1).slice(3), fromHex('0200091101000b1103'))
  assert.equal(await model.startTimer(1, 'vibration'), false)
  assert.equal(await model.apply('vibration', 25, 1), false)
  report('2a010001000a12003c')
  assert.equal(model.awaitingTimer.value, false)
  assert.equal(model.remaining.value, 60)
  await model.stop()
  assert.equal(model.remaining.value, 60)
  report('2a010001000a120000')
  assert.equal(await model.apply('vibration', 25, 1), true)
})
test('失控模式的三种通道独立组合，掩码与原 App 一致', () => {
  const cases = [
    ['vibration'], ['suction'], ['vibration', 'suction'], ['electric'],
    ['vibration', 'electric'], ['suction', 'electric'], ['vibration', 'suction', 'electric']
  ]
  for (const [index, channels] of cases.entries()) {
    const mask = index + 1
    assert.deepEqual(timedMotor(2, channels), Uint8Array.of(2, 0, 9, 0x11, 2, 0, 11, 0x11, mask))
    assert.deepEqual(readStatus(Uint8Array.of(1, 0, 11, 0x11, mask)).timerChannels, channels)
  }
})
test('定时的电击选项需要当前连接上报微电流能力，界面使用设备回报的通道', async () => {
  const { model, writes, report } = fixture()
  await model.connect()
  const selected = ['vibration', 'suction', 'electric']
  assert.equal(await model.startTimer(2, selected), false)
  assert.equal(writes.length, 1)
  report('2a 01 00 02 00 03 11 00 00 0B 11 00')
  assert.equal(await model.startTimer(2, selected), true)
  assert.deepEqual(writes.at(-1).slice(3), fromHex('0200091102000b1107'))
  assert.equal(model.reportedTimerChannels.value, null)
  report('2a 01 00 02 00 0A 12 00 77 00 0B 11 07')
  assert.equal(model.remaining.value, 119)
  assert.deepEqual(model.reportedTimerChannels.value, selected)
  await model.disconnect()
  assert.equal(model.reportedTimerChannels.value, null)
})
