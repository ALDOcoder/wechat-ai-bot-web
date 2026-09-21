// 文件树分组纯逻辑（无 Vue 依赖，可单独验证）
// 语义前提：持有效令牌时后端下发全库 .md 节点；status=protected 的是目录级「索引开关」节点，不是文件

export function stripSlash(p) {
  return p.replace(/\/+$/, '')
}

// 配置名（40-Life）与真实前缀（MyVault/40-Life）指同一个目录；老 localStorage 两种都可能存
export function isSamePrefix(a, b) {
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
}

// 「未索引」= 命中保护目录（可见但检索不到）；「已排除」= 命中排除规则或导航文件
export function isUnindexed(n) {
  return n.status === 'excluded' && /保护目录/.test(n.rule || '')
}

// 保护目录前缀 = 后端折叠节点（未加入索引时下发）∪ 本地「我加入过索引」记忆（此时后端不再下发节点）
function collectPrefixes(nodes, knownAdded) {
  const set = new Set(knownAdded.map(stripSlash))
  for (const n of nodes) if (n.status === 'protected') set.add(stripSlash(n.path))
  return [...set].sort((a, b) => b.split('/').length - a.split('/').length)
}

// 段序列匹配：目录可能出现在库里任意层级，返回剥离位（文件在该前缀之下时），否则 -1
function cutOf(path, prefixes) {
  const segs = path.split('/')
  for (const pre of prefixes) {
    const ps = pre.split('/')
    for (let i = 0; i + ps.length < segs.length; i++) {
      if (ps.every((s, j) => segs[i + j] === s)) return i + ps.length
    }
  }
  return -1
}

// 每个保护目录单独成组（其下文件后端已逐条下发），其余按首段目录分组。
// 若仍按 segs[0] 分组，库根下的包装层会把几十个文件塞进同一个巨型组（见 开发规格说明书 §10-P11）。
// 每个文件预先算好 show（组内相对路径），模板不再做路径运算。
export function buildTreeGroups(nodes, knownAdded) {
  const prefixes = collectPrefixes(nodes, knownAdded)
  const groups = new Map()
  const ensure = (key, label, patch) => {
    if (!groups.has(key)) {
      groups.set(key, { key, label, prefix: null, protectedNode: null, files: [], indexed: 0, excluded: 0 })
    }
    const g = groups.get(key)
    Object.assign(g, patch)
    return g
  }

  for (const n of nodes) {
    if (n.status === 'protected') {
      const pre = stripSlash(n.path)
      ensure(pre, n.dir || pre.split('/').pop(), { prefix: pre, protectedNode: n })
      continue
    }
    const segs = n.path.split('/')
    const cut = cutOf(n.path, prefixes)
    const pre = cut > 0 ? segs.slice(0, cut).join('/') : null
    // 组名一律用目录本名：后端不再下发折叠节点时（已加入索引）也不能让组名退化成整条前缀
    const g = ensure(
      pre || (segs.length > 1 ? segs[0] : '（根目录）'),
      pre ? segs[cut - 1] : segs.length > 1 ? segs[0] : '（根目录）',
      { prefix: pre }
    )
    const strip = pre ? cut : segs.length > 1 ? 1 : 0
    g.files.push({ ...n, show: strip ? segs.slice(strip).join('/') : n.path })
    if (n.status === 'indexed') g.indexed++
    else g.excluded++
  }

  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}
