<script setup>
import { computed, ref, watch } from 'vue'
import { VApp, VBtn, VCard, VCardActions, VCardText, VCardTitle, VCheckbox, VMain, VSelect, VSwitch } from 'vuetify/components'
import ChannelControl from './ChannelControl.vue'
import IntensityChart from './IntensityChart.vue'
import { useDevice } from './useDevice.js'

const { motorReadings, intensityHistory, hasElectric, awaitingTimer, reportedTimerChannels, startTimer, refresh, pollStatus,
  available, reason, phase, battery, remaining, busy, stopping,
  message, debugBluetooth, connect, disconnect, apply, stop } = useDevice()
const ready = computed(() => phase.value === 'ready')
const chartClock = ref(Date.now())
const chartEndTime = computed(() => Math.max(chartClock.value, intensityHistory.value.at(-1)?.time ?? 0))
watch(ready, (connected, _, onCleanup) => {
  chartClock.value = Date.now()
  if (!connected) return
  const timer = setInterval(() => {
    chartClock.value = Date.now()
    void pollStatus()
  }, 1000)
  onCleanup(() => clearInterval(timer))
})
const phaseNames = { idle: '未连接', choosing: '请选择设备', connecting: '连接中', ready: '已连接', disconnecting: '断开中' }
const locked = computed(() => remaining.value !== null && remaining.value > 0)
const electricStatus = computed(() => {
  if (!ready.value || hasElectric.value) return ''
  if (locked.value) return '待定时结束后确认'
  if (motorReadings.value.vibration !== undefined || motorReadings.value.suction !== undefined) return '设备不支持'
  return '等待设备上报'
})
const controlsDisabled = computed(() => !ready.value || busy.value || stopping.value || locked.value || awaitingTimer.value)
const minutes = ref(1)
const chosenChannels = ref(['vibration'])
const motors = [{ id: 'vibration', label: '振动' }, { id: 'suction', label: '吸吮' }]
const timerChannels = [...motors, { id: 'electric', label: '电击' }]
const resetKey = ref(0)
watch(phase, state => { if (state === 'idle') resetKey.value++ })
watch(hasElectric, supported => {
  if (!supported) chosenChannels.value = chosenChannels.value.filter(channel => channel !== 'electric')
})
async function stopAll() {
  if (await stop()) resetKey.value++
}
const timerStatus = computed(() => {
  if (awaitingTimer.value) return '已请求开启，等待设备上报'
  if (!remaining.value) return '设备会在所选通道间随机组合运行'
  return '上次上报剩余 ' + Math.floor(remaining.value / 60) + ' 分 ' + remaining.value % 60 + ' 秒'
})
const reportedChannelsLabel = computed(() => timerChannels
  .filter(channel => reportedTimerChannels.value?.includes(channel.id))
  .map(channel => channel.label).join('、') || '无')
</script>

<template>
  <v-app><v-main>
    <div class="shell">
      <header>
        <span class="brand-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span><strong>Open BOBO</strong>
        <v-switch v-model="debugBluetooth" class="ml-auto flex-grow-0" label="蓝牙调试" color="primary" density="compact" hide-details />
      </header>
      <section class="device-panel" aria-label="蓝牙设备">
        <div class="rings" aria-hidden="true"></div>
        <div class="device-info">
          <span class="connection" role="status"><i :class="{ online: ready }"></i>{{ phaseNames[phase] }}</span>
          <h1>啵啵贝控制台</h1>
          <p>{{ ready ? '通过本机蓝牙控制已连接的设备。' : '连接附近的啵啵贝，调节振动与吸吮。' }}</p>
          <v-btn v-if="!ready && phase !== 'disconnecting'" class="link-device" size="large"
            :disabled="!available || phase !== 'idle'" :loading="phase === 'connecting'" @click="connect">连接设备</v-btn>
          <v-btn v-else class="link-device" size="large" :loading="phase === 'disconnecting'" @click="disconnect">断开连接</v-btn>
          <v-btn v-if="ready" class="ml-2" variant="text" :disabled="busy || stopping" @click="refresh">刷新状态</v-btn>
        </div>
        <dl class="telemetry">
          <div><dt>设备电量</dt><dd>{{ battery === null ? '待上报' : battery + '%' }}</dd></div>
        </dl>
      </section>
      <p v-if="reason || message" class="notice" role="status">{{ reason || message }}</p>
      <div class="section-heading"><h2>设备控制</h2><v-btn class="stop" variant="outlined"
        :disabled="!ready || stopping" :loading="stopping" @click="stopAll"><span class="stop-icon" aria-hidden="true"></span>全部停止</v-btn></div>
      <p v-if="locked" role="status">设备上报失控模式中，普通通道控制已暂停。</p>
      <section class="channels" aria-label="输出通道和失控模式">
        <channel-control v-for="item in motors"
          :key="item.id" :channel-label="item.label + '电机'" :reported="motorReadings[item.id]" :reset-key="resetKey"
          :disabled="controlsDisabled"
          @apply="(level, mode) => apply(item.id, level, mode)">
          <template #chart>
            <intensity-chart :samples="intensityHistory" :channel="item.id" :end-time="chartEndTime" />
          </template>
        </channel-control>
        <channel-control channel-label="微电流通道" electric
          :reported="motorReadings.electric" :reported-mode="motorReadings.electricMode" :reset-key="resetKey"
          :status-message="electricStatus"
          :disabled="controlsDisabled || !hasElectric"
          @apply="(level, mode) => apply('electric', level, mode)">
          <template #chart>
            <intensity-chart :samples="intensityHistory" channel="electric" :end-time="chartEndTime" />
          </template>
        </channel-control>
        <v-card class="channel-control" variant="outlined">
          <v-card-title tag="h3">失控模式</v-card-title>
          <v-card-text class="channel-control__fields">
            <div class="readback" role="status">
              <p>{{ timerStatus }}</p>
              <p v-if="locked && reportedTimerChannels !== null">设备上报通道 · {{ reportedChannelsLabel }}</p>
            </div>
            <div class="timer-channels" role="group" aria-label="运行通道">
              <v-checkbox v-for="item in timerChannels" :key="item.id"
                v-model="chosenChannels" :value="item.id" :label="item.label"
                :disabled="controlsDisabled || (item.id === 'electric' && !hasElectric)" color="primary" density="compact" hide-details />
            </div>
            <v-select v-model="minutes" :items="[1, 2, 3]" :disabled="controlsDisabled"
              label="时长（分钟）" variant="outlined" hide-details />
          </v-card-text>
          <v-card-actions class="channel-control__actions">
            <v-btn type="button" class="flex-grow-1" color="primary" variant="flat" min-height="44"
              :disabled="controlsDisabled || !chosenChannels.length"
              @click="startTimer(minutes, chosenChannels)">开始</v-btn>
          </v-card-actions>
        </v-card>
      </section>
    </div>
  </v-main></v-app>
</template>
