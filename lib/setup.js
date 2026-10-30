/**
 * 未配置时的引导。
 *
 * 插件本身不存任何应用凭据，也不应该知道"用哪个应用"——那属于部署信息。
 * 所以这里的引导用占位符 `<APP_ID>` / `<APP_SECRET>`，除非部署时在 config.appId
 * 里显式给了值。这样源码和公开仓库里不会出现任何人的应用 ID。
 */

const PLACEHOLDER_APP_ID = '<APP_ID>'

/** 出现这些字样，说明是"没绑定 / 没授权"，而不是数据本身的问题。 */
export const BIND_MARKERS = [
  'token_missing',
  'user identity not ready',
  'user identity: missing',
  'Run `lark-cli auth login`',
  'not logged in',
  '未授权',
  'not_configured',
]

/** 出现这些字样，说明应用绑好了、只是权限范围不够。 */
export const SCOPE_MARKERS = ['missing required scope', 'missing_scope', 'missing_scopes', '99991679']

function appIdOf(config) {
  const value = typeof config?.appId === 'string' ? config.appId.trim() : ''
  return value === '' ? PLACEHOLDER_APP_ID : value
}

/**
 * 完整绑定流程：装 CLI → 建 profile（要 secret）→ 用户授权。
 * 用在"这台机器还没绑过应用"的场景。
 */
export function renderBindGuide(config) {
  const appId = appIdOf(config)
  const lines = [
    '',
    '—— 如何配置 ——',
    '本机还没有绑定可用的飞书应用（或用户身份未授权）。按下面三步做，一次就好：',
    '',
    '1) 确认 lark-cli 可用：',
    '   lark-cli --version',
    '',
    '2) 绑定应用（需要管理员提供 App ID 和 App Secret）：',
    `   printf '%s' '<APP_SECRET>' | lark-cli profile add --app-id ${appId} --name ${appId === PLACEHOLDER_APP_ID ? 'work' : appId} --app-secret-stdin --use`,
    '   用 --app-secret-stdin 是为了 secret 不落进 shell 历史；别把 secret 贴到聊天记录或仓库里。',
    '',
    '3) 授权你自己的账号（扫码，权限全勾）：',
    '   lark-cli auth login --domain all --no-wait --json',
    '   # 打开返回的 verification_url，确认全部权限',
    '   lark-cli auth login --device-code <上一步的 device_code>',
    '',
    '完成后跑 `feishu_setup` 复查，或直接重试刚才的工具。',
  ]
  if (appId === PLACEHOLDER_APP_ID) {
    lines.splice(1, 0, '（本插件没有内置应用 ID，请向管理员索取；也可以在插件配置里填 appId 省掉这一步。）')
  }
  return lines.join('\n')
}

/**
 * 已经绑定了应用，只是授权范围不够。不需要 secret，重新授权即可。
 */
export function renderScopeGuide() {
  return [
    '',
    '—— 如何补权限 ——',
    '应用已经绑好，是授权范围不够。重新授权一次即可（不需要 secret）：',
    '',
    '   lark-cli auth login --domain all --no-wait --json',
    '   # 打开 verification_url，把权限全部勾上',
    '   lark-cli auth login --device-code <device_code>',
    '',
    '如果你的账号是刚补的权限，重新授权后旧令牌不会自动带上，必须重扫一次。',
  ].join('\n')
}

/** 这段文字是不是已经带着引导，避免重复追加。 */
function alreadyGuided(text, marker) {
  return text.includes(marker)
}

/**
 * 给失败信息补上引导。只处理"没绑定 / 没权限"，其他错误原样返回。
 * @param {string} text 工具原本的返回
 * @param {object} config 插件配置（只用到 appId）
 */
export function appendSetupHint(text, config) {
  const body = typeof text === 'string' ? text : ''
  if (body === '') return body

  if (SCOPE_MARKERS.some((marker) => body.includes(marker))) {
    const guide = renderScopeGuide()
    return alreadyGuided(body, '如何补权限') ? body : `${body}\n${guide}`
  }

  if (BIND_MARKERS.some((marker) => body.includes(marker))) {
    const guide = renderBindGuide(config)
    return alreadyGuided(body, '如何配置') ? body : `${body}\n${guide}`
  }

  return body
}

/**
 * 主动诊断：本机到底卡在哪一步。供 feishu_setup 使用。
 * @returns {{state: string, detail: string}}
 */
export function classifyStatus(status) {
  if (status === null || typeof status !== 'object') {
    return { state: 'no-cli', detail: 'lark-cli 不可用或没有返回状态。' }
  }
  const user = status.identities?.user
  if (user === undefined || user === null) {
    return { state: 'no-user', detail: '当前 profile 没有用户身份记录。' }
  }
  if (user.available !== true || user.status !== 'ready') {
    return { state: 'no-user', detail: `用户身份未就绪：${user.message ?? user.status ?? '未知原因'}` }
  }
  const tokenStatus = String(user.tokenStatus ?? '').toLowerCase()
  // needs_refresh 是"下次调用会自动续期"，不是配置问题——别把人往配置流程里带
  if (tokenStatus === 'needs_refresh') {
    return { state: 'ready', detail: `用户 ${user.userName ?? '(未命名)'}，令牌待续期（下次调用自动刷新）。` }
  }
  if (tokenStatus !== 'valid') {
    return { state: 'stale-token', detail: `用户令牌状态是 ${user.tokenStatus ?? '未知'}，需要重新授权。` }
  }
  return { state: 'ready', detail: `用户 ${user.userName ?? '(未命名)'}，令牌有效。` }
}
