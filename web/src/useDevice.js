import { computed, ref } from 'vue'
import { statusRequest, timedMotor, SERVICE, NOTIFY, WRITE, motor, stopCommand, packets, notificationReader, readStatus } from './protocol.js'

const discoveryOptions = () => ({
  filters: [{ namePrefix: 'SOSEXY' }],
  exclusionFilters: [{ manufacturerData: [{ companyIdentifier: 0x05d6 }] }],
  optionalServices: [SERVICE]
})
const statusTimeoutMs = 3000
const noStatusMessage = '设备未回报状态，已暂停自动查询。可点击「刷新状态」重试。'

export function useDevice(env = globalThis) {
  const logger = env.console ?? console
  const available = Boolean(env.isSecureContext && env.navigator?.bluetooth?.requestDevice)
  const reason = !env.isSecureContext ? '蓝牙连接需要 HTTPS 或 localhost。'
    : available ? '' : '当前浏览器未提供 Web Bluetooth，请用支持的 Chrome 或 Edge 打开。'
  const phase = ref('idle'), battery = ref(null), remaining = ref(null)
  const message = ref(''), busy = ref(false), stopping = ref(false)
  const debugBluetooth = ref(false)
  const motorReadings = ref({})
  const intensityHistory = ref([])
  const hasElectric = computed(() =>
    motorReadings.value.electric !== undefined || motorReadings.value.electricMode !== undefined
  )
  const awaitingTimer = ref(false)
  const reportedTimerChannels = ref(null)
  let active = null

  function logPacket(direction, characteristic, bytes) {
    if (!debugBluetooth.value) return
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ').toUpperCase()
    logger.info(`[BLE ${direction} ${characteristic}] ${hex}`)
  }

  function clear(session, text) {
    if (active !== session) return
    active = null
    motorReadings.value = {}
    intensityHistory.value = []
    awaitingTimer.value = false
    reportedTimerChannels.value = null
    session.device?.removeEventListener('gattserverdisconnected', session.dropped)
    session.notify?.removeEventListener('characteristicvaluechanged', session.receive)
    session.device?.gatt?.disconnect()
    phase.value = 'idle'
    battery.value = remaining.value = null
    busy.value = stopping.value = false
    message.value = text
  }

  async function connect() {
    if (!available || active) return
    const s = { tail: Promise.resolve(), mayBeRunning: false, statusVersion: 0 }
    active = s
    phase.value = 'choosing'
    message.value = ''
    try {
      s.device = await env.navigator.bluetooth.requestDevice(discoveryOptions())
      if (!s.device.name?.startsWith('SOSEXY')) {
        throw Error('请选择正常运行的啵啵贝')
      }
      s.dropped = () => clear(s, s.mayBeRunning ? '蓝牙连接已中断，设备输出状态未知。' : '蓝牙连接已中断。')
      s.device.addEventListener('gattserverdisconnected', s.dropped)
      phase.value = 'connecting'
      const server = await s.device.gatt.connect()
      const service = await server.getPrimaryService(SERVICE)
      if (active !== s) return
      s.write = await service.getCharacteristic(WRITE)
      if (!s.write.properties.write && !s.write.properties.writeWithoutResponse) throw Error('EE03 不支持写入')
      s.notify = await service.getCharacteristic(NOTIFY)
      const read = notificationReader()
      s.receive = event => {
        if (active !== s) return
        const v = event.target.value
        const packet = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
        logPacket('RX', 'EE02', packet)
        const msg = read(packet)
        if (!msg) return
        const status = readStatus(msg)
        if (!Object.keys(status).length) return
        s.statusVersion++
        s.statusDeadline = null
        s.statusRetried = s.statusPaused = false
        if (message.value === noStatusMessage) message.value = '已收到设备状态。'
        if ('battery' in status) battery.value = status.battery
        for (const channel of ['vibration', 'suction', 'electric', 'electricMode']) {
          if (channel in status) motorReadings.value[channel] = status[channel]
        }
        const { vibration, suction, electric } = status
        if (vibration !== undefined || suction !== undefined || electric !== undefined) {
          intensityHistory.value.push({ time: Date.now(), vibration, suction, electric })
          if (intensityHistory.value.length > 1024) intensityHistory.value.shift()
        }
        const timerEnded = remaining.value > 0 && status.remaining === 0
        if ('remaining' in status) {
          remaining.value = status.remaining
          awaitingTimer.value = false
        }
        if ('timerChannels' in status) reportedTimerChannels.value = status.timerChannels
        if (timerEnded && phase.value === 'ready') void requestStatus(s)
      }
      if (active !== s) return
      s.notify.addEventListener('characteristicvaluechanged', s.receive)
      await s.notify.startNotifications()
      if (active !== s) return
      phase.value = 'ready'
      message.value = '已订阅设备通知。'
      await refresh()
    } catch (error) {
      const cancelled = phase.value === 'choosing' && error.name === 'NotFoundError'
      clear(s, cancelled ? '未选择设备。请确认啵啵贝已开机并可被发现。' : '连接失败：' + error.message)
    }
  }

  function enqueue(s, run) {
    const result = s.tail.then(run)
    s.tail = result.catch(() => {})
    return result
  }

  function requireConnection(s) {
    if (s !== active || !s.device.gatt.connected) throw Error('蓝牙已断开')
  }

  function write(s, command) {
    return enqueue(s, async () => {
      for (const packet of packets(command)) {
        requireConnection(s)
        logPacket('TX', 'EE03', packet)
        if (s.write.properties.write) await s.write.writeValueWithResponse(packet)
        else await s.write.writeValueWithoutResponse(packet)
      }
    })
  }

  async function requestStatus(s) {
    const statusVersion = s.statusVersion
    try {
      await write(s, statusRequest())
      if (active === s && s.statusVersion === statusVersion) {
        s.statusDeadline = Date.now() + statusTimeoutMs
      }
    } catch (error) {
      if (active === s) {
        s.statusPaused = true
        message.value = '读取状态请求失败：' + error.message
      }
    }
  }

  async function refresh() {
    const s = active
    if (phase.value !== 'ready' || busy.value || stopping.value) return
    busy.value = true
    s.statusRetried = s.statusPaused = false
    try {
      await requestStatus(s)
    } finally {
      if (active === s) busy.value = false
    }
  }

  async function pollStatus() {
    const s = active
    if (phase.value !== 'ready' || busy.value || stopping.value || awaitingTimer.value || s.polling || s.statusPaused) return
    if (s.statusDeadline && Date.now() < s.statusDeadline) return
    if (s.statusDeadline && s.statusRetried) {
      s.statusPaused = true
      message.value = noStatusMessage
      return
    }
    s.polling = true
    try {
      if (s.statusDeadline) {
        s.statusRetried = true
        await enqueue(s, async () => {
          requireConnection(s)
          await s.notify.stopNotifications()
          requireConnection(s)
          await s.notify.startNotifications()
        })
      }
      if (active !== s || phase.value !== 'ready') return
      await requestStatus(s)
    } catch (error) {
      if (active === s) {
        s.statusPaused = true
        message.value = '恢复设备通知失败：' + error.message
      }
    } finally {
      s.polling = false
    }
  }

  async function apply(channel, level, mode) {
    const s = active
    if (phase.value !== 'ready' || busy.value || stopping.value || remaining.value > 0 || awaitingTimer.value) return false
    if (channel === 'electric' && !hasElectric.value) return false
    busy.value = true
    try {
      const command = motor(channel, level, mode)
      if (level > 0) s.mayBeRunning = true
      await write(s, command)
      const label = { vibration: '振动', suction: '吸吮', electric: '微电流' }[channel]
      if (active === s && phase.value === 'ready' && !stopping.value) {
        message.value = '已发送' + label + '设置。'
        await requestStatus(s)
      }
      return active === s
    } catch (error) {
      if (active === s) message.value = '写入失败：' + error.message
      return false
    } finally {
      if (active === s) busy.value = false
    }
  }

  async function startTimer(minutes, channels) {
    const s = active
    if (phase.value !== 'ready' || busy.value || stopping.value || awaitingTimer.value || remaining.value > 0) return false
    const selected = Array.isArray(channels) ? channels : [channels]
    if (selected.includes('electric') && !hasElectric.value) return false
    busy.value = true
    let attempted = false
    try {
      const command = timedMotor(minutes, selected)
      reportedTimerChannels.value = null
      awaitingTimer.value = true
      s.mayBeRunning = true
      attempted = true
      await write(s, command)
      if (active !== s) return false
      if (awaitingTimer.value) message.value = '失控模式设置已发送，等待设备上报剩余时间。'
      return true
    } catch (error) {
      if (active === s) {
        if (!attempted) awaitingTimer.value = false
        message.value = attempted ? '无法确认定时指令是否送达，请查看设备状态。' : error.message
      }
      return false
    } finally {
      if (active === s) busy.value = false
    }
  }

  async function stop() {
    const s = active
    if (!s?.write || !['ready','disconnecting'].includes(phase.value)) return false
    if (s.stopTask) return s.stopTask
    stopping.value = true
    s.stopTask = write(s, stopCommand()).then(async () => {
      if (active !== s) return false
      s.mayBeRunning = remaining.value > 0 || awaitingTimer.value
      message.value = remaining.value > 0 || awaitingTimer.value
        ? '已发送电机归零指令。定时模式是否结束，以设备上报为准。'
        : '已发送全部停止指令。'
      if (!s.mayBeRunning && phase.value === 'ready') await requestStatus(s)
      return active === s
    }).catch(error => {
      if (active === s) message.value = '停止指令发送失败：' + error.message
      return false
    }).finally(() => {
      s.stopTask = null
      if (active === s) stopping.value = false
    })
    return s.stopTask
  }

  async function disconnect() {
    const s = active
    if (phase.value !== 'ready') return
    phase.value = 'disconnecting'
    if ((s.mayBeRunning || s.stopTask) && !await stop()) {
      if (active === s) phase.value = 'ready'
      return
    }
    clear(s, remaining.value > 0 || awaitingTimer.value ? '已断开连接，设备定时可能仍在继续。' : '已断开连接。')
  }

  return { motorReadings, intensityHistory, hasElectric, awaitingTimer, reportedTimerChannels, startTimer, refresh, pollStatus, available, reason, phase, battery, remaining, message, busy, stopping, debugBluetooth, connect, apply, stop, disconnect }
}
