/**
 * 画板节点的读法。
 *
 * `whiteboard +export --output-type raw` 返回的是节点图：图形、连接线、表格容器，
 * 其中只有一部分节点带文字（`text.text`）。这里把它们按「从上到下、同一行从左到右」
 * 排成阅读顺序，输出给人看的文字，而不是 150KB 的原始 JSON。
 */

/** 同一行的判定阈值（px）。流程图一行通常对齐，间距过大就该换行。 */
const ROW_TOLERANCE = 40

function textOf(node) {
  const text = node?.text
  if (text === null || typeof text !== 'object') return ''
  const value = typeof text.text === 'string' ? text.text : ''
  return value.trim()
}

/**
 * 画板里的原生表格（`type: "table"`）。
 *
 * 这类节点的文字不在 `node.text.text` 里，而在 `table.cells[]` 的
 * `cell.text.text` 上，坐标是 1 起始的 `row_index` / `col_index`，
 * 行列总数在 `table.meta.row_num` / `col_num`。早期只读 `text.text`，
 * 于是流程图里的"阶段名 / 泳道名 / 门禁"整块消失——这里按网格取回来。
 *
 * @returns {Array<{id: string, title: string, rowNum: number, colNum: number, grid: string[][]}>}
 */
export function collectTables(nodes) {
  const tables = []
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (String(node?.type ?? '') !== 'table') continue
    const meta = node?.table?.meta ?? {}
    const cells = Array.isArray(node?.table?.cells) ? node.table.cells : []

    // meta 缺失时按 cell 坐标兜底，别整块丢掉
    let rowNum = Number(meta.row_num)
    let colNum = Number(meta.col_num)
    if (!Number.isSafeInteger(rowNum) || rowNum <= 0) {
      rowNum = cells.reduce((max, cell) => Math.max(max, Number(cell?.row_index) || 0), 0)
    }
    if (!Number.isSafeInteger(colNum) || colNum <= 0) {
      colNum = cells.reduce((max, cell) => Math.max(max, Number(cell?.col_index) || 0), 0)
    }
    if (rowNum <= 0 || colNum <= 0) continue

    const grid = Array.from({ length: rowNum }, () => Array.from({ length: colNum }, () => ''))
    for (const cell of cells) {
      const row = Number(cell?.row_index) - 1
      const col = Number(cell?.col_index) - 1
      if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col)) continue
      if (row < 0 || col < 0 || row >= rowNum || col >= colNum) continue
      grid[row][col] = textOf(cell)
    }
    // 整块都没有文字的表格不值得占篇幅
    if (grid.every((row) => row.every((cell) => cell === ''))) continue
    tables.push({
      id: String(node?.id ?? ''),
      title: String(node?.table?.title ?? '').trim(),
      rowNum,
      colNum,
      grid,
    })
  }
  return tables
}

function gridCell(text) {
  return String(text).replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|')
}

/** 把一块表格渲染成 Markdown 表格。 */
export function renderTableMarkdown({ title, grid }, index) {
  const heading = `表格 ${index + 1}${title === '' ? '' : `「${title}」`}（${grid.length} 行 × ${grid[0]?.length ?? 0} 列）`
  const width = Math.max(...grid.map((row) => row.length))
  const lines = [`${heading}`, `| ${Array.from({ length: width }, () => ' ').join(' | ')} |`, `| ${Array.from({ length: width }, () => '---').join(' | ')} |`]
  // 第一行当表头更有用：画板表格的首行通常就是字段名
  const [header, ...rest] = grid
  lines[1] = `| ${header.map(gridCell).join(' | ')} |`
  for (const row of rest) {
    const cells = Array.from({ length: width }, (_, i) => gridCell(row[i] ?? ''))
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}

/**
 * 抽取画板里的文字节点，按阅读顺序排序。
 * @returns {Array<{id: string, type: string, x: number, y: number, text: string}>}
 */
export function collectTextNodes(nodes) {
  const items = []
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const text = textOf(node)
    if (text === '') continue
    items.push({
      id: String(node?.id ?? ''),
      type: String(node?.type ?? ''),
      x: Number(node?.x ?? 0),
      y: Number(node?.y ?? 0),
      text,
    })
  }
  items.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))

  // 把 y 相近的节点并成一行，行内再按 x 排
  const rows = []
  for (const item of items) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= ROW_TOLERANCE)
    if (row === undefined) rows.push({ y: item.y, items: [item] })
    else row.items.push(item)
  }
  rows.sort((a, b) => a.y - b.y)
  for (const row of rows) row.items.sort((a, b) => a.x - b.x)
  return rows.flatMap((row) => row.items)
}

/**
 * 把一块画板渲染成 Markdown 列表。
 * @param {{token: string, nodes: Array<object>, title?: string}} input
 */
export function renderWhiteboard({ token, nodes, title }) {
  const all = Array.isArray(nodes) ? nodes : []
  const texts = collectTextNodes(all)
  const kinds = new Map()
  for (const node of all) {
    const type = String(node?.type ?? 'unknown')
    kinds.set(type, (kinds.get(type) ?? 0) + 1)
  }
  const kindLine = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}×${count}`)
    .join('、')

  const tables = collectTables(all)

  const head = [
    `画板${title === undefined || title === '' ? '' : `「${title}」`}：token=${token}`,
    `节点 ${all.length} 个（${kindLine === '' ? '空' : kindLine}），其中有文字 ${texts.length} 段${
      tables.length === 0 ? '' : `、表格 ${tables.length} 块`
    }`,
  ]

  if (texts.length === 0 && tables.length === 0) {
    head.push('——', '这块画板没有文字节点（可能全是图形/连接线），需要看图请用 whiteboard +export --output-type preview。')
    return head.join('\n')
  }

  const blocks = []
  if (texts.length > 0) {
    blocks.push(
      texts
        .map((item, index) => {
          const [first, ...rest] = item.text.split(/\r?\n/)
          const body = rest.map((line) => `   ${line}`).join('\n')
          const text = rest.length === 0 ? first : `${first}\n${body}`
          return `${index + 1}. ${text}`
        })
        .join('\n'),
    )
  }
  for (const [index, table] of tables.entries()) blocks.push(renderTableMarkdown(table, index))
  return `${head.join('\n')}\n——\n${blocks.join('\n\n')}`
}

const EPOCH_MS = 1000

/**
 * 把 `drive +list-comments` 的 items 渲染成可读文本。
 * @param {{items: Array<object>, names?: Map<string, string>, total?: number, solved?: string}} input
 */
export function renderComments({ items, names, total, solved, title, more }) {
  const list = Array.isArray(items) ? items : []
  const unresolved = list.filter((item) => item?.is_solved !== true).length
  const headline =
    more === true
      ? `文档评论${title === undefined || title === '' ? '' : `（${title}）`}：本次返回 ${list.length} 条（还有更多，可增大 limit）`
      : `文档评论${title === undefined || title === '' ? '' : `（${title}）`}：共 ${total ?? list.length} 条`
  const head = [
    headline,
    `未解决 ${unresolved} 条 ｜ 已解决 ${list.length - unresolved} 条${solved === 'all' ? '' : ` ｜ 筛选：${solved ?? '默认'}`}`,
  ]
  if (list.length === 0) return `${head.join('\n')}\n——\n没有评论。`

  const nameOf = (id) => {
    const key = typeof id === 'string' ? id : ''
    if (key === '') return '未知用户'
    return names?.get(key) ?? key
  }
  const when = (epoch) => {
    const seconds = Number(epoch)
    if (!Number.isFinite(seconds) || seconds <= 0) return ''
    return new Date(seconds * EPOCH_MS).toLocaleString('zh-CN', { hour12: false })
  }

  const blocks = list.map((item, index) => {
    const quote = String(item?.quote ?? '').trim().replace(/\s*\n\s*/g, ' / ')
    const where = String(item?.parent_type ?? '')
    const status = item?.is_solved === true ? '已解决' : '未解决'
    const replies = Array.isArray(item?.reply_list?.replies) ? item.reply_list.replies : []
    const author = nameOf(item?.user_id ?? replies[0]?.user_id)
    const lines = [
      `${index + 1}. ${author} ｜ ${when(item?.create_time)} ｜ ${status}${where === '' ? '' : ` ｜ ${where}`}`,
    ]
    if (quote !== '') lines.push(`   引用：${quote}`)
    const body = replyText(replies[0])
    if (body !== '') lines.push(`   评论：${body}`)
    replies.slice(1).forEach((reply, replyIndex) => {
      const text = replyText(reply)
      const author = nameOf(reply?.user_id)
      lines.push(`     回复 ${replyIndex + 1}（${author}${when(reply?.create_time) === '' ? '' : ` ${when(reply?.create_time)}`}）：${text}`)
    })
    if (replies.length === 0) lines.push('   （没有回复内容）')
    return lines.join('\n')
  })
  return `${head.join('\n')}\n——\n${blocks.join('\n\n')}`
}

/** 评论/回复的正文在 content.elements[].text_run.text 里，可能有多段。 */
export function replyText(reply) {
  const elements = Array.isArray(reply?.content?.elements) ? reply.content.elements : []
  const parts = []
  for (const element of elements) {
    const text = element?.text_run?.text
    if (typeof text === 'string' && text !== '') parts.push(text)
    const link = element?.docs_link?.url
    if (typeof link === 'string' && link !== '') parts.push(link)
    const person = element?.person?.user_id
    if (typeof person === 'string' && person !== '') parts.push(`@${person}`)
  }
  return parts.join('').trim()
}

/** 从评论列表里收集需要解析的 open_id（评论人 + 回复人）。 */
export function commentUserIds(items) {
  const ids = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.user_id === 'string' && item.user_id !== '') ids.add(item.user_id)
    for (const reply of Array.isArray(item?.reply_list?.replies) ? item.reply_list.replies : []) {
      if (typeof reply?.user_id === 'string' && reply.user_id !== '') ids.add(reply.user_id)
    }
  }
  return [...ids]
}
