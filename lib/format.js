/**
 * 把 lark-cli 的 JSON 结果渲染成给模型读的纯文本。
 *
 * 原则：**保留可核对的坐标**（token、chat_id、sheet_id、message_id、revision），
 * 因为模型下一步往往要拿这些值继续调用；但把噪音字段（头像 URL、i18n 名、内部排版标记）
 * 丢掉，避免正文被无关内容挤掉。
 */
import { KIND_LABELS } from './link.js'

const RULE = '────────────────────────────'

/**
 * 截断到 maxChars，并明确告诉模型"还有多少没看到、怎么继续"。
 */
export function clip(text, maxChars, nextSteps) {
  const body = typeof text === 'string' ? text : String(text ?? '')
  if (maxChars <= 0 || body.length <= maxChars) return body
  const omitted = body.length - maxChars
  const tail = nextSteps === undefined ? '' : `\n${nextSteps}`
  return `${body.slice(0, maxChars)}\n\n…（已截断：本文共 ${body.length} 字符，这里返回前 ${maxChars} 字符，省略 ${omitted} 字符）${tail}`
}

function metaLine(pairs) {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${key}：${value}`)
    .join(' ｜ ')
}

/** 文档正文。 */
export function renderDoc({ title, kind, token, url, revision, scope, content, totalChars, tips, resources }) {
  const head = [
    title === undefined || title === '' ? undefined : title,
    metaLine([
      ['类型', KIND_LABELS[kind] ?? kind],
      ['token', token],
      ['修订', revision],
      ['范围', scope],
    ]),
    url === undefined ? undefined : `链接：${url}`,
    totalChars === undefined ? undefined : `字符数：${totalChars}`,
    RULE,
  ].filter((line) => line !== undefined && line !== '')

  const tail = []
  if (Array.isArray(resources) && resources.length > 0) {
    tail.push('', '文中引用的资源（正文只有占位，需要内容就再读一次）：')
    for (const item of resources) tail.push(`- ${item}`)
  }
  if (typeof tips === 'string' && tips !== '') {
    tail.push('', `lark-cli 提示：${oneLine(tips, 400)}`)
  }
  return `${head.join('\n')}\n${content}${tail.join('\n')}`
}

/** 电子表格的工作表清单。 */
export function renderWorkbook({ url, title, sheets }) {
  const lines = [`电子表格${title === undefined || title === '' ? '' : `：${title}`}`, url === undefined ? '' : `链接：${url}`, RULE]
  if (sheets.length === 0) {
    lines.push('这个表格里没有可见的工作表。')
    return lines.filter((l) => l !== '').join('\n')
  }
  lines.push(`共 ${sheets.length} 个工作表：`)
  sheets.forEach((sheet, index) => {
    const flags = []
    if (sheet.is_hidden === true) flags.push('隐藏')
    if (sheet.frozen_rows > 0) flags.push(`冻结 ${sheet.frozen_rows} 行`)
    if (sheet.merged_cells_count > 0) flags.push(`合并单元格 ${sheet.merged_cells_count} 处`)
    if (sheet.chart_count > 0) flags.push(`图表 ${sheet.chart_count}`)
    lines.push(
      `${index + 1}. ${sheet.sheet_name}（sheet_id=${sheet.sheet_id}，${sheet.row_count} 行 × ${sheet.column_count} 列` +
        `${flags.length > 0 ? `，${flags.join('，')}` : ''}）`,
    )
  })
  lines.push('', '下一步：用 feishu_sheet_read 指定 sheet（名称或 sheet_id）与 range（如 A1:F30）读取单元格内容。')
  return lines.join('\n')
}

/** 单元格区间（CSV）。 */
export function renderSheetCsv({ url, sheet, range, actualRange, csv, warning, hasMore }) {
  const lines = [
    `表格片段：${sheet}${range === undefined || range === '' ? '（未指定范围，按实际数据边界）' : ` ｜ ${range}`}`,
    metaLine([
      ['实际范围', actualRange],
      ['还有更多', hasMore === true ? '是（可缩小 range 或分页）' : undefined],
    ]),
    url === undefined ? undefined : `链接：${url}`,
    RULE,
    csv,
  ].filter((l) => l !== undefined)
  if (warning !== undefined && warning !== '') {
    lines.push('', `lark-cli 提示：${String(warning).slice(0, 600)}`)
  }
  return lines.join('\n')
}

/** 多维表格的表清单。 */
export function renderTables({ url, tables }) {
  const lines = [`多维表格`, url === undefined ? undefined : `链接：${url}`, RULE].filter((l) => l !== undefined)
  if (tables.length === 0) {
    lines.push('这个多维表格里没有可见的数据表。')
    return lines.join('\n')
  }
  lines.push(`共 ${tables.length} 张数据表：`)
  tables.forEach((table, index) => {
    lines.push(`${index + 1}. ${table.name}（table_id=${table.table_id}${table.revision !== undefined ? `，revision=${table.revision}` : ''}）`)
  })
  lines.push('', '下一步：用 feishu_bitable_read 指定 table（名称或 table_id）读取记录。')
  return lines.join('\n')
}

/** 多维表格记录（lark-cli 已经渲染成 markdown）。 */
export function renderRecords({ url, table, markdown, count }) {
  return [
    `多维表格记录：${table}`,
    url === undefined ? undefined : `链接：${url}`,
    count === undefined ? undefined : `返回 ${count} 条（单次上限 200，可用 offset 继续）`,
    RULE,
    markdown,
  ]
    .filter((l) => l !== undefined)
    .join('\n')
}

/** 群列表。 */
export function renderChats({ chats, query, types }) {
  const scope = types === undefined ? '群聊' : types
  const lines = [`${scope}${query === undefined || query === '' ? '' : `（关键词：${query}）`}：命中 ${chats.length} 个`, RULE]
  chats.forEach((chat, index) => {
    const flags = []
    if (chat.external === true) flags.push('外部群')
    if (chat.chat_mode === 'topic' || chat.chat_mode === 'TOPIC') flags.push('话题群')
    if (chat.description !== undefined && chat.description !== '') flags.push(chat.description)
    lines.push(`${index + 1}. ${chat.name || '(未命名)'}  ${chat.chat_id}${flags.length > 0 ? `\n   ${flags.join('｜')}` : ''}`)
  })
  lines.push('', '下一步：用 feishu_chat_history 按 chat_id 读消息。')
  return lines.join('\n')
}

function oneLine(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit)}…`
}

/** 群消息。 */
export function renderMessages({ chatName, chatId, messages, order, hasMore }) {
  const lines = [
    `会话：${chatName === undefined || chatName === '' ? chatId : `${chatName}（${chatId}）`}`,
    `消息 ${messages.length} 条（${order === 'asc' ? '时间正序' : '最新在前'}）${hasMore === true ? '，还有更早的消息' : ''}`,
    RULE,
  ]
  if (messages.length === 0) {
    lines.push('这个时间范围内没有消息（或机器人不在该会话里）。')
    return lines.join('\n')
  }
  messages.forEach((message) => {
    const sender = message.sender?.name ?? message.sender?.id ?? '未知发送者'
    const type = message.msg_type === undefined ? '' : ` [${message.msg_type}]`
    const deleted = message.deleted === true ? '（已撤回）' : ''
    const content = oneLine(message.content, 600)
    lines.push(`${message.create_time}  ${sender}${type}${deleted}  ${message.message_id}`)
    lines.push(`  ${content}`)
  })
  return lines.join('\n')
}

/** 跨会话消息搜索。 */
export function renderMessageSearch({ query, messages, hasMore, chatNames }) {
  const lines = [`消息搜索：${query === undefined || query === '' ? '(无关键词)' : query} ｜ 命中 ${messages.length} 条${hasMore === true ? '（还有更多）' : ''}`, RULE]
  if (messages.length === 0) {
    lines.push('没有命中的消息。可放宽时间范围、去掉 chat 限制，或改用更短的关键词。')
    return lines.join('\n')
  }
  messages.forEach((message) => {
    const sender = message.sender?.name ?? '未知发送者'
    const chat = chatNames?.get(message.chat_id)
    const where = chat === undefined ? message.chat_id : `${chat}（${message.chat_id}）`
    lines.push(`${message.create_time}  ${sender} ｜ ${where} ｜ ${message.message_id}`)
    lines.push(`  ${oneLine(message.content, 600)}`)
  })
  return lines.join('\n')
}

/** 文档搜索结果。 */
export function renderDocSearch({ query, results, hasMore }) {
  const lines = [`云文档搜索：${query} ｜ 命中 ${results.length} 条${hasMore === true ? '（还有更多，可翻页）' : ''}`, RULE]
  if (results.length === 0) {
    lines.push('没有结果。换个关键词，或确认这些文档对你可见。')
    return lines.join('\n')
  }
  results.forEach((item, index) => {
    const meta = item.result_meta ?? {}
    lines.push(`${index + 1}. ${stripHighlight(item.title_highlighted ?? '')}`)
    lines.push(`   类型：${meta.doc_types ?? '?'} ｜ 更新时间：${meta.update_time_iso ?? '?'} ｜ 编辑者：${meta.edit_user_name ?? '?'}`)
    if (meta.url !== undefined) lines.push(`   链接：${meta.url}`)
    const summary = stripHighlight(item.summary_highlighted ?? '')
    if (summary !== '') lines.push(`   摘要：${oneLine(summary, 160)}`)
  })
  return lines.join('\n')
}

/** 去掉搜索服务塞进标题里的 <h></h> 高亮标签。 */
function stripHighlight(text) {
  return String(text ?? '').replace(/<\/?h>/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * 妙记详情渲染：标题 + 总结 + 待办 + 章节 + 关键词。
 * 逐字稿不在这里——它由 CLI 落到本地文件，属于写盘行为，需要用户显式同意。
 */
export function renderMinutes({ minute }) {
  const token = String(minute?.minute_token ?? '')
  const title = String(minute?.title ?? '')
  const artifacts = minute?.artifacts ?? {}
  const lines = [`妙记${title === '' ? '' : `「${title}」`}：token=${token}`]
  if (typeof minute?.note_id === 'string' && minute.note_id !== '') lines.push(`note_id：${minute.note_id}`)

  const summary = typeof artifacts.summary === 'string' ? artifacts.summary.trim() : ''
  if (summary !== '') lines.push('', '## 总结', summary)

  const todos = Array.isArray(artifacts.todos) ? artifacts.todos : Array.isArray(artifacts.todo) ? artifacts.todo : []
  if (todos.length > 0) {
    lines.push('', `## 待办（${todos.length}）`)
    todos.forEach((todo, index) => {
      const text = typeof todo === 'string' ? todo : String(todo?.content ?? todo?.text ?? '')
      if (text !== '') lines.push(`${index + 1}. ${text}`)
    })
  }

  const chapters = Array.isArray(artifacts.chapters) ? artifacts.chapters : []
  if (chapters.length > 0) {
    lines.push('', `## 章节（${chapters.length}）`)
    chapters.forEach((chapter, index) => {
      const start = formatMs(chapter?.start_ms)
      const stop = formatMs(chapter?.stop_ms)
      const heading = String(chapter?.title ?? '')
      const body = String(chapter?.summary_content ?? '').trim()
      lines.push(`${index + 1}. [${start}-${stop}]${heading === '' ? '' : ` ${heading}`}`)
      if (body !== '') lines.push(`   ${body}`)
    })
  }

  const keywords = Array.isArray(artifacts.keywords) ? artifacts.keywords : Array.isArray(artifacts.keyword) ? artifacts.keyword : []
  if (keywords.length > 0) {
    const words = keywords.map((item) => (typeof item === 'string' ? item : String(item?.word ?? item?.name ?? ''))).filter((w) => w !== '')
    if (words.length > 0) lines.push('', `关键词：${words.join('、')}`)
  }

  if (lines.length === 1) lines.push('', '（这块妙记还没有总结/待办/章节内容，可能需要生成纪要或申请查看权限。）')
  return lines.join('\n')
}

function formatMs(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const total = Math.floor(ms / 1000)
  const minute = Math.floor(total / 60)
  const second = total % 60
  return `${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}
