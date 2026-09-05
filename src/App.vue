<script setup>
import { ref, onMounted, nextTick, computed } from 'vue'

const ragEnabled = ref(true)
const sending = ref(false)
const serverOnline = ref(null)
const sessions = ref([])
const activeId = ref(null)
const messages = ref([])
const input = ref('')
const scrollBox = ref(null)

// 模型选择：zhipu=智谱 GLM-4.7-Flash（免费，默认），deepseek=DeepSeek（付费，需授权）
const model = ref('zhipu')
const MODEL_LABEL = { zhipu: 'GLM-4.7', deepseek: 'DeepSeek' }
const MODELS = [
  { id: 'zhipu', label: 'GLM-4.7', tip: '智谱 GLM-4.7-Flash · 免费' },
  { id: 'deepseek', label: 'DeepSeek', tip: 'deepseek-chat · 按量付费' }
]

const currentTitle = computed(() => {
  const s = sessions.value.find((x) => x.id === activeId.value)
  return s ? s.title || '新会话' : '新会话'
})

function newId() {
  return (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

function cid(id) {
  return 'web:' + id
}

async function loadModelSetting(id) {
  try {
    const res = await fetch('/api/conversations/' + encodeURIComponent(cid(id)) + '/setting')
    if (!res.ok) {
      model.value = 'zhipu'
      return
    }
    const data = await res.json()
    model.value = data.preferredModel === 'deepseek' ? 'deepseek' : 'zhipu'
  } catch {
    model.value = 'zhipu'
  }
}

// 把当前会话的模型偏好 + DeepSeek 授权写回后端（失败静默，不影响聊天）
async function persistModelSetting() {
  if (!activeId.value) return
  try {
    await fetch('/api/conversations/' + encodeURIComponent(cid(activeId.value)) + '/setting', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scene: 'web',
        preferredModel: model.value,
        allowDeepseek: model.value === 'deepseek'
      })
    })
  } catch {
    // 后端接口不可用时忽略：请求仍带 provider，由后端按权限决定
  }
}

function selectModel(m) {
  model.value = m
  persistModelSetting()
}

async function checkHealth() {
  try {
    const res = await fetch('/api/health')
    const data = await res.json()
    serverOnline.value = data.status === 'ok'
  } catch {
    serverOnline.value = false
  }
}

async function loadSessions() {
  try {
    const res = await fetch('/api/sessions')
    if (!res.ok) return
    const list = await res.json()
    sessions.value = list.map((s) => {
      const id = s.conversationId.startsWith('web:') ? s.conversationId.slice(4) : s.conversationId
      return { id, title: s.title, lastTime: s.lastTime, msgCount: s.msgCount }
    })
    if (activeId.value && !sessions.value.some((s) => s.id === activeId.value)) {
      activeId.value = null
    }
  } catch {
    sessions.value = []
  }
}

async function loadMessages(id) {
  try {
    const res = await fetch('/api/sessions/' + encodeURIComponent(cid(id)) + '/messages')
    const rows = await res.json()
    messages.value = rows
      .filter((r) => r.direction === 'RECEIVED' || r.direction === 'SENT')
      .map((r) => ({
        role: r.direction === 'RECEIVED' ? 'user' : 'assistant',
        content: r.content,
        provider: r.provider || '',
        ragUsed: !!r.useRag
      }))
  } catch {
    messages.value = []
  }
}

function newSession() {
  const id = newId()
  sessions.value.unshift({ id, title: '新会话', lastTime: new Date().toISOString(), msgCount: 0 })
  activeId.value = id
  messages.value = []
  model.value = 'zhipu'
  scrollToBottom()
}

async function selectSession(id) {
  if (sending.value) return
  activeId.value = id
  await loadMessages(id)
  await loadModelSetting(id)
  scrollToBottom()
}

async function deleteSession(id) {
  if (sending.value) return
  try {
    await fetch('/api/sessions/' + encodeURIComponent(cid(id)), { method: 'DELETE' })
  } catch {
    // 忽略删除失败，仅本地移除
  }
  sessions.value = sessions.value.filter((s) => s.id !== id)
  if (activeId.value === id) {
    const next = sessions.value[0]
    if (next) {
      activeId.value = next.id
      await loadMessages(next.id)
    } else {
      activeId.value = null
      messages.value = []
    }
  }
}

async function send() {
  const text = input.value.trim()
  if (!text || sending.value) return

  if (!activeId.value) {
    newSession()
  }
  const id = activeId.value

  messages.value.push({ role: 'user', content: text })
  input.value = ''
  sending.value = true
  scrollToBottom()

  const idx = messages.value.length
  messages.value.push({ role: 'assistant', content: '', pending: true })

  // 选 DeepSeek 时先确保该会话已授权（未授权后端会自动回落免费模型）
  if (model.value === 'deepseek') {
    await persistModelSetting()
  }

  try {
    const res = await fetch('/api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'web',
        content: text,
        useRag: ragEnabled.value,
        scene: 'web',
        sessionId: id,
        provider: model.value
      })
    })
    const data = await res.json()
    messages.value[idx] = {
      role: 'assistant',
      content: data.reply || '（无回复内容）',
      provider: data.provider || '',
      ragUsed: !!data.ragUsed,
      fallback: model.value === 'deepseek' && data.provider !== 'deepseek'
    }
    await loadSessions()
  } catch {
    messages.value[idx] = {
      role: 'assistant',
      content: '⚠️ 无法连接后端服务，请确认 Java 服务（8080）已启动。',
      error: true
    }
  } finally {
    sending.value = false
    scrollToBottom()
  }
}

function clearMemory() {
  if (sending.value) return
  if (!activeId.value) {
    newSession()
  }
  const id = activeId.value
  sending.value = true
  messages.value.push({ role: 'user', content: '清空记忆' })
  fetch('/api/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'web', content: '清空记忆', useRag: ragEnabled.value, scene: 'web', sessionId: id })
  })
    .then((res) => res.json())
    .then((data) => {
      messages.value.push({ role: 'assistant', content: data.reply || '已清空。' })
    })
    .catch(() => {
      messages.value.push({ role: 'assistant', content: '⚠️ 清空失败，无法连接后端服务。', error: true })
    })
    .finally(() => {
      sending.value = false
      loadSessions()
      scrollToBottom()
    })
}

function timeAgo(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  const d = new Date(t)
  return d.getMonth() + 1 + '/' + d.getDate()
}

function scrollToBottom() {
  nextTick(() => {
    if (scrollBox.value) scrollBox.value.scrollTop = scrollBox.value.scrollHeight
  })
}

onMounted(async () => {
  await checkHealth()
  await loadSessions()
  if (sessions.value.length > 0) {
    await loadMessages(sessions.value[0].id)
    await loadModelSetting(sessions.value[0].id)
  } else {
    newSession()
  }
})
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <div class="sidebar-head">
        <div class="logo-title">
          <span class="logo">📚</span>
          <h1>本地知识助手</h1>
        </div>
        <button class="btn new" @click="newSession" :disabled="sending">＋ 新建</button>
      </div>
      <ul class="session-list">
        <li
          v-for="s in sessions"
          :key="s.id"
          :class="{ active: s.id === activeId }"
          @click="selectSession(s.id)"
        >
          <div class="s-body">
            <div class="s-title">{{ s.title || '新会话' }}</div>
            <div class="s-meta">{{ timeAgo(s.lastTime) }} · {{ s.msgCount }} 条</div>
          </div>
          <button class="s-del" title="删除会话" @click.stop="deleteSession(s.id)">✕</button>
        </li>
      </ul>
      <p v-if="sessions.length === 0" class="empty-side">暂无会话，点「新建」开始</p>
    </aside>

    <main class="panel">
      <header class="header">
        <div class="p-title">{{ currentTitle }}</div>
        <div class="controls">
          <div class="model-switch" title="选择本次对话使用的模型">
            <button
              v-for="m in MODELS"
              :key="m.id"
              type="button"
              class="model-btn"
              :class="{ on: model === m.id }"
              :title="m.tip"
              :disabled="sending"
              @click="selectModel(m.id)"
            >{{ m.label }}</button>
          </div>
          <label class="switch" :title="ragEnabled ? '提问时检索本地 Obsidian 笔记' : '普通闲聊，不检索笔记'">
            <input v-model="ragEnabled" type="checkbox" />
            <span class="slider"></span>
            <span class="switch-label">知识库检索</span>
          </label>
          <button class="btn" :disabled="sending" @click="clearMemory">清空记忆</button>
          <span class="status" :class="serverOnline ? 'online' : serverOnline === null ? 'checking' : 'offline'">
            {{ serverOnline === null ? '检测中…' : serverOnline ? '服务在线' : '服务离线' }}
          </span>
        </div>
      </header>

      <div ref="scrollBox" class="chat">
        <div v-for="(msg, i) in messages" :key="i" class="msg" :class="msg.role">
          <div class="bubble">
            <template v-if="msg.pending">
              <span class="dot"></span><span class="dot"></span><span class="dot"></span>
            </template>
            <template v-else>
              {{ msg.content }}
              <span v-if="msg.provider === 'deepseek'" class="model-tag ds" title="由 DeepSeek 生成（付费）">⚡ DeepSeek</span>
              <span v-else-if="msg.provider === 'zhipu'" class="model-tag zp" title="由智谱 GLM-4.7-Flash 生成（免费）">GLM-4.7</span>
              <span v-if="msg.ragUsed" class="rag-tag" title="本次回答基于本地笔记">📄 RAG</span>
              <span v-if="msg.fallback" class="model-tag fb" title="DeepSeek 不可用或未授权，已自动使用免费模型">回落免费</span>
            </template>
          </div>
        </div>
        <p v-if="messages.length === 0" class="empty">发送一条消息开始对话</p>
      </div>

      <footer class="input-bar">
        <textarea
          v-model="input"
          rows="1"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          @keydown.enter.exact.prevent="send"
        ></textarea>
        <button class="btn primary" :disabled="sending || !input.trim()" @click="send">
          {{ sending ? '…' : '发送' }}
        </button>
      </footer>
    </main>
  </div>
</template>
