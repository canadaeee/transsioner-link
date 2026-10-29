/**
 * 飞书连接器 — 宿主插件入口。
 *
 * 只做一件事：把本机已登录的 `lark-cli` 的**只读**命令接成 Agent 能直接调用的 DSH 工具。
 * 认证、令牌刷新、分页、富文本渲染都由 lark-cli 承担；本插件不存凭据、不缓存正文、
 * 不重新实现飞书 API。
 *
 * 为什么不用 bash 跑 lark-cli：bash 工具在 workspace-write 沙箱里，lark-cli 刷新
 * 用户令牌时要写凭据库，会被沙箱拒掉。这里在宿主进程内直接 spawn（见 lib/cli.js），
 * 复用系统里唯一那份凭据。代价是**这些工具不受文件沙箱约束**——所以本插件只注册读命令，
 * 写操作一律不提供。
 */
import { createRunner, resolveLarkBin } from './lib/cli.js'
import { describeReferenceMap, extractDocTitle, normalizeDocContent } from './lib/docx.js'
import { commentUserIds, renderComments, renderWhiteboard } from './lib/whiteboard.js'
import { buildTitleMap, formatCell, renderFieldList } from './lib/bitable.js'
import { appendSetupHint, classifyStatus, renderBindGuide, renderScopeGuide } from './lib/setup.js'
import { BITABLE_KINDS, DOC_KINDS, KIND_LABELS, parseTarget, SHEET_KINDS } from './lib/link.js'
import {
  clip,
  renderChats,
  renderDoc,
  renderDocSearch,
  renderMessageSearch,
  renderMessages,
  renderMinutes,
  renderRecords,
  renderSheetCsv,
  renderTables,
  renderWorkbook,
} from './lib/format.js'

/** Cordis 插件名。 */
export const name = 'lark-connector'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_CHARS = 30_000
/** 单次最多返回的群/消息条数，防止一次调用把上下文塞满。 */
const MAX_LIST = 100
const MAX_MESSAGES = 50

/** 把行配置归一化成内部设置。错值不猜，直接回落到安全默认并留一条 note。 */
function normalizeSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const notes = []

  const str = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback)
  const int = (value, fallback, min, max) => {
    if (!Number.isSafeInteger(value)) return fallback
    if (value < min || value > max) return fallback
    return value
  }

  const identity = str(raw.identity, 'user').toLowerCase()
  if (identity !== 'user' && identity !== 'bot') {
    notes.push(`config.identity=${String(raw.identity)} 不支持，已按 user 处理。`)
  }

  return {
    larkBin: str(raw.larkBin),
    profile: str(raw.profile),
    // 部署时可选：填了就让引导里直接给这个 App ID；留空则用 <APP_ID> 占位符。
    // 源码里不内置任何人的应用 ID，避免随仓库/文档外泄。
    appId: str(raw.appId),
    identity: identity === 'bot' ? 'bot' : 'user',
    timeoutMs: int(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 600_000),
    maxChars: int(raw.maxChars, DEFAULT_MAX_CHARS, 1_000, 200_000),
    enableChat: raw.enableChat !== false,
    homeDir: str(raw.homeDir),
    notes,
  }
}

function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  }
}

/** 每个工具的注册都挂在自己的 effect 上：插件卸载即全部撤销。 */
function registerTool(scoped, tool) {
  scoped.effect(() => scoped.tools.register(tool), `lark-connector.${tool.name}`)
}

export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  const runner = createRunner(settings)

  /** open_id → 姓名。失败就退回 id，不影响评论本身可读。 */
  async function resolveNames(runner, items, exec) {
    const ids = commentUserIds(items)
    const names = new Map()
    if (ids.length === 0) return names
    for (let index = 0; index < ids.length; index += 20) {
      const chunk = ids.slice(index, index + 20)
      const result = await runner.runJson(
        ['contact', '+search-user', '--user-ids', chunk.join(','), '--page-size', '20'],
        { signal: exec?.signal },
      )
      if (!result.ok) break
      const data = result.data ?? {}
      const candidates = Array.isArray(data.users) ? data.users : Array.isArray(data.items) ? data.items : []
      for (const user of candidates) {
        const id = user?.open_id ?? user?.user_id
        const name = user?.localized_name ?? user?.name ?? user?.en_name ?? user?.nickname
        if (typeof id === 'string' && typeof name === 'string' && name !== '') names.set(id, name)
      }
    }
    return names
  }

  /**
   * wiki 链接背后可能是 docx / 旧版 doc / 表格 / 多维表格。统一先解析节点，
   * 让三个读取工具都能直接吃 /wiki/ 链接，而不是让用户再换一次工具。
   */
  const resolveThroughWiki = async (target, exec) => {
    if (target.kind !== 'wiki') return target
    const node = await runner.runJson(['wiki', '+node-get', '--node-token', target.token], { signal: exec?.signal })
    if (!node.ok) return { ok: false, detail: node.message }
    const info = node.data ?? {}
    const kind = String(info.obj_type ?? '')
    const token = String(info.obj_token ?? '')
    if (token === '') {
      return {
        ok: false,
        detail: `知识库节点「${info.title ?? ''}」没有可读对象（可能是空节点，或快捷方式指向的文档已删除）。`,
      }
    }
    return { ok: true, kind, token, title: info.title, url: target.url }
  }

  ctx.inject(['tools'], (scoped) => {
    const output = textOutput()
    // 所有工具的返回都过一遍"未配置引导"：缺绑定/缺授权时自动附上怎么配，
    // 不要让用户对着一句 token_missing 自己猜。
    const register = (tool) =>
      registerTool(scoped, {
        output,
        ...tool,
        execute: async (...args) => appendSetupHint(await tool.execute(...args), settings),
      })

    // ────────────────────────────────────────────────────────────────
    // 0. 配置检查 / 引导
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_setup',
      description:
        '检查本机飞书 CLI 的绑定与授权状态：有没有装、绑没绑应用、用户身份和令牌是否有效。' +
        '没配好时直接给出配置步骤（不含任何内置应用 ID）。只读。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, exec) {
        const statusResult = await runner.runJson(['auth', 'status', '--json'], { signal: exec?.signal })
        if (!statusResult.ok) {
          return [
            '飞书连接配置检查：lark-cli 未就绪',
            statusResult.message,
            renderBindGuide(settings),
          ].join('\n')
        }

        const status = statusResult.data ?? {}
        const verdict = classifyStatus(status)
        const user = status.identities?.user ?? {}

        // `profile list` 输出的是裸 JSON 数组，不走 ok 信封，所以用 runText 再解析
        let profiles = []
        const listResult = await runner.runText(['profile', 'list'], { signal: exec?.signal })
        if (listResult.ok) {
          try {
            const parsed = JSON.parse(listResult.text.replace(/^[^[]*/, ''))
            if (Array.isArray(parsed)) profiles = parsed
          } catch {
            profiles = []
          }
        }
        const active = profiles.find((item) => item?.active === true)

        const lines = [
          '飞书连接配置检查',
          '────────────────────────────',
          `lark-cli：${resolveLarkBin(settings).ok ? '可用' : '不可用'}`,
          `应用：${status.appId ?? '(未知)'}（brand=${status.brand ?? '?'}${settings.profile === '' ? '' : `，配置指定 profile=${settings.profile}`}）`,
          active === undefined
            ? `profile：${profiles.length} 个${profiles.length > 0 ? `（当前未标记默认）` : ''}`
            : `profile：${active.name ?? '(未命名)'}（共 ${profiles.length} 个，当前默认就是这个）`,
          `用户身份：${user.status ?? '未知'}${user.userName === undefined ? '' : `（${user.userName}）`} ｜ 令牌：${user.tokenStatus ?? '未知'}`,
          '',
        ]

        if (verdict.state === 'ready') {
          lines.push(`结论：配置正常。${verdict.detail}`)
          return lines.join('\n')
        }

        if (verdict.state === 'stale-token') {
          lines.push(`结论：应用绑好了，但用户授权过期（${verdict.detail}）。`, renderScopeGuide())
          return lines.join('\n')
        }

        lines.push(`结论：${verdict.detail}`, renderBindGuide(settings))
        if (profiles.length > 1) {
          lines.push(
            '',
            '提示：这台机器有多个 profile。如果目标是另一个应用，先 `lark-cli profile use <name>` 切过去，',
            '或在插件配置里填 profile（留空表示跟随 lark-cli 当前默认）。',
          )
        }
        return lines.join('\n')
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 1. 自检
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_status',
      description:
        '检查飞书连接是否可用：lark-cli 位置、当前应用、user/bot 两种身份各自的授权状态与令牌有效期。' +
        '任何飞书读取失败、或不确定当前身份能否看到某个文档/群时，先调用它。只读，不发业务请求。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, exec) {
        if (!runner.resolve.ok) return `飞书连接不可用：${runner.resolve.detail}`
        const result = await runner.runJson(['auth', 'status'], { signal: exec?.signal })
        if (!result.ok) return result.message

        const status = result.data ?? {}
        const identities = status.identities ?? {}
        const lines = ['飞书连接：lark-cli 可用', `可执行文件：${runner.resolve.bin}`]
        lines.push(
          `应用：${status.appId ?? '?'}（brand=${status.brand ?? '?'}${settings.profile === '' ? '' : `，profile=${settings.profile}`}）`,
        )
        lines.push(`本插件默认身份：${settings.identity}`)
        lines.push(`默认超时：${Math.round(settings.timeoutMs / 1000)} 秒 ｜ 单次返回上限：${settings.maxChars} 字符`)

        for (const key of ['user', 'bot']) {
          const item = identities[key]
          if (item === undefined) continue
          const expiry = item.expiresAt === undefined ? '' : `，到期 ${item.expiresAt}`
          lines.push(`· ${key}：${item.status ?? '?'}${item.userName === undefined ? '' : `（${item.userName}）`}${expiry}`)
          if (item.message !== undefined && item.message !== '') lines.push(`  ${item.message}`)
        }

        const scopes = String(identities.user?.scope ?? '')
          .split(/\s+/)
          .filter((s) => s !== '')
        if (scopes.length > 0) {
          const wanted = [
            ['docs:document.content:read', '文档正文'],
            ['sheets:spreadsheet:read', '电子表格'],
            ['base:record:read', '多维表格记录'],
            ['im:chat:read', '群信息/列全部群'],
            ['im:message:readonly', '群消息'],
            ['im:message.group_msg:get_as_user', '群消息（用户身份）'],
            ['im:message.p2p_msg:get_as_user', '单聊消息（用户身份）'],
            ['im:message.reactions:read', '消息表情回复'],
            ['search:docs:read', '云文档搜索'],
            ['search:message', '消息搜索'],
            ['wiki:node:retrieve', '知识库 /wiki/ 节点解析'],
            ['board:whiteboard:node:read', '画板节点'],
          ]
          lines.push('', `已授权范围：${scopes.length} 项。本插件关心的：`)
          for (const [scope, label] of wanted) {
            lines.push(`  ${scopes.includes(scope) ? '✓' : '✗'} ${label}（${scope}）`)
          }
          // 勾选状态只是参考：有的命令按参数才校验范围（例如 --no-reactions 仍会被旧版本
          // 要求 reactions 权限），以工具实际调用结果为准，别拿这张表当"能不能用"的结论。
          lines.push(
            '',
            '注：这里的 ✓/✗ 只是授权清单的参考值。某个工具到底能不能用，以实际调用返回为准——' +
              'lark-cli 的范围预校验比真实接口更严（例如 --no-reactions 仍可能被要求 reactions 范围）。',
          )
        }

        // 身份没就绪时，别让人对着一堆 scope 猜，直接指向配置检查
        const verdict = classifyStatus(status)
        if (verdict.state !== 'ready') {
          lines.push('', `配置状态：${verdict.detail}`, '跑 feishu_setup 看具体步骤（它不会要求你先知道应用 ID）。')
        }

        if (settings.notes.length > 0) lines.push('', ...settings.notes.map((n) => `配置提示：${n}`))
        if (result.notice?.update?.message !== undefined) lines.push('', `lark-cli：${result.notice.update.message}`)
        if (!settings.enableChat) lines.push('', '群聊类工具已被 config.enableChat=false 关闭。')
        return lines.join('\n')
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 2. 云文档搜索
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_search',
      description:
        '在企业飞书里按关键词搜索云文档、知识库页面、电子表格。只返回标题/类型/更新时间/链接，不返回正文。' +
        '用于「我记得有一份关于 X 的文档」这类场景；拿到链接后再用 feishu_doc_read / feishu_sheet_read 读内容。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          pageSize: { type: 'integer', description: '每页条数 1-20，默认 15', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const query = String(args?.query ?? '').trim()
        if (query === '') return 'query 不能为空。'
        const pageSize = Number.isSafeInteger(args?.pageSize) ? Math.min(Math.max(args.pageSize, 1), 20) : 15
        const result = await runner.runJson(
          ['docs', '+search', '--query', query, '--page-size', String(pageSize)],
          { signal: exec?.signal },
        )
        if (!result.ok) return result.message
        const data = result.data ?? {}
        return renderDocSearch({
          query,
          results: Array.isArray(data.results) ? data.results : [],
          hasMore: data.has_more === true,
        })
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 3. 读文档（docx / 旧版 doc / wiki 节点）
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_doc_read',
      description:
        '读取企业飞书在线文档的正文。接受 docx 链接、旧版 /docs/ 链接、/wiki/ 知识库链接，或裸 token；' +
        '知识库节点会自动解析背后的真实文档类型。用户贴出 feishu.cn / larkoffice.com 文档链接时优先用本工具，' +
        '不要用网页抓取。只读。长文档先用 scope=outline 看结构，再用 scope=section 或 keyword 局部读。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '文档链接或 token' },
          scope: {
            type: 'string',
            enum: ['full', 'outline', 'section', 'keyword', 'range'],
            description: '读取范围：full 全文（默认）、outline 仅标题、section 从某标题展开、keyword 关键词命中、range 块区间',
          },
          keyword: { type: 'string', description: 'scope=keyword 时的关键词，支持 foo|bar 多分支' },
          format: {
            type: 'string',
            enum: ['markdown', 'xml'],
            description:
              'markdown（默认）返回可读 Markdown，省 token；xml 返回 lark-cli 原始 DocxXML，' +
              '保留 block 结构、图片/画板 token 与 open_id 等元数据（Codex Desktop 就是用这种方式读的）',
          },
          detail: {
            type: 'string',
            enum: ['simple', 'with-ids', 'full'],
            description: 'xml 时更有用：with-ids 带 block_id（可拼成 #block_id 直达链接），full 还带样式与引用元数据',
          },
          startBlockId: { type: 'string', description: 'scope=section/range 的起始块 id' },
          endBlockId: { type: 'string', description: 'scope=range 的结束块 id，-1 表示到文末' },
          maxDepth: { type: 'integer', description: '标题层级上限，-1 不限，0 只看块本身' },
          offset: { type: 'integer', description: '正文起始字符位置，默认 0；用于分段读长文' },
          limit: { type: 'integer', description: '本次返回的最大字符数，默认用插件配置的上限' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const target = parseTarget(args?.url)
        if (!target.ok) return target.detail
        if (!DOC_KINDS.has(target.kind)) {
          if (target.kind === 'file') {
            return (
              `这是云空间文件（token=${target.token}），不是文档，本插件不下载文件。` +
              '需要内容时让用户先把它导入/转存成 docx 或 sheet，或用 lark-drive 的 drive +download 下载到本地再读。'
            )
          }
          return `这是一个${KIND_LABELS[target.kind] ?? target.kind}，不是文档。请改用 ${
            target.kind === 'sheet' ? 'feishu_sheet_read' : target.kind === 'bitable' ? 'feishu_bitable_read' : '对应的读取工具'
          }（token=${target.token}）。`
        }

        const scope = typeof args?.scope === 'string' ? args.scope : 'full'
        const offset = Number.isSafeInteger(args?.offset) && args.offset > 0 ? args.offset : 0
        const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, settings.maxChars) : settings.maxChars

        // wiki 节点：先解析背后的真实对象
        let kind = target.kind
        let token = target.token
        let title
        let url = target.url
        if (kind === 'wiki') {
          const node = await runner.runJson(['wiki', '+node-get', '--node-token', token], { signal: exec?.signal })
          if (!node.ok) return node.message
          const info = node.data ?? {}
          title = info.title
          kind = String(info.obj_type ?? '')
          token = String(info.obj_token ?? '')
          if (kind === 'sheet') {
            return `知识库节点「${title ?? ''}」背后是电子表格，请用 feishu_sheet_read 直接读这个 wiki 链接（它会自己解析节点）。`
          }
          if (kind === 'bitable') {
            return `知识库节点「${title ?? ''}」背后是多维表格，请用 feishu_bitable_read 直接读这个 wiki 链接（它会自己解析节点）。`
          }
          if (kind !== 'docx' && kind !== 'doc') {
            return `知识库节点「${title ?? ''}」的类型是 ${kind || '未知'}，本工具只支持 docx 与旧版 doc。`
          }
        }

        let content = ''
        let revision
        let tips
        let resources = []
        let effectiveScope = scope

        // 旧版 doc 只有"整篇纯文本"这一种读法
        const readLegacy = async () => {
          effectiveScope = 'full'
          const result = await runner.runJson(['api', 'GET', `/open-apis/doc/v2/${token}/raw_content`], {
            signal: exec?.signal,
          })
          if (!result.ok) return result
          let text = String(result.data?.content ?? '')
          if (scope !== 'full') text = `${text}\n\n（注意：这是旧版文档，只能整篇读取，scope 已按 full 处理。）`
          return { ok: true, text }
        }

        const wantXml = args?.format === 'xml'
        const readDocx = async () => {
          // im-markdown 是唯一会把残留 DocxXML 一起降级的档位；markdown 档仍留 <p>/<cite>
          const argv = ['docs', '+fetch', '--doc', token, '--doc-format', wantXml ? 'xml' : 'im-markdown', '--scope', scope]
          if (typeof args?.detail === 'string' && args.detail !== '') argv.push('--detail', args.detail)
          if (scope === 'keyword' && typeof args?.keyword === 'string') argv.push('--keyword', args.keyword)
          if (Number.isSafeInteger(args?.maxDepth)) argv.push('--max-depth', String(args.maxDepth))
          if (typeof args?.startBlockId === 'string' && args.startBlockId !== '') argv.push('--start-block-id', args.startBlockId)
          if (typeof args?.endBlockId === 'string' && args.endBlockId !== '') argv.push('--end-block-id', args.endBlockId)
          return runner.runJson(argv, { signal: exec?.signal })
        }

        if (kind === 'docx' || kind === 'token') {
          const result = await readDocx()
          if (result.ok) {
            const document = result.data?.document ?? {}
            const raw = String(document.content ?? '')
            if (wantXml) {
              // 原始模式：一个字都不动，结构/token/open_id 全保留
              content = raw
              title ??= document.title ?? extractDocTitle(raw)
            } else {
              // im-markdown 之后一般已是 markdown；老版本仍可能给 DocxXML，本地再降级一次
              const normalized = normalizeDocContent(raw)
              content = normalized.text
              title ??= document.title ?? normalized.title
            }
            revision = document.revision_id
            kind = 'docx'
            tips = typeof document.tips === 'string' ? document.tips : undefined
            resources = describeReferenceMap(document.reference_map)
          } else if (/Unsupported document type/i.test(result.message)) {
            // 只按"类型不支持"回退；3380002 也用于"文档不存在"，别把无效 token 也退过去
            // 裸 token 或旧版 doc：docs +fetch 不认，退回旧接口
            const legacy = await readLegacy()
            if (!legacy.ok) return legacy.message
            content = legacy.text
            kind = 'doc'
          } else {
            return result.message
          }
        } else {
          const legacy = await readLegacy()
          if (!legacy.ok) return legacy.message
          content = legacy.text
        }

        if (content === '') return `文档读取成功但正文为空：${KIND_LABELS[kind] ?? kind} token=${token}。可能是空文档，或该文档只对其他人可见。`

        const sliced = offset > 0 ? content.slice(offset) : content
        const body = clip(sliced, limit, offset === 0 ? '可先用 scope=outline 看结构，或加 offset 继续读。' : undefined)
        return renderDoc({
          title,
          kind,
          token,
          url,
          revision,
          scope: effectiveScope,
          content: body,
          totalChars: content.length,
          tips,
          resources,
        })
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 4. 读电子表格
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_sheet_read',
      description:
        '读取企业飞书电子表格（sheets）。不给 sheet 时返回工作表清单（名称、sheet_id、行列数）；' +
        '给了 sheet 与 range 时返回该区间的 CSV（含 [row=N] 行号前缀）。用户贴出 /sheets/ 链接时用本工具。只读。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '表格链接或 spreadsheet token' },
          sheet: { type: 'string', description: '工作表名称或 sheet_id；省略则列出全部工作表' },
          range: { type: 'string', description: 'A1 区间，如 A1:F30；省略则读该表实际数据边界' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        let target = parseTarget(args?.url)
        if (!target.ok) return target.detail
        target = await resolveThroughWiki(target, exec)
        if (!target.ok) return target.detail
        if (!SHEET_KINDS.has(target.kind)) {
          return `这是一个${KIND_LABELS[target.kind] ?? target.kind}，不是电子表格。请改用 ${
            target.kind === 'bitable' ? 'feishu_bitable_read' : 'feishu_doc_read'
          }（token=${target.token}）。`
        }

        const info = await runner.runJson(['sheets', '+workbook-info', '--spreadsheet-token', target.token], {
          signal: exec?.signal,
        })
        if (!info.ok) return info.message

        const sheets = Array.isArray(info.data?.sheets) ? info.data.sheets : []
        const wanted = typeof args?.sheet === 'string' ? args.sheet.trim() : ''
        if (wanted === '') {
          return renderWorkbook({ url: target.url, sheets })
        }

        const sheet = sheets.find((item) => item.sheet_id === wanted) ?? sheets.find((item) => item.sheet_name === wanted)
        if (sheet === undefined) {
          const names = sheets.map((item) => `${item.sheet_name}(${item.sheet_id})`).join('、')
          return `没找到工作表「${wanted}」。可用的是：${names === '' ? '（无）' : names}`
        }

        const range = typeof args?.range === 'string' ? args.range.trim() : ''
        const argv = ['sheets', '+csv-get', '--spreadsheet-token', target.token, '--sheet-id', sheet.sheet_id]
        if (range !== '') argv.push('--range', range)
        argv.push('--max-chars', String(settings.maxChars))

        const result = await runner.runJson(argv, { signal: exec?.signal })
        if (!result.ok) return result.message

        const data = result.data ?? {}
        const csv = String(data.annotated_csv ?? data.csv ?? '')
        if (csv === '') return `工作表「${sheet.sheet_name}」在 ${range === '' ? '当前范围' : range} 内没有数据。`
        return renderSheetCsv({
          url: target.url,
          sheet: `${sheet.sheet_name}（${sheet.sheet_id}）`,
          range,
          actualRange: data.actual_range,
          csv: clip(csv, settings.maxChars, '可缩小 range 后重试。'),
          warning: data.warning_message,
          hasMore: data.has_more === true,
        })
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 5.4 读多维表格字段（类型 + 单选/多选选项全集 + 关联表）
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_bitable_fields',
      description:
        '读取多维表格某个数据表的字段清单：字段名、类型、单选/多选的全部选项、公式表达式、关联到哪张表。' +
        '要看"任务状态有哪几个值"这类问题就用它。只读。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '多维表格链接或 app token' },
          table: { type: 'string', description: '数据表名称或 table_id；省略则先列出所有数据表' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        let target = parseTarget(args?.url)
        if (!target.ok) return target.detail
        target = await resolveThroughWiki(target, exec)
        if (!target.ok) return target.detail
        if (!BITABLE_KINDS.has(target.kind)) {
          return `这是一个${KIND_LABELS[target.kind] ?? target.kind}，不是多维表格。`
        }

        const table = typeof args?.table === 'string' ? args.table.trim() : ''
        if (table === '') {
          const result = await runner.runJson(['base', '+table-list', '--base-token', target.token], { signal: exec?.signal })
          if (!result.ok) return result.message
          const tables = result.data?.tables ?? result.data?.items
          return `${renderTables({ url: target.url, tables: Array.isArray(tables) ? tables : [] })}\n\n再指定 table 读取字段清单。`
        }

        const result = await runner.runJson(
          ['base', '+field-list', '--base-token', target.token, '--table-id', table, '--format', 'json'],
          { signal: exec?.signal },
        )
        if (!result.ok) return result.message
        const fields = Array.isArray(result.data?.fields) ? result.data.fields : []
        if (fields.length === 0) return `数据表「${table}」没有读到字段（可能表名不对，或你没有查看权限）。`
        return clip(renderFieldList({ url: target.url, table, fields }), settings.maxChars, '字段太多，可换一张表再试。')
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 5. 读多维表格
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_bitable_read',
      description:
        '读取企业飞书多维表格（Base）。不给 table 时列出所有数据表；给了 table 时返回该表的记录（markdown 表格）。' +
        '用户贴出 /base/ 链接时用本工具。只读。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '多维表格链接或 app token' },
          table: { type: 'string', description: '数据表名称或 table_id；省略则列出全部数据表' },
          limit: { type: 'integer', description: '返回记录数 1-200，默认 50', minimum: 1, maximum: 200 },
          offset: { type: 'integer', description: '记录偏移量，默认 0' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        let target = parseTarget(args?.url)
        if (!target.ok) return target.detail
        target = await resolveThroughWiki(target, exec)
        if (!target.ok) return target.detail
        if (!BITABLE_KINDS.has(target.kind)) {
          return `这是一个${KIND_LABELS[target.kind] ?? target.kind}，不是多维表格。请改用 ${
            target.kind === 'sheet' ? 'feishu_sheet_read' : 'feishu_doc_read'
          }（token=${target.token}）。`
        }

        const table = typeof args?.table === 'string' ? args.table.trim() : ''
        if (table === '') {
          const result = await runner.runJson(['base', '+table-list', '--base-token', target.token], { signal: exec?.signal })
          if (!result.ok) return result.message
          const tables = result.data?.tables ?? result.data?.items
          const items = Array.isArray(tables) ? tables : []
          return renderTables({ url: target.url, tables: items })
        }

        const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 200) : 50
        const offset = Number.isSafeInteger(args?.offset) && args.offset > 0 ? args.offset : 0
        const argv = [
          'base', '+record-list',
          '--base-token', target.token,
          '--table-id', table,
          '--limit', String(limit),
          // 1.0.98 起 `--format markdown` 已被移除（只剩 json 内联矩阵与 ndjson 落盘），
          // 用 json 拿 `fields` + 二维 data，自己渲染 Markdown 表格。
          '--format', 'json',
        ]
        if (offset > 0) argv.push('--offset', String(offset))

        const result = await runner.runJson(argv, { signal: exec?.signal })
        if (!result.ok) return result.message
        const data = result.data ?? {}

        // 字段元信息：知道哪些列是关联、关联到哪张表、公式列怎么格式化
        const metaResult = await runner.runJson(
          ['base', '+field-list', '--base-token', target.token, '--table-id', table, '--format', 'json'],
          { signal: exec?.signal },
        )
        const meta = metaResult.ok ? metaResult.data?.fields ?? [] : []
        const byId = new Map(meta.map((field) => [String(field?.id ?? ''), field]))
        const columns = (data.field_id_list ?? []).map((id) => byId.get(String(id)))

        // 关联列只有 record_id，按 link_table 批量取回首列标题
        const linkTitles = new Map()
        const linkTables = new Set(
          columns.filter((field) => field?.type === 'link' && typeof field.link_table === 'string').map((field) => field.link_table),
        )
        for (const linkTable of linkTables) {
          const linked = await runner.runJson(
            ['base', '+record-list', '--base-token', target.token, '--table-id', linkTable, '--limit', '200', '--format', 'json'],
            { signal: exec?.signal },
          )
          if (!linked.ok) continue
          linkTitles.set(
            linkTable,
            buildTitleMap(Array.isArray(linked.data?.data) ? linked.data.data : [], linked.data?.record_id_list),
          )
        }

        return clip(
          renderRecords({
            url: target.url,
            table,
            fields: data.fields,
            rows: Array.isArray(data.data) ? data.data : [],
            recordIds: data.record_id_list,
            hasMore: data.has_more === true,
            rev: data.rev,
            formatCell: (value, columnIndex) => formatCell(value, columns[columnIndex], linkTitles),
          }),
          settings.maxChars,
          '可增大 offset 继续，或减小 limit。',
        )
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 5.5 读画板（节点文字）
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_whiteboard_read',
      description:
        '读取飞书画板的节点文字。给文档链接时会找出文档里的所有画板，逐个导出节点并按阅读顺序列出文字；' +
        '也可以直接给画板 token。只读。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '文档链接（docx/wiki）或画板 token' },
          token: { type: 'string', description: '直接指定画板 token（与 url 二选一）' },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const tokens = []
        const direct = typeof args?.token === 'string' ? args.token.trim() : ''
        if (direct !== '') tokens.push(direct)

        let title
        let sourceUrl
        if (tokens.length === 0) {
          const target = parseTarget(args?.url)
          if (!target.ok) return target.detail
          let kind = target.kind
          let value = target.token
          if (kind === 'wiki') {
            const node = await runner.runJson(['wiki', '+node-get', '--node-token', value], { signal: exec?.signal })
            if (!node.ok) {
              // 节点解析失败多半是"没权限"或"给的不是节点 token"，
              // 这时候直接抛 2890003 他会以为是画板接口的问题，补一句该往哪走。
              return `${node.message}

补充：画板工具要的是「画板 token」或「含画板的文档链接」。如果这是一篇普通文档，请改用 feishu_doc_read 读正文；如果确实含画板，先确认这个知识库节点对当前账号可见再重试。`
            }
            title = node.data?.title
            kind = String(node.data?.obj_type ?? '')
            value = String(node.data?.obj_token ?? '')
          }
          if (kind === 'whiteboard') {
            tokens.push(value)
          } else if (kind === 'docx' || kind === 'doc' || kind === 'token') {
            sourceUrl = target.url
            // 用 xml 档找 <whiteboard token=...>：markdown 档只留占位文字，拿不到 token
            const doc = await runner.runJson(
              ['docs', '+fetch', '--doc', value, '--doc-format', 'xml', '--detail', 'simple'],
              { signal: exec?.signal },
            )
            if (!doc.ok) return doc.message
            const body = String(doc.data?.document?.content ?? '')
            title ??= doc.data?.document?.title
            for (const hit of body.matchAll(/<whiteboard\b[^>]*\btoken="([^"]+)"/g)) tokens.push(hit[1])
            if (tokens.length === 0) {
              return `文档「${title ?? value}」里没有画板（也可能画板在子文档或同步块里）。`
            }
          } else {
            return `这是一个${KIND_LABELS[kind] ?? kind}，不是画板或文档。给画板 token 或文档链接。`
          }
        }

        const blocks = []
        for (const token of tokens) {
          const result = await runner.runJson(
            ['whiteboard', '+export', '--whiteboard-token', token, '--output-type', 'raw'],
            { signal: exec?.signal, timeoutMs: Math.max(settings.timeoutMs, 60000) },
          )
          if (!result.ok) {
            blocks.push(`画板 ${token} 读取失败：\n${result.message}`)
            continue
          }
          blocks.push(renderWhiteboard({ token, nodes: result.data?.nodes, title: tokens.length === 1 ? title : undefined }))
        }

        const head =
          tokens.length === 1
            ? ''
            : `来源${title === undefined ? '' : `「${title}」`}共 ${tokens.length} 块画板${sourceUrl === undefined ? '' : `（${sourceUrl}）`}\n\n`
        return head + blocks.join('\n\n')
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 5.6 读文档评论与回复
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_doc_comments',
      description:
        '读取文档/表格/多维表格/画板上的评论与回复（含引用原文、评论人、时间、是否已解决）。' +
        '给 wiki 链接会自动解析。只读。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '文档链接或 token（可以是 wiki 链接）' },
          solved: {
            type: 'string',
            enum: ['all', 'unresolved', 'resolved'],
            description: '筛选：all 全部（默认）、unresolved 未解决、resolved 已解决',
          },
          limit: { type: 'integer', description: '最多返回多少条评论，1-200，默认 200', minimum: 1, maximum: 200 },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const target = parseTarget(args?.url)
        if (!target.ok) return target.detail

        const wanted = typeof args?.solved === 'string' ? args.solved : 'all'
        const solvedFlag = wanted === 'unresolved' ? 'false' : wanted === 'resolved' ? 'true' : 'all'
        const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 200

        const items = []
        let pageToken = ''
        let total
        let more = false
        for (let page = 0; page < 20; page += 1) {
          const argv = [
            'drive', '+list-comments',
            '--token', target.url ?? target.token,
            '--solved-status', solvedFlag,
            '--page-size', String(Math.min(100, Math.max(1, limit - items.length))),
          ]
          if (target.url === undefined) argv.push('--type', target.kind === 'token' ? 'docx' : target.kind)
          if (pageToken !== '') argv.push('--page-token', pageToken)
          const result = await runner.runJson(argv, { signal: exec?.signal })
          if (!result.ok) return result.message
          const data = result.data ?? {}
          if (Array.isArray(data.items)) items.push(...data.items)
          if (total === undefined && Number.isSafeInteger(data.count)) total = data.count
          pageToken = typeof data.page_token === 'string' ? data.page_token : ''
          more = data.has_more === true
          if (more !== true || pageToken === '' || items.length >= limit) break
        }

        const names = await resolveNames(runner, items, exec)
        return renderComments({
          items: items.slice(0, limit),
          names,
          total: total ?? items.length,
          solved: wanted,
          // 被 limit 截断时不能自称"共 N 条"，那会让人以为评论只有这么多
          more: more === true || items.length > limit,
        })
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 5.7 读妙记（会议纪要）
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_minutes_read',
      description:
        '读取飞书妙记（会议录制/纪要）的标题、总结、待办、章节与关键词。只读；不下载音视频、不导出逐字稿文件。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '妙记链接（/minutes/…）或 minute token' },
          parts: {
            type: 'array',
            items: { type: 'string', enum: ['summary', 'todo', 'chapter', 'keyword'] },
            description: '要读取的部分，默认全部',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const target = parseTarget(args?.url)
        if (!target.ok) return target.detail
        if (target.kind !== 'minutes' && target.kind !== 'token') {
          return `这是一个${KIND_LABELS[target.kind] ?? target.kind}。妙记请给 /minutes/ 链接或 minute token；` +
            '普通文档里的「智能纪要」本身是 docx，用 feishu_doc_read 读。'
        }
        const wanted = Array.isArray(args?.parts) && args.parts.length > 0 ? args.parts : ['summary', 'todo', 'chapter', 'keyword']
        const argv = ['minutes', '+detail', '--minute-tokens', target.token, '--format', 'json']
        if (wanted.includes('summary')) argv.push('--summary')
        if (wanted.includes('todo')) argv.push('--todo')
        if (wanted.includes('chapter')) argv.push('--chapter')
        if (wanted.includes('keyword')) argv.push('--keyword')
        const result = await runner.runJson(argv, { signal: exec?.signal })
        if (!result.ok) return result.message
        const minutes = Array.isArray(result.data?.minutes) ? result.data.minutes : []
        if (minutes.length === 0) return `没有读到妙记 ${target.token} 的内容（可能未生成纪要，或你没有查看权限）。`
        return minutes.map((minute) => renderMinutes({ minute })).join('\n\n')
      },
    })

    if (!settings.enableChat) return

    // ────────────────────────────────────────────────────────────────
    // 6. 群列表
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_chat_list',
      description:
        '列出或搜索当前账号所在的飞书群聊。给 query 时按群名/成员服务端搜索，否则按最近活跃列出。' +
        '返回群名、chat_id、外部群标记与群描述——拿到 chat_id 后用 feishu_chat_history 读消息。只读。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '群名关键词；省略则列出全部群' },
          limit: { type: 'integer', description: '最多返回多少个群，1-100，默认 30', minimum: 1, maximum: MAX_LIST },
          types: {
            type: 'string',
            enum: ['group', 'p2p', 'both'],
            description: 'group 群聊（默认）、p2p 单聊、both 两者都要',
          },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), MAX_LIST) : 30
        const types = args?.types === 'p2p' ? 'p2p' : args?.types === 'both' ? 'group,p2p' : 'group'

        const argv = query === ''
          ? ['im', '+chat-list', '--page-size', String(Math.min(limit, 100)), '--types', types]
          : ['im', '+chat-search', '--query', query, '--page-size', String(Math.min(limit, 100))]
        if (query === '' && limit > 100) argv.push('--page-all', '--page-limit', '2')

        const result = await runner.runJson(argv, { signal: exec?.signal })
        if (!result.ok) return result.message
        const chats = Array.isArray(result.data?.chats) ? result.data.chats : []
        const note =
          query !== '' && types !== 'group'
            ? '注意：按关键词搜索只覆盖群聊，单聊不在搜索范围内；要列单聊请不传 query。'
            : undefined
        const rendered = renderChats({
          chats: chats.slice(0, limit),
          query,
          types: types === 'group' ? '群聊' : types === 'p2p' ? '单聊' : '群聊 + 单聊',
        })
        return note === undefined ? rendered : `${rendered}\n\n${note}`
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 7. 群消息
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_chat_history',
      description:
        '读取某个飞书会话（群聊或单聊）的消息记录。chat 可以给 oc_ 开头的 chat_id，也可以直接给群名（会先搜索解析）。' +
        '默认返回最近 20 条，可用 start/end 限定时间。只读；不发送、不修改任何消息。',
      parameters: {
        type: 'object',
        properties: {
          chat: { type: 'string', description: 'chat_id（oc_…）或群名' },
          limit: { type: 'integer', description: '返回条数 1-50，默认 20', minimum: 1, maximum: MAX_MESSAGES },
          start: { type: 'string', description: '起始时间，ISO 8601，如 2026-10-01T00:00:00+08:00' },
          end: { type: 'string', description: '结束时间，ISO 8601' },
          order: { type: 'string', enum: ['desc', 'asc'], description: 'desc 最新在前（默认）、asc 时间正序' },
        },
        required: ['chat'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const input = String(args?.chat ?? '').trim()
        if (input === '') return 'chat 不能为空：给 chat_id 或群名。'

        let chatId = input
        let chatName
        if (!/^oc_[A-Za-z0-9]+$/.test(input)) {
          const search = await runner.runJson(['im', '+chat-search', '--query', input, '--page-size', '5'], {
            signal: exec?.signal,
          })
          if (!search.ok) return search.message
          const chats = Array.isArray(search.data?.chats) ? search.data.chats : []
          if (chats.length === 0) return `没搜到名字里含「${input}」的群。可以先 feishu_chat_list 看看你所在的群。`
          const exact = chats.find((chat) => chat.name === input) ?? chats[0]
          chatId = exact.chat_id
          chatName = exact.name
          if (chats.length > 1 && exact.name !== input) {
            chatName = `${exact.name}（同名的还有 ${chats.length - 1} 个，取了第一个；需要别的请用 chat_id）`
          }
        }

        const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), MAX_MESSAGES) : 20
        const argv = [
          'im', '+chat-messages-list',
          '--chat-id', chatId,
          '--page-size', String(limit),
          '--order', args?.order === 'asc' ? 'asc' : 'desc',
          '--no-reactions',
        ]
        if (typeof args?.start === 'string' && args.start !== '') argv.push('--start', args.start)
        if (typeof args?.end === 'string' && args.end !== '') argv.push('--end', args.end)

        const result = await runner.runJson(argv, { signal: exec?.signal })
        if (!result.ok) return result.message
        const messages = Array.isArray(result.data?.messages) ? result.data.messages : []
        return renderMessages({
          chatName,
          chatId,
          messages,
          order: args?.order === 'asc' ? 'asc' : 'desc',
          hasMore: result.data?.has_more === true,
        })
      },
    })

    // ────────────────────────────────────────────────────────────────
    // 8. 跨群消息搜索
    // ────────────────────────────────────────────────────────────────
    register({
      name: 'feishu_message_search',
      description:
        '在可见范围内跨会话搜索飞书消息（关键词，可按群、发送人、时间、附件类型过滤）。' +
        '适合「上周谁在群里说过 X」这类问题。只读。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          chat: { type: 'string', description: '限定 chat_id，逗号分隔多个；省略则全范围' },
          limit: { type: 'integer', description: '返回条数 1-50，默认 20', minimum: 1, maximum: MAX_MESSAGES },
          start: { type: 'string', description: '起始时间 ISO 8601（含本地时区偏移）' },
          end: { type: 'string', description: '结束时间 ISO 8601' },
          sender: { type: 'string', description: '发送人 open_id，逗号分隔' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const query = String(args?.query ?? '').trim()
        if (query === '') return 'query 不能为空。'
        const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), MAX_MESSAGES) : 20
        const argv = ['im', '+messages-search', '--query', query, '--page-size', String(limit), '--no-reactions']
        if (typeof args?.chat === 'string' && args.chat.trim() !== '') argv.push('--chat-id', args.chat.trim())
        if (typeof args?.start === 'string' && args.start !== '') argv.push('--start', args.start)
        if (typeof args?.end === 'string' && args.end !== '') argv.push('--end', args.end)
        if (typeof args?.sender === 'string' && args.sender !== '') argv.push('--sender', args.sender)

        const result = await runner.runJson(argv, { signal: exec?.signal })
        if (!result.ok) return result.message
        const messages = Array.isArray(result.data?.messages) ? result.data.messages : []
        return renderMessageSearch({
          query,
          messages,
          hasMore: result.data?.has_more === true,
        })
      },
    })
  })

  // 配置有问题时，把问题暴露在启动日志里，而不是静默带病运行。
  for (const note of settings.notes) ctx.logger?.warn?.(`[lark-connector] ${note}`)
  if (!runner.resolve.ok) ctx.logger?.warn?.(`[lark-connector] ${runner.resolve.detail}`)
}
