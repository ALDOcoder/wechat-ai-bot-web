# wechat-ai-bot-web

wechat-ai-bot 的 Web 聊天面板（Vue 3 + Vite）。

- 后端仓库：https://github.com/ALDOcoder/wechat-ai-bot
- 本地开发：`npm install` → `npm run dev`，默认 http://127.0.0.1:5173
- `/api` 由 Vite 代理到后端 8080（已开启 xfwd 转发真实 IP）
- 请求带 `scene=web`，后端按客户端 IP 区分会话并落库 message_log

## 主要文件
- `src/App.vue`：聊天面板（健康检查、RAG 开关、清空记忆）

## 改代码之前
- 规范与决策：[开发规格说明书.md](开发规格说明书.md)（分层/命名/契约/坑清单/演进路线）
- 功能与接口清单：[项目介绍.md](项目介绍.md)；日常用法：[RAG使用指南.md](RAG使用指南.md)
- 验收线：`npm run check` 退出码必须为 0（结构不变量校验，`--report` 看现状债务，`--bump` 收紧基线）
