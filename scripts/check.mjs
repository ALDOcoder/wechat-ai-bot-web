#!/usr/bin/env node
// 结构不变量校验器 · 用法见 开发规格说明书.md §7
//   node scripts/check.mjs            棘轮模式：新增违规才失败（退出码 1）
//   node scripts/check.mjs --report   打印现状全部违规（含基线内既有），退出码 0
//   node scripts/check.mjs --bump     用当前现状重写基线（收紧债务时人工执行）

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_FILE = join(ROOT, '.check-baseline.json')
const args = process.argv.slice(2)
const MODE = args.includes('--bump') ? 'bump' : args.includes('--report') ? 'report' : 'check'

const NEW_FILE_LINE_LIMIT = 400
const DUP_WINDOW = 15
const SIZE_TOLERANCE = 1.1
// 对外说明类文档参与"行数口径"校验；开发总结.md 是时间线快照，口径见 §7.4
const DOC_FILES = ['README.md', '项目介绍.md']
// 允许出现 fetch / /api/ 字面量的目录前缀（重构目标态）
const API_ALLOWED_DIRS = ['src/api/']

function walk(absDir, prefix, out) {
  for (const name of readdirSync(absDir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name === 'dist') continue
    const abs = join(absDir, name.name)
    const rel = prefix ? prefix + '/' + name.name : name.name
    if (name.isDirectory()) walk(abs, rel, out)
    else out.push(rel)
  }
  return out
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

function hash15(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(16)
}

const srcFiles = walk(join(ROOT, 'src'), 'src', []).filter((f) => /\.(vue|js|css)$/.test(f))
const measured = new Map()
for (const rel of srcFiles) measured.set(rel, read(rel))

// ---------- R1 体积 ----------
const sizes = {}
for (const [rel, text] of measured) sizes[rel] = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

// ---------- R2 契约层位置 ----------
function countApi(rel, text) {
  const fetches = (text.match(/\bfetch\(/g) || []).length
  const literals = (text.match(/['"`]\/api\//g) || []).length
  return { fetches, literals }
}
const apiUsage = {}
for (const [rel, text] of measured) {
  if (API_ALLOWED_DIRS.some((d) => rel.startsWith(d))) continue
  const { fetches, literals } = countApi(rel, text)
  if (fetches || literals) apiUsage[rel] = { fetches, literals }
}

// ---------- R3 颜色令牌 ----------
const hexOutsideRoot = {}
for (const [rel, text] of measured) {
  if (!rel.endsWith('.css') && !rel.endsWith('.vue')) continue
  const lines = text.split('\n')
  let depth = 0
  let inRoot = false
  let rootDepth = 0
  let count = 0
  for (const line of lines) {
    if (!inRoot && /:root\s*\{/.test(line)) {
      inRoot = true
      rootDepth = depth
    }
    count += inRoot ? 0 : (line.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
    if (inRoot && depth <= rootDepth) inRoot = false
  }
  if (count) hexOutsideRoot[rel] = count
}

// ---------- R4 重复模板块 ----------
const normCache = new Map()
function normLines(rel) {
  if (!normCache.has(rel)) {
    normCache.set(
      rel,
      measured.get(rel).split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
    )
  }
  return normCache.get(rel)
}
const windows = new Map()
const byFile = new Map()
for (const rel of measured.keys()) {
  if (!rel.endsWith('.vue')) continue
  const lines = normLines(rel)
  const stripped = []
  lines.forEach((l, idx) => {
    if (l !== '') stripped.push({ raw: l, line: idx + 1 })
  })
  const list = []
  for (let i = 0; i + DUP_WINDOW <= stripped.length; i++) {
    const h = hash15(stripped.slice(i, i + DUP_WINDOW).map((s) => s.raw).join('\n'))
    const entry = { hash: h, line: stripped[i].line }
    list.push(entry)
    if (!windows.has(h)) windows.set(h, [])
    windows.get(h).push({ rel, i })
  }
  byFile.set(rel, list)
}
const dupHashes = new Set()
for (const [h, list] of windows) if (list.length >= 2) dupHashes.add(h)

// 每份拷贝算一次 start：内容相同但被复制到第三处时，靠 start 计数才能发现
const allStarts = []
for (const [rel, list] of byFile) {
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (!dupHashes.has(entry.hash)) continue
    if (i > 0 && dupHashes.has(list[i - 1].hash)) continue
    let end = i
    while (end + 1 < list.length && dupHashes.has(list[end + 1].hash)) end++
    allStarts.push({ hash: entry.hash, where: rel + ':' + entry.line, length: DUP_WINDOW + (end - i) })
  }
}
const startsByHash = new Map()
for (const s of allStarts) {
  if (!startsByHash.has(s.hash)) startsByHash.set(s.hash, [])
  startsByHash.get(s.hash).push(s)
}
const dupRuns = [...startsByHash.values()].map((list) => ({
  hash: list[0].hash,
  where: list[0].where,
  length: list[0].length,
  starts: list.length,
}))

// ---------- R5 存储键 ----------
const storageKeys = new Set()
for (const [rel, text] of measured) {
  for (const m of text.matchAll(/(?:localStorage|sessionStorage)\.(?:get|set|remove)Item\(\s*['"`]([^'"`]+)['"`]/g)) {
    storageKeys.add(m[1])
  }
}

// ---------- R6 文档行数口径 ----------
const docDrift = []
for (const doc of DOC_FILES) {
  if (!existsSync(join(ROOT, doc))) continue
  const lines = read(doc).split('\n')
  lines.forEach((line, idx) => {
    const fileMatch = line.match(/([\w\-/.]+\.(?:vue|css|js|ts))/)
    const numMatch = line.match(/约?\s*(\d+)\s*行/)
    if (!fileMatch || !numMatch) return
    let rel = fileMatch[1]
    if (!measured.has(rel)) rel = rel.startsWith('src/') ? rel : 'src/' + rel
    const actual = sizes[rel]
    if (!actual) return
    const claimed = Number(numMatch[1])
    if (Math.abs(actual - claimed) / actual > (SIZE_TOLERANCE - 1) + 0.4) {
      docDrift.push({ key: doc + '|' + fileMatch[1] + '|' + claimed, doc, line: idx + 1, file: fileMatch[1], claimed, actual })
    }
  })
}

// ---------- 基线比对 ----------
const EMPTY_BASELINE = { sizes: {}, apiUsage: {}, hexOutsideRoot: {}, dupRuns: [], storageKeys: [], docDrift: [] }
const baseline = existsSync(BASELINE_FILE)
  ? JSON.parse(read('.check-baseline.json'))
  : MODE === 'check'
    ? null
    : EMPTY_BASELINE
const violations = []
const tighten = []

if (MODE === 'check' && !existsSync(BASELINE_FILE)) {
  console.log('缺少 .check-baseline.json，先执行：node scripts/check.mjs --bump')
  process.exit(1)
}

for (const [rel, n] of Object.entries(sizes)) {
  const limit = baseline.sizes[rel]
  if (limit === undefined) {
    if (n > NEW_FILE_LINE_LIMIT) violations.push(`R1 体积  新文件 ${rel} ${n} 行 > 上限 ${NEW_FILE_LINE_LIMIT} 行`)
  } else if (n > limit) {
    violations.push(`R1 体积  ${rel} ${n} 行 > 基线 ${limit} 行`)
  } else if (n < limit) {
    tighten.push(`R1 体积  ${rel} 已降至 ${n} 行（基线 ${limit}），记得 --bump 收紧`)
  }
}
for (const [rel, c] of Object.entries(apiUsage)) {
  const b = baseline.apiUsage?.[rel] || { fetches: 0, literals: 0 }
  if (c.fetches > b.fetches) violations.push(`R2 契约  ${rel} fetch( 调用 ${c.fetches} 处 > 基线 ${b.fetches} 处（传输只允许写在 src/api/）`)
  if (c.literals > b.literals) violations.push(`R2 契约  ${rel} '/api/ 字面量 ${c.literals} 处 > 基线 ${b.literals} 处（路径只允许写在 src/api/）`)
}
for (const [rel, c] of Object.entries(hexOutsideRoot)) {
  const b = baseline.hexOutsideRoot?.[rel] ?? 0
  if (c > b) violations.push(`R3 令牌  ${rel} :root 之外的颜色字面量 ${c} 处 > 基线 ${b} 处（颜色只能定义在 tokens 段）`)
}
const knownDup = new Map((baseline.dupRuns || []).map((d) => [d.hash, d]))
for (const run of dupRuns) {
  const b = knownDup.get(run.hash)
  if (!b) {
    violations.push(`R4 重复  新增 ${run.length} 行重复模板块（${run.starts} 份拷贝），起点 ${run.where}`)
  } else if (run.starts > b.starts) {
    violations.push(`R4 重复  既有 ${b.length} 行重复块（基线起点 ${b.where}）从 ${b.starts} 份拷贝增加到 ${run.starts} 份`)
  } else if (run.starts < b.starts) {
    tighten.push(`R4 重复  ${b.where} 重复块已从 ${b.starts} 份降到 ${run.starts} 份，记得 --bump 收紧`)
  }
}
for (const key of storageKeys) {
  if (!(baseline.storageKeys || []).includes(key)) {
    violations.push(`R5 存储  未登记的存储键 '${key}'（新增须同时写进 开发规格说明书.md §4.3 持久化表）`)
  }
}
for (const d of docDrift) {
  if (!(baseline.docDrift || []).includes(d.key)) {
    violations.push(`R6 文档  ${d.doc}:${d.line} 声称 ${d.file} 约 ${d.claimed} 行，实测 ${d.actual} 行`)
  }
}

// ---------- 输出 ----------
const current = { sizes, apiUsage, hexOutsideRoot, dupRuns, storageKeys: [...storageKeys].sort(), docDrift: docDrift.map((d) => d.key) }

console.log('结构不变量校验 · wechat-ai-bot-web')
console.log('模式：' + (MODE === 'bump' ? 'bump（重写基线）' : MODE === 'report' ? 'report（现状全量）' : 'check（棘轮，新增违规才失败）'))
console.log('')
console.log('实测口径：')
for (const [rel, n] of Object.entries(sizes).sort((a, b) => b[1] - a[1])) console.log(`  ${rel.padEnd(18)} ${String(n).padStart(5)} 行`)
console.log(`  API 字面量/调用     ${JSON.stringify(apiUsage)}`)
console.log(`  :root 外颜色字面量  ${JSON.stringify(hexOutsideRoot)}`)
console.log(`  ≥${DUP_WINDOW} 行重复块    ${dupRuns.length ? dupRuns.map((d) => `${d.where}（${d.length} 行 × ${d.starts} 份）`).join(', ') : '无'}`)
console.log(`  存储键              ${[...storageKeys].join(', ') || '无'}`)

if (MODE === 'report') {
  console.log('')
  console.log('当前全部违规（基线内的历史债务也算）：')
  const all = []
  for (const [rel, c] of Object.entries(apiUsage)) all.push(`R2 契约  ${rel}：fetch ${c.fetches} 处 / '/api/' ${c.literals} 处`)
  for (const [rel, c] of Object.entries(hexOutsideRoot)) all.push(`R3 令牌  ${rel}：:root 外颜色 ${c} 处`)
  for (const run of dupRuns) all.push(`R4 重复  ${run.where} 起 ${run.length} 行块，共 ${run.starts} 份拷贝（hash ${run.hash}）`)
  for (const d of docDrift) all.push(`R6 文档  ${d.doc}:${d.line} ${d.file} 声称 ${d.claimed} 行 / 实测 ${d.actual} 行`)
  console.log(all.length ? all.map((s) => '  - ' + s).join('\n') : '  无')
  process.exit(0)
}

if (MODE === 'bump') {
  writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2) + '\n', 'utf8')
  console.log('')
  console.log('已写入基线 ' + BASELINE_FILE.replace(ROOT + '/', ''))
  process.exit(0)
}

console.log('')
if (tighten.length) console.log(tighten.map((s) => 'ℹ️  ' + s).join('\n'))
if (violations.length) {
  console.log('❌ 新增违规：')
  console.log(violations.map((s) => '   - ' + s).join('\n'))
  console.log('')
  console.log('处置：按 开发规格说明书.md 对应章节改写代码后重跑。基线只在债务真实减少时用 --bump 收紧。')
  process.exit(1)
}
console.log('✅ 无新增违规（历史债务见 --report）')
