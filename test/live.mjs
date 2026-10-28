/**
 * 联调：用**你自己的**企业飞书数据把只读工具逐个跑一遍（走的是插件里同一份 execute 代码）。
 *
 * 仓库里没有任何文档地址、群名或令牌——那些都是各家自己的数据。要跑联调，
 * 先复制 `.env.example` 为 `.env`，填上你自己有权限的链接，然后：
 *
 *   node --env-file=.env test/live.mjs
 *   LARK_TEST_PROFILE=larktest node --env-file=.env test/live.mjs   # 用独立授权的测试 profile
 *
 * 没填的项会跳过，不算失败；填了但读不到才是失败。
 *
 * 为什么要说清楚凭据：飞书的 refresh_token 是一次性的。在 bash 沙箱里跑，
 * 刷新拿得到新令牌却写不回凭据库——结果是系统那份被作废、而新令牌也丢了。
 * 所以**不要**复制真实凭据目录来测；要隔离就用独立 profile 重新授权一次：
 *
 *   lark-cli auth login --profile larktest
 */
import assert from 'node:assert/strict'

import { loadTools } from './host.mjs'

const env = process.env
const homeDir = env.LARK_TEST_HOME ?? ''
const profile = env.LARK_TEST_PROFILE ?? ''
const pick = (name) => (env[name] ?? '').trim()

if (homeDir === '') {
  console.warn(
    '[warn] 使用系统凭据。若 access_token 已过期，本进程会尝试刷新，而沙箱写不进凭据库——' +
      '这次刷新可能作废系统里的 refresh_token。稳妥做法：在 DSH 会话里跑，或先 `lark-cli auth login --profile larktest` 再带 LARK_TEST_PROFILE。',
  )
}

const { tools, warnings } = loadTools({ homeDir, profile, maxChars: 6000, timeoutMs: 90_000 })
for (const warning of warnings) console.log(`[warn] ${warning}`)

/** 每项都声明自己需要哪些环境变量；缺了跳过，不算失败。 */
const cases = []

function add(label, needs, tool, args, expect) {
  const missing = needs.filter((name) => pick(name) === '')
  cases.push({ label, missing, tool, args, expect })
}

add('feishu_status', [], 'feishu_status', {}, (text) => text.includes('飞书连接') && !text.includes('不可用'))
add(
  'feishu_search',
  ['LARK_TEST_SEARCH_QUERY'],
  'feishu_search',
  { query: pick('LARK_TEST_SEARCH_QUERY'), pageSize: 3 },
  (text) => /命中 \d+ 条/.test(text),
)
add(
  'feishu_doc_read / docx（大纲）',
  ['LARK_TEST_DOCX_URL'],
  'feishu_doc_read',
  { url: pick('LARK_TEST_DOCX_URL'), scope: 'outline' },
  (text) => text.includes('类型：新版文档') && text.includes('# '),
)
add(
  'feishu_doc_read / docx（正文降级为 markdown）',
  ['LARK_TEST_DOCX_URL'],
  'feishu_doc_read',
  { url: pick('LARK_TEST_DOCX_URL'), limit: 1500 },
  (text) => !/<p>|<li>/.test(text),
)
add(
  'feishu_doc_read / wiki 节点',
  ['LARK_TEST_WIKI_URL'],
  'feishu_doc_read',
  { url: pick('LARK_TEST_WIKI_URL'), limit: 1200 },
  (text) => text.includes('类型：') && text.length > 100,
)
add(
  'feishu_doc_read / xml 原始模式',
  ['LARK_TEST_DOCX_URL'],
  'feishu_doc_read',
  { url: pick('LARK_TEST_DOCX_URL'), format: 'xml', scope: 'outline', limit: 800 },
  (text) => text.includes('<outline') || text.includes('<h1') || text.includes('<fragment'),
)
add(
  'feishu_sheet_read / 工作表清单',
  ['LARK_TEST_SHEET_URL'],
  'feishu_sheet_read',
  { url: pick('LARK_TEST_SHEET_URL') },
  (text) => text.includes('个工作表'),
)
add(
  'feishu_sheet_read / 区间',
  ['LARK_TEST_SHEET_URL', 'LARK_TEST_SHEET_NAME'],
  'feishu_sheet_read',
  { url: pick('LARK_TEST_SHEET_URL'), sheet: pick('LARK_TEST_SHEET_NAME'), range: 'A1:D4' },
  (text) => text.includes('[row=1]'),
)
add(
  'feishu_bitable_read / 表清单',
  ['LARK_TEST_BASE_URL'],
  'feishu_bitable_read',
  { url: pick('LARK_TEST_BASE_URL') },
  (text) => text.includes('数据表') && !text.includes('飞书返回失败'),
)
add(
  'feishu_bitable_read / 记录',
  ['LARK_TEST_BASE_URL', 'LARK_TEST_BASE_TABLE'],
  'feishu_bitable_read',
  { url: pick('LARK_TEST_BASE_URL'), table: pick('LARK_TEST_BASE_TABLE'), limit: 3 },
  (text) => text.includes('| _record_id |') || text.includes('Meta:'),
)
add('feishu_chat_list', [], 'feishu_chat_list', { limit: 3 }, (text) => text.includes('oc_'))
add(
  'feishu_chat_history',
  ['LARK_TEST_CHAT'],
  'feishu_chat_history',
  { chat: pick('LARK_TEST_CHAT'), limit: 2 },
  (text) => text.includes('om_') || text.includes('消息'),
)
add(
  'feishu_message_search',
  ['LARK_TEST_MESSAGE_QUERY'],
  'feishu_message_search',
  { query: pick('LARK_TEST_MESSAGE_QUERY'), limit: 2 },
  (text) => text.includes('消息搜索'),
)
add(
  'feishu_whiteboard_read',
  ['LARK_TEST_BOARD_URL'],
  'feishu_whiteboard_read',
  { url: pick('LARK_TEST_BOARD_URL') },
  (text) => text.includes('画板'),
)
add(
  'feishu_doc_comments',
  ['LARK_TEST_BOARD_URL'],
  'feishu_doc_comments',
  { url: pick('LARK_TEST_BOARD_URL') },
  (text) => text.includes('评论') || text.includes('条'),
)
add(
  'feishu_minutes_read',
  ['LARK_TEST_MINUTES_URL'],
  'feishu_minutes_read',
  { url: pick('LARK_TEST_MINUTES_URL'), parts: ['summary'] },
  (text) => text.includes('妙记') && text.includes('## 总结'),
)

let failed = 0
let ran = 0
let skipped = 0

for (const testCase of cases) {
  if (testCase.missing.length > 0) {
    skipped += 1
    console.log(`- ${testCase.label}：跳过（缺 ${testCase.missing.join('、')}）`)
    continue
  }
  ran += 1
  const started = Date.now()
  let output
  try {
    output = await tools.get(testCase.tool).execute(testCase.args, {})
  } catch (error) {
    failed += 1
    console.error(`✗ ${testCase.label}：抛异常 ${String(error?.stack ?? error)}`)
    continue
  }
  const ok = testCase.expect(output)
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`${ok ? '✓' : '✗'} ${testCase.label}（${elapsed}s，${output.length} 字符）`)
  if (!ok) {
    failed += 1
    console.log(
      output
        .split('\n')
        .slice(0, 12)
        .map((line) => `    ${line}`)
        .join('\n'),
    )
  }
}

if (ran === 0) {
  console.error('\n没有可跑的用例：请把 .env.example 复制成 .env 并填上你自己的链接。')
  process.exit(1)
}
assert.equal(failed, 0, `${failed} 个联调用例失败`)
console.log(`\n跑完 ${ran} 项，跳过 ${skipped} 项，全部通过`)
if (skipped > 0) console.log('要覆盖剩下的工具，把 .env.example 里对应的变量也填上。')
