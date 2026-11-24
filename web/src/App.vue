<script setup>
import { computed, ref, watch } from 'vue'
import { VApp, VBtn, VCard, VDialog, VMain, VSelect, VSwitch } from 'vuetify/components'
import ChannelControl from './ChannelControl.vue'
import { useDevice } from './useDevice.js'

const { identity, motorReadings, canScan, scanning, scanComplete, identify, awaitingTimer, startTimer, refresh,
  available, reason, phase, name, battery, remaining, busy, stopping,
  message, debugBluetooth, connect, disconnect, apply, stop } = useDevice()
const ready = computed(() => phase.value === 'ready')
const phaseNames = { idle: '未连接', choosing: '请选择设备', connecting: '连接中', ready: '已连接', disconnecting: '断开中' }
const locked = computed(() => remaining.value !== null && remaining.value > 0)
const timerDialog = ref(false)
const minutes = ref(1)
const chosenMotor = ref('vibration')
const motors = [{ id: 'vibration', label: '振动电机' }, { id: 'suction', label: '吸吮电机' }]
const resetKey = ref(0)
async function startLostMode() {
  if (await startTimer(minutes.value, chosenMotor.value)) timerDialog.value = false
}
watch(phase, state => { if (state === 'idle') { resetKey.value++; timerDialog.value = false } })
async function stopAll() {
  if (await stop()) resetKey.value++
}
const time = computed(() => {
  if (remaining.value === null) return '待上报'
  if (!remaining.value) return '未开启'
  return Math.floor(remaining.value / 60) + ' 分 ' + remaining.value % 60 + ' 秒'
})
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
          <h1>{{ identity?.model || name || '蓝牙控制器' }}</h1>
          <p>{{ ready ? '通过本机蓝牙控制已连接的设备。' : '连接附近的啵啵贝，调节振动与吸吮。' }}</p>
          <v-btn v-if="phase === 'idle' && canScan && !scanComplete" class="link-device" size="large"
            :loading="scanning" @click="identify">识别附近的啵啵贝</v-btn>
          <v-btn v-else-if="!ready && phase !== 'disconnecting'" class="link-device" size="large"
            :disabled="!available || phase !== 'idle'" :loading="phase === 'connecting'" @click="connect">连接设备</v-btn>
          <v-btn v-else class="link-device" size="large" :loading="phase === 'disconnecting'" @click="disconnect">断开连接</v-btn>
          <v-btn v-if="ready" class="ml-2" variant="text" :disabled="busy || stopping" @click="refresh">刷新状态</v-btn>
        </div>
        <dl class="telemetry">
          <div v-if="ready"><dt>型号识别</dt><dd>{{ identity?.source }}<span v-if="identity?.pid"> · PID {{ identity.pid }}</span></dd></div>
          <div v-if="ready"><dt>微电流功能</dt><dd>{{ (motorReadings.electric !== undefined || motorReadings.electricMode !== undefined) ? '已上报通道' : '尚未确认' }}</dd></div>
          <div><dt>设备电量</dt><dd>{{ battery === null ? '待上报' : battery + '%' }}</dd></div>
          <div><dt>失控模式 · 上次上报</dt><dd>{{ time }}</dd></div>
        </dl>
      </section>
      <p v-if="reason || message" class="notice" role="status">{{ reason || message }}</p>
      <div class="section-heading"><h2>电机控制</h2><v-btn class="stop" variant="outlined"
        :disabled="!ready || stopping" :loading="stopping" @click="stopAll"><span class="stop-icon" aria-hidden="true"></span>全部停止</v-btn></div>
      <p v-if="locked" role="status">设备上报失控模式中，普通通道控制已暂停。</p>
      <section class="channels" aria-label="输出通道">
        <channel-control v-for="item in motors"
          :key="item.id" :channel-label="item.label" :reported="motorReadings[item.id]" :reset-key="resetKey"
          :disabled="!ready || busy || stopping || locked || awaitingTimer"
          @apply="(level, mode) => apply(item.id, level, mode)" />
      </section>
      <section class="timer-panel">
        <div><h2>失控模式</h2>
          <p>{{ awaitingTimer ? '已请求开启，等待设备上报' : locked ? '上次上报剩余 ' + time : '由设备计时运行所选电机' }}</p></div>
        <v-btn variant="outlined" color="primary" :disabled="!ready || busy || stopping || locked || awaitingTimer"
          @click="timerDialog = true">设置失控模式</v-btn>
      </section>
      <v-dialog v-model="timerDialog" max-width="420" aria-labelledby="timer-title">
        <v-card class="timer-dialog">
          <h2 id="timer-title">开启失控模式</h2>
          <p>设备自行计时。开启后可能需要等到计时结束才能恢复手动控制。</p>
          <v-select v-model="chosenMotor" :items="motors" item-title="label" item-value="id" label="运行电机" hide-details />
          <v-select v-model="minutes" :items="[1, 2, 3]" label="时长（分钟）" hide-details />
          <div class="timer-actions"><v-btn variant="text" @click="timerDialog = false">取消</v-btn>
            <v-btn color="primary" :loading="busy" :disabled="!ready || busy || locked || stopping || awaitingTimer"
              @click="startLostMode">确认开启</v-btn></div>
        </v-card>
      </v-dialog>
    </div>
  </v-main></v-app>
</template>
