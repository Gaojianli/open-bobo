import { SERVICE } from './protocol.js'

export const REPAIR_ID = 0x05d6
export const DEVICE_INFO = 'device_information'
export const discoveryOptions = () => ({
  filters: [{ namePrefix: 'SOSEXY' }],
  exclusionFilters: [{ manufacturerData: [{ companyIdentifier: REPAIR_ID }] }],
  optionalServices: [SERVICE, DEVICE_INFO]
})

const editions = new Map([
  [2, '啵啵贝'], [3, '啵啵贝'], [5, '啵啵贝 Pro'], [7, '啵啵贝 Pro']
])

export function fromPid(value, source) {
  const pid = value.toString(16).padStart(4, '0').toUpperCase()
  return { model: editions.get(value) || '啵啵贝 · 版本待确认', pid, source }
}

export function fromAdvertisement(data) {
  if (!data || data.has(REPAIR_ID)) return null
  // The browser supplies the company ID separately. Only use unambiguous data.
  if (data.size !== 1) return null
  const value = data.values().next().value
  return value.byteLength >= 3 ? fromPid(value.getUint16(1, false), '厂商广播') : null
}

export async function readModel(server) {
  try {
    const service = await server.getPrimaryService(DEVICE_INFO)
    const characteristic = await service.getCharacteristic('model_number_string')
    const value = await characteristic.readValue()
    const label = new TextDecoder().decode(value).replace(/\0/g, '').trim()
    if (label && label.toUpperCase() !== 'SOSEXY') return { model: label, pid: null, source: '设备型号字段' }
  } catch { /* Optional service; many peripherals expose only EE01. */ }
  return { model: '啵啵贝 · 版本待确认', pid: null, source: '已核对控制服务' }
}

// Optional Web Bluetooth Scanning API. Cache by browser device ID, never by name.
export async function scanModels(bluetooth, found, signal) {
  function receive(event) {
    if (!event.device?.id || !(event.name || event.device.name || '').startsWith('SOSEXY')) return
    if (event.manufacturerData?.has(REPAIR_ID)) found(event.device.id, { repair: true })
    else {
      const profile = fromAdvertisement(event.manufacturerData)
      if (profile) found(event.device.id, profile)
    }
  }
  bluetooth.addEventListener('advertisementreceived', receive)
  let scan
  try {
    scan = await bluetooth.requestLEScan({ filters: [{ namePrefix: 'SOSEXY' }], keepRepeatedDevices: true })
    if (signal.aborted) return
    await new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, 4000)
      signal.addEventListener('abort', finish, { once: true })
    })
  } finally {
    scan?.stop()
    bluetooth.removeEventListener('advertisementreceived', receive)
  }
}
