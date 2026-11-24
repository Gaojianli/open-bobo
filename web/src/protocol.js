const uuid = n => `0000${n}-0000-1000-8000-00805f9b34fb`
export const SERVICE = uuid('ee01')
export const NOTIFY = uuid('ee02')
export const WRITE = uuid('ee03')

const channelKeys = new Map([['vibration', 1], ['electric', 3], ['suction', 7]])
export function motor(channel, level, mode) {
  const key = channelKeys.get(channel)
  if (!key || !Number.isInteger(level) || level < 0 || level > 100 || ![1, 2, 3, 4].includes(mode)) {
    throw new RangeError('通道、强度或模式无效')
  }
  if (channel === 'electric' && level === 0) return Uint8Array.of(1, 0, key, 0x11, 0)
  return Uint8Array.of(2, 0, key, 0x11, level, 0, key + 1, 0x11, mode)
}

export const statusRequest = () => Uint8Array.of(1, 0, 0xc8, 0x11, 1)
export const stopCommand = () => Uint8Array.of(3, 0, 1, 0x11, 0, 0, 3, 0x11, 0, 0, 7, 0x11, 0)
export const breathingLightCommand = enabled => Uint8Array.of(1, 0, 0x0d, 0x11, enabled ? 1 : 0)

// The duration is in minutes and each selected channel sets one bit.
const timedMotorFlags = new Map([['vibration', 1], ['suction', 2], ['electric', 4]])
export function timedMotor(minutes, channels) {
  let mask = 0
  for (const channel of Array.isArray(channels) ? channels : [channels]) {
    const flag = timedMotorFlags.get(channel)
    if (!flag) throw new RangeError('请选择有效的输出通道')
    mask |= flag
  }
  if (!mask || ![1, 2, 3].includes(minutes)) throw new RangeError('请选择输出通道和定时时长')
  return Uint8Array.of(2, 0, 9, 0x11, minutes, 0, 11, 0x11, mask)
}

export function packets(command, tag = Math.floor(Math.random() * 255)) {
  if (!(command instanceof Uint8Array) || !command.length || command.length + 1 >= 255 * 18) {
    throw new RangeError('指令长度无效')
  }
  const body = new Uint8Array(command.length + 1)
  body.set(command, 1)
  const frames = []
  for (let offset = 0; offset <= body.length; offset += 18) {
    frames.push(Uint8Array.of(tag, frames.length + 1, ...body.subarray(offset, offset + 18)))
  }
  return frames
}

export function notificationReader() {
  let tag, next, body
  return frame => {
    if (frame.length === 15 && frame.every((byte, i) => byte === i)) return
    const [id, index] = frame
    if (index === 1) {
      tag = id
      next = 1
      body = []
    }
    if (!body || frame.length < 2 || frame.length > 20 || tag !== id || index !== next) {
      body = undefined
      return
    }
    next++
    body.push(...frame.subarray(2))
    if (frame.length === 20) return
    const message = Uint8Array.from(body.slice(1))
    body = undefined
    return message
  }
}

// The app chooses widths by attribute ID. Stop at unknown fields to avoid misalignment.
const widths = new Map([[1,1],[2,1],[3,1],[4,1],[5,1],[6,1],[7,1],[8,1],[9,1],
  [10,2],[11,1],[12,15],[13,1],[14,1]])

export function readStatus(message) {
  const status = {}
  const channelIds = { 1: 'vibration', 3: 'electric', 7: 'suction' }
  let i = 1
  for (let field = 0; field < message[0]; field++) {
    if (i + 3 > message.length) return {}
    const id = (message[i] << 8) | message[i + 1]
    const length = widths.get(id)
    if (!length) break
    i += 3
    if (i + length > message.length) return {}
    if (channelIds[id] && message[i - 1] === 0x11 && message[i] <= 100) {
      status[channelIds[id]] = message[i]
    }
    if (id === 4 && message[i - 1] === 0x11) status.electricMode = message[i]
    if (id === 5 && message[i] <= 100) status.battery = message[i]
    if (id === 10) status.remaining = (message[i] << 8) | message[i + 1]
    if (id === 11 && message[i - 1] === 0x11 && message[i] <= 7) {
      status.timerChannels = [...timedMotorFlags.keys()].filter(channel => message[i] & timedMotorFlags.get(channel))
    }
    if (id === 0x0d && message[i - 1] === 0x11 && message[i] <= 1) status.breathingLight = message[i] === 1
    i += length
  }
  return status
}
