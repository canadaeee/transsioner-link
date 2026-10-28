/**
 * 飞书链接 / token 识别。
 *
 * 只做纯字符串判断，不发请求。需要知道"这个 wiki 节点背后是什么"的地方，
 * 由 index.js 调 `wiki +node-get` 解析——那是唯一权威，不在这里猜。
 */

/** URL 路径段 → 资源类型。 */
const PATH_KINDS = {
  docx: 'docx',
  docs: 'doc',
  wiki: 'wiki',
  sheets: 'sheet',
  base: 'bitable',
  bitable: 'bitable',
  slides: 'slides',
  mindnotes: 'mindnote',
  minutes: 'minutes',
  file: 'file',
  whiteboard: 'whiteboard',
  board: 'whiteboard',
}

/** token 前缀 → 资源类型（飞书 token 有稳定前缀，命中就先定类型，省一次解析）。 */
const PREFIX_KINDS = [
  [/^wikc/i, 'wiki'],
  [/^doxc/i, 'docx'],
  [/^docc/i, 'doc'],
  [/^shtc/i, 'sheet'],
  [/^basc/i, 'bitable'],
  [/^bmnc/i, 'bitable'],
  [/^fldc/i, 'folder'],
]

const TOKEN_RE = /^[A-Za-z0-9_-]{8,}$/

/**
 * @param {string} input 飞书链接或裸 token
 * @returns {{ok: true, kind: string, token: string, url?: string, host?: string} | {ok: false, detail: string}}
 */
export function parseTarget(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') return { ok: false, detail: '缺少飞书链接或 token。' }

  const url = raw.match(/^(https?:\/\/[^/\s]+)\/([A-Za-z]+)\/([A-Za-z0-9_-]+)/)
  if (url !== null) {
    const kind = PATH_KINDS[url[2].toLowerCase()]
    if (kind === undefined) {
      return {
        ok: false,
        detail: `识别不了 /${url[2]}/ 这种链接。支持：docx、docs、wiki、sheets、base、slides、minutes、file。`,
      }
    }
    return { ok: true, kind, token: url[3], url: raw, host: url[1] }
  }

  if (TOKEN_RE.test(raw)) {
    const hit = PREFIX_KINDS.find(([re]) => re.test(raw))
    return { ok: true, kind: hit?.[1] ?? 'token', token: raw }
  }

  return {
    ok: false,
    detail: `看不懂这个输入：${raw.slice(0, 120)}。请给完整的飞书链接，或 8 位以上的 token。`,
  }
}

/** 各类型的中文名，用于错误提示与标题。 */
export const KIND_LABELS = {
  docx: '新版文档',
  doc: '旧版文档',
  wiki: '知识库节点',
  sheet: '电子表格',
  bitable: '多维表格',
  slides: '幻灯片',
  mindnote: '思维笔记',
  minutes: '妙记',
  file: '云空间文件',
  whiteboard: '画板',
  token: '未知类型',
}

/** 读取文档类工具接受哪些 kind。 */
export const DOC_KINDS = new Set(['docx', 'doc', 'wiki', 'token'])
export const SHEET_KINDS = new Set(['sheet', 'token'])
export const BITABLE_KINDS = new Set(['bitable', 'token'])
