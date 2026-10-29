/**
 * lark-cli 运行器。
 *
 * 设计要点：**不用 bash 工具、不拼字符串**。这里直接 spawn 一个 argv 数组，原因有二：
 *
 * 1. 正确性——文档标题、群名、搜索词里什么字符都可能有，拼 shell 字符串迟早炸；
 * 2. 可用性——DSH 的 bash 工具跑在 workspace-write 沙箱里，lark-cli 刷新令牌要写
 *    ~/Library/Application Support/lark-cli（macOS）或 %APPDATA%\lark-cli（Windows），
 *    沙箱会拒掉这次写入，用户身份的调用就会时通时不通。宿主进程内的 spawn 不受该沙箱
 *    约束，能复用系统里唯一那份凭据库。
 *
 * 本模块只负责"把一次调用跑完并解析成 JSON"，业务语义在 index.js。
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

const DEFAULT_TIMEOUT_MS = 60_000
/** stdout 上限。文档正文可能很大，留足余量后直接判失败，避免把宿主拖进 OOM。 */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024
const MAX_STDERR_BYTES = 2 * 1024 * 1024

/** lark-cli 的常见安装位置，PATH 里找不到时按序兜底。 */
function extraBinDirs() {
  const dirs = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const execDir = dirname(process.execPath ?? '')
  if (execDir !== '' && execDir !== '.') dirs.push(execDir)
  return dirs
}

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 解析 lark-cli 可执行文件。
 * @returns {{ok: true, bin: string} | {ok: false, detail: string}}
 */
export function resolveLarkBin(configured) {
  const wanted = typeof configured === 'string' ? configured.trim() : ''
  if (wanted !== '') {
    if (isAbsolute(wanted)) {
      if (isExecutableFile(wanted)) return { ok: true, bin: wanted }
      return { ok: false, detail: `config.larkBin 指向的文件不存在或不可执行：${wanted}` }
    }
    const hit = searchPath(wanted)
    if (hit !== undefined) return { ok: true, bin: hit }
    return { ok: false, detail: `在 PATH 与常见安装目录里都没有找到 ${wanted}。` }
  }

  const hit = searchPath('lark-cli')
  if (hit !== undefined) return { ok: true, bin: hit }
  return {
    ok: false,
    detail:
      '没有找到 lark-cli。请先安装并在终端执行 `lark-cli auth login` 完成授权，' +
      '或在插件配置里用 larkBin 指定绝对路径。',
  }
}

function searchPath(name) {
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter).filter((d) => d !== ''),
    ...extraBinDirs(),
  ]
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * lark-cli 是 `#!/usr/bin/env node` 脚本；GUI 启动的宿主 PATH 往往很干净，
 * 所以先试 shebang，失败了再显式找解释器重跑。
 */
function nodeCandidates() {
  const list = []
  const isNode = typeof process.versions?.node === 'string' && process.versions?.electron === undefined
  if (isNode) list.push(process.execPath)
  const fromPath = searchPath('node')
  if (fromPath !== undefined) list.push(fromPath)
  // 桌面端随包带的 node（Resources/runtime/bin/node）
  if (typeof process.resourcesPath === 'string') {
    list.push(join(process.resourcesPath, 'runtime', 'bin', 'node'))
  }
  // ~/.local/codex-node/<版本>/bin/node
  try {
    const root = join(homedir(), '.local', 'codex-node')
    for (const entry of readdirSync(root)) list.push(join(root, entry, 'bin', 'node'))
  } catch {
    // 没有这个目录就没这层兜底
  }
  return [...new Set(list)].filter((p) => p !== '' && existsSync(p))
}

/** 从混着进度行的 stdout 里取出 JSON 对象（lark-cli 会先打印 "Fetching …" 之类）。 */
export function extractJson(text) {
  if (typeof text !== 'string') return undefined
  const body = text.trim()
  if (body === '') return undefined

  if (body.startsWith('{')) {
    try {
      return JSON.parse(body)
    } catch {
      // 落到逐位置尝试
    }
  }
  const starts = []
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '{') continue
    if (i === 0 || body[i - 1] === '\n' || body[i - 1] === '\r') starts.push(i)
  }
  for (const start of starts.reverse()) {
    try {
      const parsed = JSON.parse(body.slice(start))
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      // 继续尝试更早的 '{'
    }
  }
  return undefined
}

/**
 * 创建运行器。settings 来自插件配置，已由 normalizeSettings 归一化。
 */
export function createRunner(settings) {
  const resolved = resolveLarkBin(settings.larkBin)
  const env = {
    ...process.env,
    NO_COLOR: '1',
    // 关掉版本升级 / skills 更新提示：它们只是 _notice，对每次调用都是噪音
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  }

  if (settings.homeDir !== undefined && settings.homeDir !== '') {
    env.HOME = settings.homeDir
    if (process.platform === 'win32') env.USERPROFILE = settings.homeDir
  }
  // GUI 进程的 PATH 可能缺 ~/.local/bin；补上，子进程（含 shebang 的 env node）才找得到。
  const dirs = (env.PATH ?? '').split(delimiter).filter((d) => d !== '')
  for (const dir of extraBinDirs()) {
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  env.PATH = dirs.join(delimiter)

  const baseArgs = settings.profile !== undefined && settings.profile !== '' ? ['--profile', settings.profile] : []

  /** 终止整棵调用链：先杀进程组，失败再退回单进程。 */
  function killTree(child) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
  }

  async function spawnOnce(bin, args, { signal, timeoutMs }) {
    return new Promise((resolve) => {
      let child
      try {
        // detached：让 lark-cli 自成进程组。它是 node 包装器，会用 execFileSync 同步拉起
        // 真正的原生二进制；只 SIGKILL 包装器会把原生进程留成孤儿（还占着令牌锁）。
        child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true })
      } catch (error) {
        resolve({ spawnError: String(error?.message ?? error), stdout: '', stderr: '', code: -1 })
        return
      }

      let stdout = ''
      let stderr = ''
      let outBytes = 0
      let timedOut = false
      let aborted = false
      let settled = false

      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        resolve(result)
      }

      if (child.stdout !== null) child.stdout.setEncoding('utf8')
      if (child.stderr !== null) child.stderr.setEncoding('utf8')

      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, timeoutMs)

      const onAbort = () => {
        aborted = true
        killTree(child)
      }
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })

      child.stdout?.on('data', (chunk) => {
        outBytes += chunk.length
        if (outBytes > MAX_STDOUT_BYTES) {
          killTree(child)
          return
        }
        stdout += chunk
      })
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk
      })
      child.on('error', (error) => {
        finish({ spawnError: String(error?.message ?? error), stdout, stderr, code: -1 })
      })
      child.on('close', (code) => {
        finish({ code: code ?? -1, stdout, stderr, timedOut, aborted, spawnError: undefined })
      })
    })
  }

  /** 跑一次，返回原始结果或一条已经写好的失败说明。 */
  async function execute(argv, opts = {}) {
    if (!resolved.ok) return { error: resolved.detail }

    const timeoutMs = Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : settings.timeoutMs
    // 业务命令一律显式带 --as，响应里的 identity 才是权威的；
    // 但 `auth` 子命令没有这个 flag（会报 unknown flag "--as"），要排除。
    const supportsIdentity = argv[0] !== 'auth'
    const args = [...baseArgs, ...argv, ...(supportsIdentity ? ['--as', settings.identity] : [])]

    let result = await spawnOnce(resolved.bin, args, { signal: opts.signal, timeoutMs })
    if (result.spawnError !== undefined && /ENOENT|EACCES/i.test(result.spawnError)) {
      for (const node of nodeCandidates()) {
        result = await spawnOnce(node, [resolved.bin, ...args], { signal: opts.signal, timeoutMs })
        if (result.spawnError === undefined) break
      }
    }

    if (result.aborted === true) return { error: '调用已被取消。' }
    if (result.timedOut === true) {
      return {
        error:
          `lark-cli 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回，已终止。\n` +
          `命令：lark-cli ${argv.join(' ')}\n` +
          '可以缩小范围（range / scope / 时间区间）后重试，或在插件配置里调大 timeoutMs。',
      }
    }
    if (result.spawnError !== undefined) {
      return { error: `启动 lark-cli 失败：${result.spawnError}\n命令：lark-cli ${argv.join(' ')}` }
    }
    // 失败信封走 stderr（lark-cli 成功写 stdout、失败写 stderr），两边都要解析。
    const fromOut = extractJson(result.stdout)
    const fromErr = extractJson(result.stderr)
    const parsed = fromErr?.ok === false ? fromErr : (fromOut ?? fromErr)
    return { argv, ...result, parsed }
  }

  /**
   * 跑一次并解析 JSON 信封（lark-cli 绝大多数命令的默认输出）。
   * @returns {{ok: true, data: any, notice?: any} | {ok: false, message: string}}
   */
  async function runJson(argv, opts = {}) {
    const result = await execute(argv, opts)
    if (result.error !== undefined) return { ok: false, message: result.error }

    if (result.parsed === undefined) {
      const stderr = String(result.stderr ?? '').trim()
      return {
        ok: false,
        message:
          `lark-cli 没有返回可解析的 JSON（退出码 ${result.code}）。\n` +
          `命令：lark-cli ${argv.join(' ')}\n` +
          (stderr === '' ? '标准错误为空。' : `标准错误：\n${stderr.slice(0, 2000)}`),
      }
    }
    if (result.parsed.ok === false) {
      return { ok: false, message: formatApiFailure(result.parsed, argv, result.stderr) }
    }
    return { ok: true, data: result.parsed.data ?? result.parsed, notice: result.parsed._notice }
  }

  /**
   * 跑一次、拿原样文本（`--format markdown` 这类命令不吐 JSON）。
   * @returns {{ok: true, text: string, notice?: any} | {ok: false, message: string}}
   */
  async function runText(argv, opts = {}) {
    const result = await execute(argv, opts)
    if (result.error !== undefined) return { ok: false, message: result.error }
    if (result.parsed !== undefined && result.parsed.ok === false) {
      return { ok: false, message: formatApiFailure(result.parsed, argv, result.stderr) }
    }
    if (result.code !== 0 && result.parsed === undefined) {
      const stderr = String(result.stderr ?? '').trim()
      return {
        ok: false,
        message: `lark-cli 退出码 ${result.code}。\n命令：lark-cli ${argv.join(' ')}\n${stderr === '' ? '' : `标准错误：\n${stderr.slice(0, 2000)}`}`,
      }
    }
    const text = String(result.stdout ?? '')
      .split('\n')
      .filter((line) => !line.startsWith('[lark-cli]'))
      .join('\n')
      .trim()
    if (text === '') return { ok: false, message: `lark-cli 没有返回内容。\n命令：lark-cli ${argv.join(' ')}` }
    return { ok: true, text }
  }

  return { runJson, runText, resolve: resolved }
}

const TOKEN_FAILURES = new Set([99991661, 99991663, 99991664, 99991668, 20005, 20026])

const RATE_LIMIT_FAILURES = new Set([99991400, 99991401, 99991402])

/** 把 lark-cli 的错误信封翻译成"下一步该做什么"。 */
export function formatApiFailure(envelope, argv = [], stderr = '') {
  const error = envelope?.error ?? {}
  const code = error.code
  const message = String(error.message ?? '(无 message)')
  const lines = [`飞书返回失败：${message}`]

  const meta = []
  if (code !== undefined) meta.push(`code=${code}`)
  if (error.type !== undefined) meta.push(`type=${error.type}${error.subtype ? `/${error.subtype}` : ''}`)
  if (error.log_id !== undefined) meta.push(`log_id=${error.log_id}`)
  if (meta.length > 0) lines.push(meta.join('  '))

  // 服务端缺哪些 scope，lark-cli 会原样放在 missing_scopes 里，直接转给用户
  if (Array.isArray(error.missing_scopes) && error.missing_scopes.length > 0) {
    lines.push(`缺少权限：${error.missing_scopes.join('、')}`)
  }

  const hint = advise(error, message)
  if (hint !== '') lines.push(`建议：${hint}`)

  if (error.hint !== undefined && error.hint !== '') lines.push(`lark-cli：${error.hint}`)

  const stderrText = String(stderr ?? '').trim()
  if (stderrText !== '' && !stderrText.includes(message)) {
    lines.push(`标准错误：${stderrText.slice(0, 800)}`)
  }
  lines.push(`命令：lark-cli ${argv.join(' ')}`)
  return lines.join('\n')
}

function advise(error, message) {
  const text = `${message} ${error?.hint ?? ''}`
  // 飞书频控：错误里常带 retry_after_seconds，优先按服务端给的时间等待
  if (RATE_LIMIT_FAILURES.has(error?.code) || /rate limit|too many request|429/i.test(text)) {
    const wait = Number(error?.retry_after_seconds)
    const hint = Number.isFinite(wait) && wait > 0 ? `等 ${Math.ceil(wait)} 秒` : '等几秒到一分钟'
    return `${hint}后重试。飞书接口有频控，连续大量读取（尤其群消息、搜索）容易触发；把 range/时间区间缩小一些更稳。`
  }
  if (TOKEN_FAILURES.has(error?.code)) {
    return '用户身份令牌失效。在终端（沙箱外）执行 `lark-cli auth login` 重新授权，然后重试。'
  }
  if (/keychain|operation not permitted|EPERM/i.test(text)) {
    return (
      'lark-cli 的凭据库写不进去（常见于沙箱/CI）。本插件在宿主进程里直接调用 lark-cli，' +
      '正常不会触发；若出现，说明宿主本身也受限，请在终端执行 `lark-cli auth status` 确认凭据可用。'
    )
  }
  if (error?.code === 2890003) {
    return (
      '这个知识库节点对你不可见，或它不是节点 token：2890003 是「节点不存在/无权访问」。\n' +
      '先确认它在你的可见范围内；如果只是想读文档，直接用 /docx/ 或 /base/ 链接（token 就是路径末段）跳过知识库解析。'
    )
  }
  if (error?.code === 232034 || /unavailable or inactivate/i.test(text)) {
    return (
      '应用在当前企业里不可用：自建应用未发布（待上线/审核中）时，按租户维度列举资源（如列出全部群）会被拒。' +
      '先用群名关键词搜索（feishu_chat_list 带 query），或直接给 chat_id；应用发布后这条会自动恢复。'
    )
  }
  if (/wiki:node:retrieve/.test(text)) {
    return (
      '当前授权缺 wiki:node:retrieve，/wiki/ 链接背后的节点解析不了。' +
      '可以改用文档自身的 token（链接里 /docx/、/base/、/sheets/ 后面那段）绕过知识库解析，' +
      '或让管理员补上该权限后重新 `lark-cli auth login`。'
    )
  }
  if (/scope|permission|forbidden|no permission|access denied/i.test(text) || [99991672, 1770001, 1061004].includes(error?.code)) {
    return '当前授权范围不含这个操作。用 feishu_status 看已授权范围，或让管理员在开放平台补权限后重新 `lark-cli auth login`。'
  }
  if ([91402, 91403].includes(error?.code)) {
    return '对象不存在或你没有访问权：确认链接没写错，并确认该文档/群对当前账号可见。'
  }
  if (/not found|NOTEXIST/i.test(text)) {
    return '对象不存在：确认 token/链接是否完整，或该资源是否已被删除。'
  }
  return ''
}
