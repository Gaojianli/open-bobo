<script setup>
import { ref, watch } from 'vue'
import {
  VBtn,
  VCard,
  VCardActions,
  VCardText,
  VCardTitle,
  VSelect,
  VSlider,
} from 'vuetify/components'

const props = defineProps({
  channelLabel: { type: String, required: true },
  reported: Number,
  reportedMode: Number,
  electric: Boolean,
  disabled: { type: Boolean, default: false },
  resetKey: { type: Number, default: 0 },
})

const emit = defineEmits(['apply'])

const level = ref(0)
const mode = ref(1)
const levelTicks = { 0: '0', 25: '25', 50: '50', 75: '75', 100: '100' }
const modes = [1, 2, 3, 4].map((value) => ({
  title: `模式 ${value}`,
  value,
}))

watch(() => props.resetKey, () => {
  level.value = 0
  mode.value = 1
})

function apply() {
  if (props.disabled) return
  emit('apply', level.value, mode.value)
}
</script>

<template>
  <v-card class="channel-control" variant="outlined">
    <v-card-title tag="h3">
      {{ props.channelLabel }}
    </v-card-title>

    <v-card-text class="channel-control__fields">
      <div class="readback">
        设备上报强度 · {{ props.reported ?? '待上报' }}
        <span v-if="props.electric"> · 模式 {{ props.reportedMode ?? '待上报' }}</span>
      </div>
      <v-slider
        v-model="level"
        :label="`等级：${level}`"
        :min="0"
        :max="100"
        :step="25"
        :ticks="levelTicks"
        :disabled="props.disabled"
        show-ticks="always"
        thumb-label
        hide-details
        color="primary"
      />

      <v-select
        v-model="mode"
        label="模式"
        :items="modes"
        :disabled="props.disabled"
        variant="outlined"
        hide-details
      />
    </v-card-text>

    <v-card-actions class="channel-control__actions">
      <v-btn
        type="button"
        class="flex-grow-1"
        color="primary"
        variant="flat"
        min-height="44"
        :disabled="props.disabled || (props.electric && level === 0)"
        @click="apply"
      >
        {{ props.electric ? '启动' : '应用设置' }}
      </v-btn>
      <v-btn variant="outlined" :disabled="props.disabled" min-height="44"
        @click="level = 0; apply()">{{ props.electric ? '停止微电流' : '停止此电机' }}</v-btn>
    </v-card-actions>
  </v-card>
</template>
