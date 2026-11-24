import { computed, ref } from 'vue'
import { discoveryOptions, readModel, scanModels, UNKNOWN_MODEL } from './identity.js'
import { statusRequest, timedMotor, SERVICE, NOTIFY, WRITE, motor, stopCommand, packets, notificationReader, readStatus } from './protocol.js'

export function useDevice(env = globalThis) {
  const logger = env.console ?? console
  const available = Boolean(env.isSecureContext && env.navigator?.bluetooth?.requestDevice)
  const reason = !env.isSecureContext ? '蓝牙连接需要 HTTPS 或 localhost。'
    : available ? '' : '当前浏览器未提供 Web Bluetooth，请用支持的 Chrome 或 Edge 打开。'
  const phase = ref('idle'), name = ref(''), battery = ref(null), remaining = ref(null)
  const message = ref(''), busy = ref(false), stopping = ref(false)
  const debugBluetooth = ref(false)
  const identity = ref(null)
  const modelUnconfirmed = computed(() => identity.value?.model === UNKNOWN_MODEL)
  const motorReadings = ref({})
  const intensityHistory = ref([])
  const hasElectric = computed(() =>
    motorReadings.value.electric !== undefined || motorReadings.value.electricMode !== undefined
  )
  const awaitingTimer = ref(false)
  const reportedTimerChannels = ref(null)
  const scanning = ref(false)
  const canScan = available && typeof env.navigator.bluetooth.requestLEScan === 'function'
  const scanComplete = ref(false)
  const profiles = new Map()
  let active = null
  let scanController = null

  function logPacket(direction, characteristic, bytes) {
    if (!debugBluetooth.value) return
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ').toUpperCase()
    logger.info(`[BLE ${direction} ${characteristic}] ${hex}`)
  }

  async function identify() {
    const session = active
    if (!canScan || scanning.value || (session && phase.value !== 'ready')) return
    const controller = new AbortController()
    scanController = controller
    scanning.value = true
    if (!session) profiles.clear()
    let matches = 0
    try {
      await scanModels(env.navigator.bluetooth, (id, profile) => {
        if (session && session.device.id !== id) return
        profiles.set(id, profile)
        matches++
        if (active?.device?.id === id) {
          if (profile.repair) clear(active, '该设备正在维修模式，无法控制。')
          else identity.value = profile
        }
      }, controller.signal, event => {
        if (!debugBluetooth.value || (session && session.device.id !== event.device.id)) return
        if (!event.manufacturerData?.size) logger.info('[BLE ADV] 广播中没有可读取的厂商数据')
        for (const [company, value] of event.manufacturerData ?? []) {
          const manufacturer = company.toString(16).padStart(4, '0').toUpperCase()
          logPacket('ADV', manufacturer, new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        }
      })
      if (!controller.signal.aborted) message.value = matches ? '已读取设备广播。' : '暂未收到型号广播。'
    } catch (error) {
      if (!controller.signal.aborted) message.value = '无法读取广播：' + error.message
    } finally {
      if (!controller.signal.aborted) scanComplete.value = true
      scanning.value = false
      scanController = null
    }
  }

  function clear(session, text) {
    if (active !== session) return
    active = null
    scanController?.abort()
    identity.value = null
    scanComplete.value = false
    motorReadings.value = {}
    intensityHistory.value = []
    awaitingTimer.value = false
    reportedTimerChannels.value = null
    session.device?.removeEventListener('gattserverdisconnected', session.dropped)
    session.notify?.removeEventListener('characteristicvaluechanged', session.receive)
    session.device?.gatt?.disconnect()
    phase.value = 'idle'
    name.value = ''
    battery.value = remaining.value = null
    busy.value = stopping.value = false
    message.value = text
  }

  async function connect() {
    if (!available || active) return
    const s = { tail: Promise.resolve(), mayBeRunning: false }
    active = s
    phase.value = 'choosing'
    message.value = ''
    try {
      s.device = await env.navigator.bluetooth.requestDevice(discoveryOptions())
      if (!s.device.name?.startsWith('SOSEXY') || profiles.get(s.device.id)?.repair) {
        throw Error('请选择正常运行的啵啵贝')
      }
      s.dropped = () => clear(s, s.mayBeRunning ? '蓝牙连接已中断，设备输出状态未知。' : '蓝牙连接已中断。')
      s.device.addEventListener('gattserverdisconnected', s.dropped)
      phase.value = 'connecting'
      const server = await s.device.gatt.connect()
      const service = await server.getPrimaryService(SERVICE)
      const profile = profiles.get(s.device.id) || await readModel(server, text => {
        if (debugBluetooth.value && active === s) logger.info(`[BLE MODEL] ${text}`)
      })
      if (active !== s) return
      identity.value = profiles.get(s.device.id) || profile
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
        if (timerEnded && phase.value === 'ready' && !hasElectric.value) void requestStatus(s)
      }
      if (active !== s) return
      s.notify.addEventListener('characteristicvaluechanged', s.receive)
      await s.notify.startNotifications()
      if (active !== s) return
      name.value = s.device.name || '啵啵贝'
      phase.value = 'ready'
      message.value = '已订阅设备通知。'
      await refresh()
    } catch (error) {
      const cancelled = phase.value === 'choosing' && error.name === 'NotFoundError'
      clear(s, cancelled ? '未选择设备。请确认啵啵贝已开机并可被发现。' : '连接失败：' + error.message)
    }
  }

  function write(s, command) {
    const run = async () => {
      for (const packet of packets(command)) {
        if (s !== active || !s.device.gatt.connected) throw Error('蓝牙已断开')
        logPacket('TX', 'EE03', packet)
        if (s.write.properties.write) await s.write.writeValueWithResponse(packet)
        else await s.write.writeValueWithoutResponse(packet)
      }
    }
    const result = s.tail.then(run)
    s.tail = result.catch(() => {})
    return result
  }

  async function requestStatus(s) {
    try {
      await write(s, statusRequest())
    } catch (error) {
      if (active === s) message.value = '读取状态请求失败：' + error.message
    }
  }

  async function refresh() {
    const s = active
    if (phase.value !== 'ready' || busy.value || stopping.value) return
    busy.value = true
    try {
      await requestStatus(s)
    } finally {
      if (active === s) busy.value = false
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
      if (active === s && !stopping.value) message.value = '已发送' + label + '设置。'
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
    s.stopTask = write(s, stopCommand()).then(() => {
      if (active !== s) return false
      s.mayBeRunning = remaining.value > 0 || awaitingTimer.value
      message.value = remaining.value > 0 || awaitingTimer.value
        ? '已发送电机归零指令。定时模式是否结束，以设备上报为准。'
        : '已发送全部停止指令。'
      return true
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

  return { scanComplete, identity, modelUnconfirmed, motorReadings, intensityHistory, hasElectric, canScan, scanning, identify, awaitingTimer, reportedTimerChannels, startTimer, refresh, available, reason, phase, name, battery, remaining, message, busy, stopping, debugBluetooth, connect, apply, stop, disconnect }
}
