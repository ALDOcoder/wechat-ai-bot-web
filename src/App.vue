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
const sidebarOpen = ref(false)
const inputBox = ref(null)

// 模型选择：zhipu=智谱 GLM-4.7-Flash（免费，默认），deepseek=DeepSeek（付费，需授权）
const model = ref('zhipu')
const MODELS = [
  { id: 'zhipu', label: 'GLM-4.7', icon: '⚡', tip: '智谱 GLM-4.7-Flash · 免费' },
  { id: 'glm4flash', label: 'GLM-4', icon: '🚀', tip: '智谱 GLM-4-Flash · 免费备选，主力限流时切换' },
  { id: 'deepseek', label: 'DeepSeek', icon: '💎', tip: 'deepseek-chat · 按量付费，需授权' }
]
const modelMenuOpen = ref(false)
const currentModel = computed(() => MODELS.find((m) => m.id === model.value) || MODELS[0])

const currentTitle = computed(() => {
  const s = sessions.value.find((x) => x.id === activeId.value)
  return s ? s.title || '新会话' : '新会话'
})

// 会话按最后活跃时间分组（今天 / 7 天内 / 30 天内 / 更早）
const groupedSessions = computed(() => {
  const groups = [
    { label: '今天', items: [] },
    { label: '7 天内', items: [] },
    { label: '30 天内', items: [] },
    { label: '更早', items: [] }
  ]
  const day = 86400000
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  for (const s of sessions.value) {
    const t = new Date(s.lastTime).getTime()
    if (Number.isNaN(t) || t < startOfToday.getTime() - 30 * day) groups[3].items.push(s)
    else if (t >= startOfToday.getTime()) groups[0].items.push(s)
    else if (t >= startOfToday.getTime() - 7 * day) groups[1].items.push(s)
    else groups[2].items.push(s)
  }
  return groups.filter((g) => g.items.length > 0)
})

function newId() {
  return (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

function cid(id) {
  return 'web:' + id
}

// textarea 随内容自动增高，上限 160px
function autoResize() {
  const el = inputBox.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}

async function loadModelSetting(id) {
  try {
    const res = await fetch('/api/conversations/' + encodeURIComponent(cid(id)) + '/setting')
    if (!res.ok) {
      model.value = 'zhipu'
      return
    }
    const data = await res.json()
    // preferredModel 合法值：zhipu / glm4flash / deepseek，其余按默认处理
    model.value = ['zhipu', 'glm4flash', 'deepseek'].includes(data.preferredModel)
      ? data.preferredModel
      : 'zhipu'
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
  modelMenuOpen.value = false
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
  sidebarOpen.value = false
  scrollToBottom()
}

async function selectSession(id) {
  if (sending.value) return
  activeId.value = id
  sidebarOpen.value = false
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
  nextTick(autoResize)
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

function scrollToBottom() {
  nextTick(() => {
    if (scrollBox.value) scrollBox.value.scrollTop = scrollBox.value.scrollHeight
  })
}

// ---------- RAG 知识库设置卡片 ----------
const ragCardOpen = ref(false)
const ragLoading = ref(false)
const ragStatus = ref(null) // { enabled, vaultPath, files, chunks, lastError }
const ragBase = ref([])
const ragRules = ref([])
const newPattern = ref('')
const newRemark = ref('')
const ragError = ref('')
const pendingDeleteId = ref(null)

// 增删改的响应里自带重建后的 files/chunks，直接刷新状态区，不必再调 refresh
function applyIndexInfo(data) {
  if (!ragStatus.value) ragStatus.value = {}
  if (typeof data.files === 'number') ragStatus.value.files = data.files
  if (typeof data.chunks === 'number') ragStatus.value.chunks = data.chunks
  if (typeof data.lastError === 'string') ragStatus.value.lastError = data.lastError
}

async function openRagCard() {
  ragCardOpen.value = true
  sidebarOpen.value = false
  ragError.value = ''
  await loadRagCard()
}

async function loadRagCard() {
  ragLoading.value = true
  try {
    const [statusRes, patternsRes] = await Promise.all([
      fetch('/api/rag/status'),
      fetch('/api/rag/patterns')
    ])
    if (statusRes.ok) ragStatus.value = await statusRes.json()
    if (patternsRes.ok) {
      const data = await patternsRes.json()
      ragBase.value = data.basePatterns || []
      ragRules.value = data.patterns || []
    }
  } catch {
    ragError.value = '⚠️ 无法连接后端服务，请确认 Java 服务（8080）已启动。'
  } finally {
    ragLoading.value = false
  }
}

async function addPattern() {
  const pattern = newPattern.value.trim()
  if (!pattern || ragLoading.value) return
  ragError.value = ''
  try {
    const res = await fetch('/api/rag/patterns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, remark: newRemark.value.trim() })
    })
    if (res.ok) {
      const data = await res.json()
      ragRules.value.push(data.row)
      applyIndexInfo(data)
      newPattern.value = ''
      newRemark.value = ''
    } else {
      // 400 的响应体是纯文本提示，直接展示
      ragError.value = (await res.text()) || '添加失败'
    }
  } catch {
    ragError.value = '⚠️ 无法连接后端服务'
  }
}

async function togglePattern(row) {
  ragError.value = ''
  try {
    const res = await fetch('/api/rag/patterns/' + row.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !row.enabled })
    })
    if (res.ok) {
      const data = await res.json()
      const idx = ragRules.value.findIndex((r) => r.id === row.id)
      if (idx !== -1) ragRules.value[idx] = data.row
      applyIndexInfo(data)
    } else if (res.status === 404) {
      await loadRagCard() // 规则已被别处删除，刷新列表
    } else {
      ragError.value = (await res.text()) || '操作失败'
    }
  } catch {
    ragError.value = '⚠️ 无法连接后端服务'
  }
}

async function deletePattern(row) {
  ragError.value = ''
  try {
    const res = await fetch('/api/rag/patterns/' + row.id, { method: 'DELETE' })
    if (res.ok) {
      const data = await res.json()
      ragRules.value = ragRules.value.filter((r) => r.id !== row.id)
      applyIndexInfo(data)
    } else if (res.status === 404) {
      ragRules.value = ragRules.value.filter((r) => r.id !== row.id)
    } else {
      ragError.value = (await res.text()) || '删除失败'
    }
  } catch {
    ragError.value = '⚠️ 无法连接后端服务'
  } finally {
    pendingDeleteId.value = null
  }
}

function formatDate(iso) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
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
    <!-- 移动端抽屉遮罩 -->
    <div class="sidebar-backdrop" :class="{ show: sidebarOpen }" @click="sidebarOpen = false"></div>

    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <div class="sidebar-head">
        <div class="logo-title">
          <span class="logo">📚</span>
          <h1>本地知识助手</h1>
        </div>
        <button class="s-close" title="关闭列表" @click="sidebarOpen = false">✕</button>
      </div>
      <div class="sidebar-body">
        <button class="new-chat" :disabled="sending" @click="newSession">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <circle cx="12" cy="12" r="9.2" />
            <path d="M12 8.5v7M8.5 12h7" />
          </svg>
          开启新对话
        </button>

        <div v-for="g in groupedSessions" :key="g.label" class="session-group">
          <div class="group-label">{{ g.label }}</div>
          <ul class="session-list">
            <li
              v-for="s in g.items"
              :key="s.id"
              :class="{ active: s.id === activeId }"
              @click="selectSession(s.id)"
            >
              <div class="s-title">{{ s.title || '新会话' }}</div>
              <button class="s-del" title="删除会话" @click.stop="deleteSession(s.id)">✕</button>
            </li>
          </ul>
        </div>

        <p v-if="sessions.length === 0" class="empty-side">暂无会话，点「开启新对话」开始</p>
      </div>
      <div class="sidebar-foot">
        <button class="rag-entry" @click="openRagCard">
          <span aria-hidden="true">🗂️</span>RAG 知识库设置
        </button>
      </div>
    </aside>

    <main class="panel">
      <!-- 会话中：顶栏 + 消息流 + 底部输入舱 -->
      <template v-if="messages.length > 0">
        <header class="header">
          <button class="hamburger" title="会话列表" @click="sidebarOpen = true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <div class="p-title">{{ currentTitle }}</div>
          <div class="controls">
            <button class="btn" :disabled="sending" @click="clearMemory">清空记忆</button>
            <span class="status" :class="serverOnline ? 'online' : serverOnline === null ? 'checking' : 'offline'">
              {{ serverOnline === null ? '检测中…' : serverOnline ? '服务在线' : '服务离线' }}
            </span>
          </div>
        </header>

        <div ref="scrollBox" class="chat">
          <div class="chat-inner">
            <div v-for="(msg, i) in messages" :key="i" class="msg" :class="msg.role">
              <div v-if="msg.role === 'assistant'" class="avatar" aria-hidden="true">✨</div>
              <div class="bubble">
                <template v-if="msg.pending">
                  <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                </template>
                <template v-else>
                  {{ msg.content }}
                  <span v-if="msg.provider === 'deepseek'" class="model-tag ds" title="由 DeepSeek 生成（付费）">⚡ DeepSeek</span>
                  <span v-else-if="msg.provider === 'zhipu'" class="model-tag zp" title="由智谱 GLM-4.7-Flash 生成（免费）">GLM-4.7</span>
                  <span v-else-if="msg.provider === 'glm4flash'" class="model-tag g4" title="由智谱 GLM-4-Flash 生成（免费备选）">GLM-4</span>
                  <span v-if="msg.ragUsed" class="rag-tag" title="本次回答基于本地笔记">📄 RAG</span>
                  <span v-if="msg.fallback" class="model-tag fb" title="DeepSeek 不可用或未授权，已自动使用免费模型">回落免费</span>
                </template>
              </div>
            </div>
          </div>
        </div>

        <footer class="input-bar">
          <div class="composer">
            <textarea
              ref="inputBox"
              v-model="input"
              rows="1"
              placeholder="给本地知识助手发送消息"
              @keydown.enter.exact.prevent="send"
              @input="autoResize"
            ></textarea>
            <div class="composer-foot">
              <div class="composer-tools">
                <div class="model-select">
                  <button
                    type="button"
                    class="model-pill"
                    :title="currentModel.tip"
                    :disabled="sending"
                    @click="modelMenuOpen = !modelMenuOpen"
                  >
                    <span aria-hidden="true">{{ currentModel.icon }}</span>{{ currentModel.label }}
                    <svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  <template v-if="modelMenuOpen">
                    <div class="menu-backdrop" @click="modelMenuOpen = false"></div>
                    <div class="model-menu">
                      <button
                        v-for="m in MODELS"
                        :key="m.id"
                        type="button"
                        class="model-menu-item"
                        :class="{ on: model === m.id }"
                        @click="selectModel(m.id)"
                      >
                        <span aria-hidden="true">{{ m.icon }}</span>
                        <span class="mi-body">
                          <span class="mi-label">{{ m.label }}</span>
                          <span class="mi-tip">{{ m.tip }}</span>
                        </span>
                        <svg v-if="model === m.id" class="check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      </button>
                    </div>
                  </template>
                </div>
                <label
                  class="rag-pill"
                  :class="{ on: ragEnabled }"
                  :title="ragEnabled ? '提问时检索本地 Obsidian 笔记' : '普通闲聊，不检索笔记'"
                >
                  <input v-model="ragEnabled" type="checkbox" />
                  <span aria-hidden="true">📄</span>知识库检索
                </label>
              </div>
              <button class="send-btn" :disabled="sending || !input.trim()" title="发送" @click="send">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>
        </footer>
      </template>

      <!-- 欢迎页：居中 logo + 模型胶囊 + 输入舱 -->
      <template v-else>
        <div class="stage">
          <div class="stage-top">
            <button class="hamburger" title="会话列表" @click="sidebarOpen = true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>
            <span class="status" :class="serverOnline ? 'online' : serverOnline === null ? 'checking' : 'offline'">
              {{ serverOnline === null ? '检测中…' : serverOnline ? '服务在线' : '服务离线' }}
            </span>
          </div>

          <div class="welcome">
            <div class="welcome-row">
              <span class="welcome-logo" aria-hidden="true">📚</span>
              <h2>随时开始吧</h2>
            </div>
            <p class="welcome-sub">基于本地 Obsidian 笔记的 AI 问答助手</p>

            <div class="composer">
              <textarea
                ref="inputBox"
                v-model="input"
                rows="1"
                placeholder="给本地知识助手发送消息"
                @keydown.enter.exact.prevent="send"
                @input="autoResize"
              ></textarea>
              <div class="composer-foot">
                <div class="composer-tools">
                  <div class="model-select">
                    <button
                      type="button"
                      class="model-pill"
                      :title="currentModel.tip"
                      :disabled="sending"
                      @click="modelMenuOpen = !modelMenuOpen"
                    >
                      <span aria-hidden="true">{{ currentModel.icon }}</span>{{ currentModel.label }}
                      <svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    <template v-if="modelMenuOpen">
                      <div class="menu-backdrop" @click="modelMenuOpen = false"></div>
                      <div class="model-menu">
                        <button
                          v-for="m in MODELS"
                          :key="m.id"
                          type="button"
                          class="model-menu-item"
                          :class="{ on: model === m.id }"
                          @click="selectModel(m.id)"
                        >
                          <span aria-hidden="true">{{ m.icon }}</span>
                          <span class="mi-body">
                            <span class="mi-label">{{ m.label }}</span>
                            <span class="mi-tip">{{ m.tip }}</span>
                          </span>
                          <svg v-if="model === m.id" class="check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        </button>
                      </div>
                    </template>
                  </div>
                  <label
                    class="rag-pill"
                    :class="{ on: ragEnabled }"
                    :title="ragEnabled ? '提问时检索本地 Obsidian 笔记' : '普通闲聊，不检索笔记'"
                  >
                    <input v-model="ragEnabled" type="checkbox" />
                    <span aria-hidden="true">📄</span>知识库检索
                  </label>
                </div>
                <button class="send-btn" :disabled="sending || !input.trim()" title="发送" @click="send">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </main>

    <!-- RAG 知识库设置卡片 -->
    <div v-if="ragCardOpen" class="modal-backdrop" @click.self="ragCardOpen = false">
      <div class="rag-card">
        <header class="rag-head">
          <h2>🗂️ RAG 知识库设置</h2>
          <button class="modal-close" title="关闭" @click="ragCardOpen = false">✕</button>
        </header>

        <div class="rag-status">
          <template v-if="ragStatus">
            <span class="rag-enabled" :class="ragStatus.enabled ? 'on' : 'off'">
              {{ ragStatus.enabled ? '✅ 检索已启用' : '⛔ 检索已停用' }}
            </span>
            <span class="rag-nums">{{ ragStatus.files ?? '–' }} 文件 · {{ ragStatus.chunks ?? '–' }} 块</span>
            <span class="rag-vault" :title="ragStatus.vaultPath">📚 {{ ragStatus.vaultPath }}</span>
          </template>
          <span v-else class="rag-nums">{{ ragLoading ? '加载中…' : '状态不可用' }}</span>
        </div>
        <p v-if="ragStatus && ragStatus.lastError" class="rag-error">索引异常：{{ ragStatus.lastError }}</p>

        <section class="rag-section">
          <h3>基线规则（不可移除）</h3>
          <div class="chip-row">
            <span v-for="b in ragBase" :key="b" class="chip">{{ b }}</span>
            <span v-if="!ragBase.length && !ragLoading" class="rag-nums">无</span>
          </div>
        </section>

        <section class="rag-section">
          <h3>自定义规则（变更立即生效并重建索引）</h3>
          <ul class="rule-list">
            <li v-for="r in ragRules" :key="r.id" class="rule-row" :class="{ off: !r.enabled }">
              <div class="rule-main">
                <div class="rule-pattern" :title="r.pattern">{{ r.pattern }}</div>
                <div class="rule-meta" :title="r.remark || ''">
                  {{ r.remark || '无备注' }}<template v-if="r.updatedAt"> · {{ formatDate(r.updatedAt) }}</template>
                </div>
              </div>
              <template v-if="pendingDeleteId === r.id">
                <span class="rule-confirm">确认删除？</span>
                <button class="mini-btn danger" @click="deletePattern(r)">删除</button>
                <button class="mini-btn" @click="pendingDeleteId = null">取消</button>
              </template>
              <template v-else>
                <label class="mini-switch" title="启用 / 停用该规则">
                  <input type="checkbox" :checked="r.enabled" @change="togglePattern(r)" />
                  <span class="mini-slider"></span>
                </label>
                <button class="rule-del" title="删除规则" @click="pendingDeleteId = r.id">✕</button>
              </template>
            </li>
            <li v-if="!ragRules.length && !ragLoading" class="rule-empty">暂无自定义规则</li>
          </ul>

          <div class="rule-add">
            <input
              v-model="newPattern"
              class="rule-input"
              placeholder="路径包含匹配，如：私人目录 / 40-Diary"
              @keydown.enter="addPattern"
            />
            <input v-model="newRemark" class="rule-input remark" placeholder="备注（可选）" @keydown.enter="addPattern" />
            <button class="btn primary" :disabled="!newPattern.trim() || ragLoading" @click="addPattern">＋ 添加</button>
          </div>
          <p v-if="ragError" class="rag-error">{{ ragError }}</p>
        </section>

        <p class="rag-note">提示：排除只作用于检索层，历史消息与已有对话记忆不受影响。</p>
      </div>
    </div>
  </div>
</template>
