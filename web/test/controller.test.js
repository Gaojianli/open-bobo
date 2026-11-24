import test from 'node:test'
import assert from 'node:assert/strict'
import { packets, motor, stopCommand, notificationReader, readStatus, SERVICE, WRITE, NOTIFY } from '../src/protocol.js'
import { statusRequest, timedMotor } from '../src/protocol.js'
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

function fixture({ withoutResponse = false, logger } = {}) {
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
  const bluetooth = { async requestDevice(options) {
    assert.deepEqual(options.filters, [{ namePrefix: 'SOSEXY' }])
    assert.deepEqual(options.optionalServices, [SERVICE])
    assert.deepEqual(options.exclusionFilters, [{ manufacturerData: [{ companyIdentifier: 0x05d6 }] }])
    assert.equal(options.acceptAllDevices, undefined)
    return device
  } }
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
    assert.deepEqual(writes.map(p => p.slice(3)), [stopCommand(), statusRequest(), motor('suction', 50, 1), statusRequest(), stopCommand()])
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
  assert.deepEqual(commands, [motor('vibration', 25, 1), stopCommand(), statusRequest()])
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
test('应用设置和全部停止会重新请求状态，强度以设备通知为准', async () => {
  const { model, writes, report } = fixture()
  await model.connect()
  report('2a01000100071100')
  assert.equal(await model.apply('suction', 49, 1), true)
  assert.deepEqual(writes.slice(-2).map(packet => packet.slice(3)), [motor('suction', 49, 1), statusRequest()])
  assert.equal(model.motorReadings.value.suction, 0)
  report('2a01000100071131')
  assert.equal(model.motorReadings.value.suction, 49)
  assert.equal(model.intensityHistory.value.at(-1).suction, 49)
  assert.equal(await model.stop(), true)
  assert.deepEqual(writes.slice(-2).map(packet => packet.slice(3)), [stopCommand(), statusRequest()])
  assert.equal(model.motorReadings.value.suction, 49)
  report('2a01000100071100')
  assert.equal(model.motorReadings.value.suction, 0)
  assert.deepEqual(model.intensityHistory.value.map(sample => sample.suction), [0, 49, 0])
})
test('周期查询不会重叠，并与用户控制共用写入队列', async () => {
  const { model, write } = fixture()
  await model.connect()
  const commands = []
  let release
  write.writeValueWithResponse = async packet => {
    commands.push(packet.slice(3))
    if (commands.length === 1) await new Promise(resolve => { release = resolve })
  }
  const polling = model.pollStatus()
  await Promise.resolve()
  await model.pollStatus()
  assert.equal(model.busy.value, false)
  const applying = model.apply('vibration', 0, 1)
  await model.pollStatus()
  assert.deepEqual(commands, [statusRequest()])
  release()
  await polling
  assert.equal(await applying, true)
  assert.deepEqual(commands, [statusRequest(), motor('vibration', 0, 1), statusRequest()])
  await model.disconnect()
  await model.pollStatus()
  assert.equal(commands.length, 3)
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
  assert.deepEqual(writes.slice(-2).map(packet => packet.slice(3)), [motor('suction', 0, 1), statusRequest()])
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
  assert.deepEqual(writes.slice(-2).map(packet => packet.slice(3)), [fromHex('020003111900041101'), statusRequest()])
  assert.match(model.message.value, /微电流/)
  assert.equal(await model.apply('electric', 0, 1), true)
  assert.deepEqual(writes.slice(-2).map(packet => packet.slice(3)), [fromHex('0100031100'), statusRequest()])
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
