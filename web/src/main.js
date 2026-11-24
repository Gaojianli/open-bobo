import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import { aliases, mdi } from 'vuetify/iconsets/mdi-svg'
import 'vuetify/styles'
import App from './App.vue'
import './theme.css'

const vuetify = createVuetify({
  icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
  theme: { defaultTheme: 'bobo', themes: { bobo: { dark: false, colors: {
    primary: '#4439a8', background: '#f4f5fa', surface: '#ffffff'
  } } } },
  defaults: { VBtn: { elevation: 0, rounded: 'lg' } }
})
createApp(App).use(vuetify).mount('#app')
