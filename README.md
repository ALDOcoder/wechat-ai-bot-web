# wechat-ai-bot-web

wechat-ai-bot 的 Web 聊天面板（Vue 3 + Vite）。

- 后端仓库：https://github.com/ALDOcoder/wechat-ai-bot
- 本地开发：`npm install` → `npm run dev`，默认 http://127.0.0.1:5173
- `/api` 由 Vite 代理到后端 8080（已开启 xfwd 转发真实 IP）
- 请求带 `scene=web`，后端按客户端 IP 区分会话并落库 message_log

## 主要文件
- `src/App.vue`：聊天面板（健康检查、RAG 开关、清空记忆）
