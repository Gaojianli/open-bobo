const uuid = n => `0000${n}-0000-1000-8000-00805f9b34fb`
export const SERVICE = uuid('ee01')
export const NOTIFY = uuid('ee02')
export const WRITE = uuid('ee03')

export function motor(channel, level, mode) {
  const key = { vibration: 1, suction: 7 }[channel]
  if (![1, 7].includes(key) || ![0, 25, 50, 75, 100].includes(level) || ![1, 2, 3, 4].includes(mode)) {
    throw new RangeError('通道、强度或模式无效')
  }
  return Uint8Array.of(2, 0, key, 0x11, level, 0, key + 1, 0x11, mode)
}

export const statusRequest = () => Uint8Array.of(1, 0, 0xc8, 0x11, 1)
export const stopCommand = () => Uint8Array.of(3, 0, 1, 0x11, 0, 0, 3, 0x11, 0, 0, 7, 0x11, 0)

// The duration is in minutes. The Web UI exposes the two mechanical channels.
export function timedMotor(minutes, channel) {
  const mask = { vibration: 1, suction: 2 }[channel]
  if (![1, 2].includes(mask) || ![1, 2, 3].includes(minutes)) {
    throw new RangeError('请选择电机和定时时长')
  }
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
    i += length
  }
  return status
}
