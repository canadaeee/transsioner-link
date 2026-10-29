/**
 * 多维表格单元格的"说人话"层。
 *
 * lark-cli 的 `--format json` 给的是二维矩阵：关联字段只有 `[{id:"recXXX"}]`，
 * 公式字段给的是 Excel 序列号（46331.03064）。这两个都得翻译，
 * 否则读回来没法直接用。
 */

/** 关联字段：批量把 record_id 换成目标表的首列文字。 */
export function buildTitleMap(rows, recordIds) {
  const map = new Map()
  rows.forEach((row, index) => {
    const id = recordIds?.[index]
    if (typeof id !== 'string' || id === '') return
    for (const cell of row) {
      const text = plainText(cell)
      if (text !== '') {
        map.set(id, text)
        return
      }
    }
  })
  return map
}

/** 只取一个单元格的文字（不含对象兜底成 id 的行为）。 */
function plainText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = plainText(item)
      if (text !== '') return text
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const key of ['name', 'text', 'display_name', 'en_name']) {
      if (typeof value[key] === 'string' && value[key] !== '') return value[key]
    }
  }
  return ''
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

/**
 * Excel 日期序列号 → 本地日期时间。
 * 只认 1954–2064 这个区间（20000–60000 天），避免把普通数字公式误判成日期。
 */
export function excelSerialToDate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 20_000 || value >= 60_000) return undefined
  const ms = EXCEL_EPOCH_MS + Math.round(value * DAY_MS)
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return undefined
  const pad = (n) => String(n).padStart(2, '0')
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const fraction = value % 1
  if (fraction < 1 / 1440) return day
  const minutes = Math.round(fraction * 1440)
  return `${day} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/**
 * 把一个单元格渲染成字符串。
 * @param {unknown} value 原始值
 * @param {{type?: string, link_table?: string, style?: object}} field 字段元信息
 * @param {Map<string, Map<string, string>>} linkTitles link_table → (record_id → 标题)
 */
export function formatCell(value, field, linkTitles) {
  if (value === null || value === undefined) return ''

  if (field?.type === 'link' && Array.isArray(value)) {
    const table = linkTitles?.get(String(field.link_table ?? ''))
    return value
      .map((item) => {
        const id = typeof item?.id === 'string' ? item.id : ''
        if (id === '') return plainText(item)
        const title = table?.get(id)
        return title === undefined ? id : `${title}（${id}）`
      })
      .filter((text) => text !== '')
      .join('、')
  }

  if (field?.type === 'formula') {
    // 公式算出来的日期常带小数尾巴（46331.03064 = 00:44），那是算术残差不是时刻。
    // 只给日期，避免误导成"凌晨开会"。
    const date = excelSerialToDate(value)
    if (date !== undefined) return date.slice(0, 10)
  }

  if ((field?.type === 'datetime' || field?.type === 'date') && typeof value === 'string') {
    const pretty = prettyDateTime(value)
    if (pretty !== undefined) return pretty
  }

  if (typeof value === 'number' && field?.style?.percentage === true) {
    return `${Number((value * 100).toFixed(2))}%`
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : plainText(item)))
      .filter((text) => text !== '')
      .join('、')
  }

  if (typeof value === 'object') return plainText(value)
  return String(value)
}

/**
 * 字段清单渲染：每个字段的类型、单选/多选选项全集、关联到哪张表。
 */
export function renderFieldList({ url, table, fields }) {
  const lines = [
    `字段清单：${table}`,
    url === undefined ? undefined : `链接：${url}`,
    `共 ${fields.length} 个字段`,
    '────────────────────────────',
  ].filter((line) => line !== undefined)

  fields.forEach((field, index) => {
    const type = describeType(field)
    const extras = []
    const options = Array.isArray(field?.options) ? field.options : []
    if (options.length > 0) {
      const names = options.map((option) => (typeof option === 'string' ? option : String(option?.name ?? ''))).filter((n) => n !== '')
      if (names.length > 0) extras.push(`选项：${names.join(' / ')}`)
    }
    if (field?.multiple === true) extras.push('允许多选')
    if (typeof field?.expression === 'string' && field.expression !== '') extras.push(`公式：${field.expression}`)
    if (typeof field?.link_table === 'string' && field.link_table !== '') extras.push(`关联表：${field.link_table}`)
    lines.push(`${index + 1}. ${field?.name ?? '(未命名)'}  [${type}]${extras.length > 0 ? `\n   ${extras.join('；')}` : ''}`)
  })
  return lines.join('\n')
}

/**
 * 飞书的日期字段是 `2025-09-25T00:00:00.000+08:00` 这种 ISO 串。
 * 整点取日期，带时间就保留到分钟——宽表里能省很多列宽。
 */
export function prettyDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (match === null) return undefined
  const [, year, month, day, hour, minute] = match
  if (hour === '00' && minute === '00') return `${year}-${month}-${day}`
  return `${year}-${month}-${day} ${hour}:${minute}`
}

const TYPE_LABELS = {
  text: '文本',
  number: '数字',
  select: '单选/多选',
  multiSelect: '多选',
  datetime: '日期',
  date: '日期',
  link: '关联',
  formula: '公式',
  user: '人员',
  phone: '电话',
  url: '链接',
  attachment: '附件',
  checkbox: '复选框',
  created_at: '创建时间',
  updated_at: '更新时间',
  created_by: '创建人',
  updated_by: '更新人',
  lookup: '引用',
}

function describeType(field) {
  const type = String(field?.type ?? 'unknown')
  const label = TYPE_LABELS[type]
  return label === undefined ? type : `${label}/${type}`
}
