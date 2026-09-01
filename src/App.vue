<script setup>
import { ref, onMounted, nextTick } from 'vue'

const SENDER = 'web'

const messages = ref([])
const input = ref('')
const ragEnabled = ref(true)
const sending = ref(false)
const serverOnline = ref(null)

const scrollBox = ref(null)

async function checkHealth() {
  try {
    const res = await fetch('/api/health')
    const data = await res.json()
    serverOnline.value = data.status === 'ok'
  } catch {
    serverOnline.value = false
  }
}

async function send() {
  const text = input.value.trim()
  if (!text || sending.value) return

  messages.value.push({ role: 'user', content: text })
  input.value = ''
  sending.value = true
  scrollToBottom()

  const id = messages.value.push({ role: 'assistant', content: '', pending: true })

  try {
    const res = await fetch('/api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: SENDER, content: text, useRag: ragEnabled.value, scene: 'web' })
    })
    const data = await res.json()
    messages.value[id - 1] = {
      role: 'assistant',
      content: data.reply || '（无回复内容）',
      ragUsed: !!data.ragUsed
    }
  } catch {
    messages.value[id - 1] = {
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
  sending.value = true
  messages.value.push({ role: 'user', content: '清空记忆' })
  fetch('/api/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: SENDER, content: '清空记忆', useRag: ragEnabled.value })
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
      scrollToBottom()
    })
}

function scrollToBottom() {
  nextTick(() => {
    if (scrollBox.value) scrollBox.value.scrollTop = scrollBox.value.scrollHeight
  })
}

onMounted(() => {
  checkHealth()
  messages.value.push({
    role: 'assistant',
    content: '你好，我是你的本地知识助手。打开右上角的「知识库检索」开关后，我可以基于你的 Obsidian 笔记回答问题。',
    ragUsed: false
  })
})
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="title">
        <span class="logo">📚</span>
        <h1>本地知识助手</h1>
      </div>
      <div class="controls">
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

    <main ref="scrollBox" class="chat">
      <div
        v-for="(msg, i) in messages"
        :key="i"
        class="msg"
        :class="msg.role"
      >
        <div class="bubble">
          <template v-if="msg.pending">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </template>
          <template v-else>
            {{ msg.content }}
            <span v-if="msg.ragUsed" class="rag-tag" title="本次回答基于本地笔记">📄 RAG</span>
          </template>
        </div>
      </div>
      <p v-if="messages.length === 0" class="empty">发送一条消息开始对话</p>
    </main>

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
  </div>
</template>
