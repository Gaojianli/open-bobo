<script setup>
import { computed } from 'vue'

const props = defineProps({
  samples: { type: Array, required: true },
  channel: { type: String, required: true },
  endTime: { type: Number, required: true }
})

const windowMs = 60_000
const plot = { left: 24, right: 166, top: 10, bottom: 53 }
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
const label = computed(() => last.value
  ? `最近 60 秒的通道强度，最新上报 ${last.value.level}`
  : '最近 60 秒的通道强度，等待设备上报')
</script>

<template>
  <svg class="intensity-chart" viewBox="0 0 178 71" role="img" :aria-label="label">
    <title>{{ label }}</title>
    <path class="grid" d="M24 10H166M24 31.5H166M24 53H166M24 10V53M95 10V53M166 10V53" />
    <g class="ticks">
      <text x="19" y="13" text-anchor="end">100</text>
      <text x="19" y="34.5" text-anchor="end">50</text>
      <text x="19" y="56" text-anchor="end">0</text>
      <text x="24" y="65" text-anchor="middle">−60s</text>
      <text x="95" y="65" text-anchor="middle">−30s</text>
      <text x="166" y="65" text-anchor="middle">现在</text>
      <text v-if="!last" x="95" y="34.5" text-anchor="middle">待上报</text>
    </g>
    <polyline v-if="points.length > 1" class="trace" :points="line" />
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
.grid { fill: none; stroke: #e0ddef; stroke-width: 1; }
.ticks { fill: #55536b; font-size: 9px; }
.trace { fill: none; stroke: rgb(var(--v-theme-primary)); stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.last-point { fill: rgb(var(--v-theme-primary)); }
</style>
