/**
 * DocxXML → Markdown。
 *
 * 为什么需要：飞书 `docs +fetch` 在部分版本（企业内常见的 1.0.8x）即使传了
 * `--doc-format markdown`，返回的仍是 DocxXML（`<title>` `<p>` `<ul><li>` `<cite>`…）。
 * 把这些标签原样交给模型，既费 token 又干扰理解；交给渲染器又会丢结构。
 *
 * 这里做一个**保守**的降级：只处理已知的块级/行内标签，未知标签一律"拆标签、留文本"。
 * 不追求像素级还原文档样式，只保证**顺序正确、层级可读、链接与提及不丢**。
 */
const TAG_RE = /<\/?([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)(\/?)>/g

const HEADING = /^h([1-9])$/

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

function parseAttrs(raw) {
  const attrs = {}
  if (typeof raw !== 'string') return attrs
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g
  let m
  while ((m = re.exec(raw)) !== null) attrs[m[1]] = m[2]
  return attrs
}

/** 这个字符串像不像 DocxXML？不像就别动它。 */
export function looksLikeDocxXml(content) {
  return typeof content === 'string' && /<\/?(title|fragment|blockquote|p|ul|ol|li|h[1-9])\b/.test(content)
}

/**
 * @param {string} content DocxXML
 * @returns {{text: string, title?: string}}
 */
export function docxToMarkdown(content) {
  const source = typeof content === 'string' ? content : ''
  const lines = []
  let current = ''
  let title
  let quoteDepth = 0
  let listStack = []
  let pendingLink
  let skipDepth = 0

  const flushLine = () => {
    const text = current.replace(/[ \t]+$/g, '')
    current = ''
    if (text.trim() === '') {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
      return
    }
    const prefix = quoteDepth > 0 ? `${'> '.repeat(quoteDepth)}` : ''
    lines.push(prefix + text)
  }

  const blankLine = () => {
    flushLine()
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
  }

  const ensureNewline = () => {
    if (current !== '') flushLine()
  }

  let lastIndex = 0
  const appendText = (text) => {
    current += decodeEntities(text).replace(/\r\n?/g, '\n')
  }

  let match
  TAG_RE.lastIndex = 0
  while ((match = TAG_RE.exec(source)) !== null) {
    if (match.index > lastIndex) appendText(source.slice(lastIndex, match.index))
    lastIndex = TAG_RE.lastIndex

    const [whole, rawName, rawAttrs, selfClosing] = match
    const name = rawName.toLowerCase()
    const closing = whole.startsWith('</')
    const attrs = parseAttrs(rawAttrs)

    if (skipDepth > 0) {
      if (!closing && !selfClosing && name === 'style') skipDepth += 1
      if (closing && name === 'style') skipDepth -= 1
      continue
    }

    if (name === 'style' && !closing) {
      skipDepth = 1
      continue
    }

    if (name === 'fragment') continue

    if (name === 'title') {
      if (!closing) {
        const start = TAG_RE.lastIndex
        const end = source.indexOf('</title>', start)
        if (end >= start) {
          title = decodeEntities(source.slice(start, end)).trim()
          blankLine()
          current += `# ${title}`
          ensureNewline()
          lastIndex = end + '</title>'.length
          TAG_RE.lastIndex = lastIndex
        }
      }
      continue
    }

    const heading = HEADING.exec(name)
    if (heading !== null) {
      if (closing) ensureNewline()
      else {
        blankLine()
        current += `${'#'.repeat(Number(heading[1]))} `
      }
      continue
    }

    if (name === 'p' || name === 'div' || name === 'section') {
      if (closing) ensureNewline()
      else if (current !== '') ensureNewline()
      continue
    }

    if (name === 'blockquote') {
      if (closing) {
        ensureNewline()
        quoteDepth = Math.max(0, quoteDepth - 1)
      } else {
        blankLine()
        quoteDepth += 1
      }
      continue
    }

    if (name === 'ul' || name === 'ol') {
      if (closing) {
        ensureNewline()
        listStack.pop()
      } else {
        ensureNewline()
        listStack.push(name)
      }
      continue
    }

    if (name === 'li') {
      if (closing) ensureNewline()
      else {
        ensureNewline()
        const indent = '  '.repeat(Math.max(0, listStack.length - 1))
        const ordered = listStack[listStack.length - 1] === 'ol'
        current += `${indent}${ordered ? '1. ' : '- '}`
      }
      continue
    }

    if (name === 'b' || name === 'strong') {
      current += '**'
      continue
    }
    if (name === 'i' || name === 'em') {
      current += '_'
      continue
    }
    if (name === 'code') {
      current += '`'
      continue
    }

    if (name === 'a') {
      if (closing) {
        current += pendingLink === undefined ? '' : `](${pendingLink})`
        pendingLink = undefined
      } else {
        current += '['
        pendingLink = attrs.href ?? ''
      }
      continue
    }

    if (name === 'cite') {
      if (!closing) {
        const who = attrs['user-name'] ?? (attrs.type === 'user' ? attrs.name : undefined)
        const end = source.indexOf('</cite>', TAG_RE.lastIndex)
        const label = end >= 0 ? decodeEntities(source.slice(TAG_RE.lastIndex, end)).trim() : ''
        if (who !== undefined && who !== '') {
          current += `@${who}`
        } else if (attrs['file-type'] !== undefined || attrs.token !== undefined || attrs['doc-id'] !== undefined) {
          // 引用表格/文档/文件：保留类型与 token，否则读者根本不知道这里少了一块
          const kind = attrs['file-type'] ?? attrs.type ?? 'file'
          const token = attrs.token ?? attrs['doc-id'] ?? ''
          const title = label === '' ? '' : `${label}：`
          current += `[引用${kind}：${title}${token}]`
        } else if (label !== '') {
          current += `@${label}`
        }
        if (end >= 0) {
          TAG_RE.lastIndex = end + '</cite>'.length
          lastIndex = TAG_RE.lastIndex
        }
      }
      continue
    }

    if (name === 'img') {
      const name2 = attrs.name ?? ''
      current += name2 === '' ? '[图片]' : `[图片：${name2.split('/').pop()}]`
      continue
    }

    if (name === 'whiteboard') {
      if (!closing) current += '[画板]'
      continue
    }

    if (name === 'checkbox') {
      if (closing) ensureNewline()
      else {
        ensureNewline()
        current += attrs.done === 'true' ? '- [x] ' : '- [ ] '
      }
      continue
    }

    if (name === 'br') {
      ensureNewline()
      continue
    }

    if (name === 'sheet') {
      if (!closing) {
        const token = attrs.token ?? ''
        const sheetId = attrs['sheet-id'] ?? attrs.sheetid ?? ''
        current += `[内嵌电子表格：token=${token}${sheetId === '' ? '' : ` sheet-id=${sheetId}`}]`
        ensureNewline()
      }
      continue
    }

    if (name === 'bitable' || name === 'base') {
      if (!closing) {
        const token = attrs.token ?? ''
        const tableId = attrs['table-id'] ?? ''
        current += `[内嵌多维表格：token=${token}${tableId === '' ? '' : ` table-id=${tableId}`}]`
        ensureNewline()
      }
      continue
    }

    if (name === 'mention-doc' || name === 'mention-doc-v2') {
      if (!closing) {
        const token = attrs.token ?? ''
        const type = attrs.type ?? 'docx'
        const end = source.indexOf(`</${rawName}>`, TAG_RE.lastIndex)
        const label = end >= 0 ? decodeEntities(source.slice(TAG_RE.lastIndex, end)).trim() : ''
        current += `[引用文档：${label === '' ? '' : `${label}：`}${type} ${token}]`
        if (end >= 0) {
          TAG_RE.lastIndex = end + `</${rawName}>`.length
          lastIndex = TAG_RE.lastIndex
        }
      }
      continue
    }

    if (name === 'file' || name === 'video' || name === 'iframe' || name === 'audio') {
      if (!closing) {
        const label = attrs.name ?? attrs.title ?? ''
        const token = attrs.token ?? attrs.src ?? ''
        const kindLabel = name === 'file' ? '附件' : name === 'video' ? '视频' : name === 'audio' ? '音频' : '网页嵌入'
        current += `[${kindLabel}${label === '' ? '' : `：${label}`}${token === '' ? '' : `（${token}）`}]`
      }
      continue
    }

    if (name === 'table') {
      ensureNewline()
      continue
    }
    if (name === 'tr') {
      ensureNewline()
      current += '| '
      continue
    }
    if (name === 'td' || name === 'th') {
      if (closing) current += ' | '
      continue
    }

    // 其余标签：拆掉，保留内部文本（grid/column/readonly-block/callout…）
  }
  if (lastIndex < source.length) appendText(source.slice(lastIndex))
  flushLine()

  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  return { text, title }
}

/** 从正文里取标题：优先 <title>，其次首个一级标题。 */
export function extractDocTitle(content) {
  const text = String(content ?? '')
  const tagged = /<title>([\s\S]*?)<\/title>/.exec(text)
  if (tagged !== null) return decodeEntities(tagged[1]).trim()
  const heading = /^#\s+(.+)$/m.exec(text)
  return heading === null ? undefined : heading[1].trim()
}

/**
 * 清理 markdown 里的残留 DocxXML 片段。
 *
 * 官方 `--doc-format im-markdown` 已经把正文转成 markdown，但仍会留下
 * `<title>`、`<fragment>`、`<at>`、`<excerpt>` 这类包裹/行内标签——
 * 直接丢给模型会干扰阅读，这里做最小清理，不做重新排版。
 */
export function cleanDocMarkdown(content) {
  let text = String(content ?? '')
  text = text.replace(/<\/?fragment[^>]*>/g, '')
  text = text.replace(/<title>([\s\S]*?)<\/title>/g, (_whole, title) => `# ${decodeEntities(title).trim()}`)
  // 提及之间要留空格，否则一串 @张三@李四 会粘成一片
  text = text.replace(/<at\s+[^>]*user_id="([^"]*)"[^>]*>([\s\S]*?)<\/at>/g, (_whole, _id, name) => `@${decodeEntities(name).trim()} `)
  // 内嵌资源在 im-markdown 里会以原样标签出现（常包在反引号里），换成可读占位
  text = text.replace(/<whiteboard\s+[^>]*token="([^"]*)"[^>]*>(?:<\/whiteboard>)?/g, (_w, token) => `[画板：${token}]`)
  text = text.replace(/<sheet\s+([^>]*)>(?:<\/sheet>)?/g, (_w, attrs) => `[内嵌电子表格${attrSuffix(attrs)}]`)
  text = text.replace(/<bitable\s+([^>]*)>(?:<\/bitable>)?/g, (_w, attrs) => `[内嵌多维表格${attrSuffix(attrs)}]`)
  // 日历日程、投票这类只读块：im-markdown 会原样保留标签
  text = text.replace(/<readonly-block\s+([^>]*)>(?:<\/readonly-block>)?/g, (_w, attrs) => {
    const type = /type="([^"]*)"/.exec(` ${attrs}`)
    const token = /token="([^"]*)"/.exec(` ${attrs}`)
    if (type !== null && type[1] === 'isv') return ''
    const label = type === null ? '只读块' : type[1] === 'calendar_event' ? '日历日程' : `只读块(${type[1]})`
    return `[${label}${token === null ? '' : `：token=${token[1]}`}]`
  })
  text = text.replace(/<excerpt([^>]*)>/g, (_whole, attrs) => {
    const top = /top-block-id="([^"]*)"/.exec(` ${attrs}`)
    return `\n[节选${top === null ? '' : `：top-block-id=${top[1]}`}]\n`
  })
  text = text.replace(/<\/excerpt>/g, '')
  // 占位符常被 im-markdown 包在反引号里（它原样输出了标签），把反引号去掉
  text = text.replace(/`(\[(?:画板|内嵌)[^\]]*\])`/g, '$1')
  // 注意：不要折叠行内空白——那会把 markdown 的列表缩进（2/4 空格）压平
  return text
    .replace(/[ \t]+(?=[，。；：、！？）])/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 把标签属性压成 `：token=… sheet-id=…` 的短尾巴。 */
function attrSuffix(attrs) {
  const parts = []
  for (const key of ['token', 'sheet-id', 'table-id']) {
    const found = new RegExp(`${key}="([^"]*)"`).exec(` ${attrs}`)
    if (found !== null && found[1] !== '') parts.push(`${key}=${found[1]}`)
  }
  return parts.length === 0 ? '' : `：${parts.join(' ')}`
}

/** 内容若是 DocxXML 就转成 markdown，否则做轻量清理后原样返回。 */
export function normalizeDocContent(content) {
  const raw = String(content ?? '')
  const title = extractDocTitle(raw)
  const cleaned = cleanDocMarkdown(raw)
  if (!looksLikeDocxXml(cleaned)) return { text: cleaned, title }
  return { ...docxToMarkdown(cleaned), title: title ?? docxToMarkdown(cleaned).title }
}


/**
 * 把 `reference_map` 压成几行可读的资源清单。
 * 文档里的内嵌表格/多维表格在 markdown 正文里只剩占位，真正的 token 在这个 sidecar 里。
 */
export function describeReferenceMap(map) {
  if (map === null || typeof map !== 'object') return []
  const picked = ['token', 'doc-id', 'doc_id', 'sheet-id', 'sheet_id', 'table-id', 'table_id', 'src-token', 'src-block-id', 'type']
  const lines = []
  for (const [group, refs] of Object.entries(map)) {
    if (group === 'comments' || refs === null || typeof refs !== 'object') continue
    for (const [ref, attrs] of Object.entries(refs)) {
      if (attrs === null || typeof attrs !== 'object') continue
      const parts = picked
        .filter((key) => typeof attrs[key] === 'string' && attrs[key] !== '')
        .map((key) => `${key}=${attrs[key]}`)
      if (parts.length === 0) continue
      lines.push(`${group}/${ref}（${parts.join(' ')}）`)
    }
  }
  return lines.slice(0, 20)
}
