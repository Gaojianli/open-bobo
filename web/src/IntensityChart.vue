<script setup>
import { computed } from 'vue'

const props = defineProps({
  samples: { type: Array, required: true },
  channel: { type: String, required: true },
  endTime: { type: Number, required: true }
})

const windowMs = 60_000
const plot = { left: 7, right: 171, top: 7, bottom: 64 }
const points = computed(() => {
  const start = props.endTime - windowMs
  return props.samples
    .filter(sample => sample.time >= start && sample[props.channel] !== undefined)
    .map(sample => ({
      x: plot.left + (sample.time - start) / windowMs * (plot.right - plot.left),
      y: plot.bottom - sample[props.channel] / 100 * (plot.bottom - plot.top),
      level: sample[props.channel]
    }))
})
const line = computed(() => points.value.map(({ x, y }) => `${x},${y}`).join(' '))
const last = computed(() => points.value.at(-1))
const area = computed(() => {
  if (points.value.length < 2) return ''
  return `${points.value[0].x},${plot.bottom} ${line.value} ${last.value.x},${plot.bottom}`
})
const label = computed(() => last.value
  ? `最近 60 秒的通道强度，最新上报 ${last.value.level}`
  : '最近 60 秒的通道强度，等待设备上报')
</script>

<template>
  <svg class="intensity-chart" viewBox="0 0 178 71" role="img" :aria-label="label">
    <title>{{ label }}</title>
    <template v-if="area">
      <polygon class="area" :points="area" />
      <polyline class="trace" :points="line" />
    </template>
    <circle v-if="last" class="last-point" :cx="last.x" :cy="last.y" r="2.5" />
  </svg>
</template>

<style scoped>
.intensity-chart {
  flex: none;
  width: clamp(106px, 45%, 178px);
  height: auto;
  background: #f8f7fd;
  border: 1px solid #e8e5f4;
  border-radius: 9px;
}
.area { fill: rgb(var(--v-theme-primary)); fill-opacity: .18; }
.trace { fill: none; stroke: rgb(var(--v-theme-primary)); stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.last-point { fill: rgb(var(--v-theme-primary)); }
</style>
