/**
 * 离线冒烟：不碰网络，只验证纯函数与注册面。
 * 跑：node test/smoke.mjs
 */
import assert from 'node:assert/strict'

import { createRunner, extractJson, formatApiFailure, resolveLarkBin } from '../lib/cli.js'
import {
  cleanDocMarkdown,
  describeReferenceMap,
  docxToMarkdown,
  looksLikeDocxXml,
  normalizeDocContent,
} from '../lib/docx.js'
import { clip, renderChats, renderDoc, renderMessages, renderRecords, renderTables } from '../lib/format.js'
import { collectTables, renderComments, renderTableMarkdown, renderWhiteboard } from '../lib/whiteboard.js'
import { parseTarget } from '../lib/link.js'
import { loadTools } from './host.mjs'

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

console.log('链接解析')
check('docx 链接', () => {
  // 全部用假 token：仓库里不放任何真实文档地址或令牌。
  const t = parseTarget('https://acme.feishu.cn/docx/doxcnA1b2C3d4E5f6G7h8I9')
  assert.equal(t.ok, true)
  assert.equal(t.kind, 'docx')
  assert.equal(t.token, 'doxcnA1b2C3d4E5f6G7h8I9')
  assert.equal(t.host, 'https://acme.feishu.cn')
})
check('wiki 链接', () => assert.equal(parseTarget('https://x.feishu.cn/wiki/wikcnA1b2C3d4E5f6G7h8I9').kind, 'wiki'))
check('sheets 链接', () => assert.equal(parseTarget('https://x.feishu.cn/sheets/shtcnABC123').kind, 'sheet'))
check('base 链接', () => assert.equal(parseTarget('https://x.feishu.cn/base/bascnABC123').kind, 'bitable'))
check('裸 token 按前缀定型', () => {
  assert.equal(parseTarget('wikcnA1b2C3d4E5f6G7h8I9').kind, 'wiki')
  assert.equal(parseTarget('doccnA1b2C3d4E5f6G7h8I9').kind, 'doc')
  assert.equal(parseTarget('abc123XYZ789sample').kind, 'token')
})
check('不认识的路径要拒绝', () => assert.equal(parseTarget('https://x.feishu.cn/calendar/abc').ok, false))
check('妙记链接能识别但不当作文档', () => assert.equal(parseTarget('https://x.feishu.cn/minutes/abc').kind, 'minutes'))
check('空输入要拒绝', () => assert.equal(parseTarget('   ').ok, false))

console.log('JSON 提取')
check('忽略进度行', () => {
  const text = 'Fetching wiki node wikc...MMpb...\n{\n  "ok": true,\n  "data": { "a": 1 }\n}\n'
  assert.deepEqual(extractJson(text), { ok: true, data: { a: 1 } })
})
check('带 BOM/空行也能取', () => {
  assert.deepEqual(extractJson('\n\n  {"ok":false,"error":{"code":1}}\n'), { ok: false, error: { code: 1 } })
})
check('非 JSON 返回 undefined', () => assert.equal(extractJson('boom'), undefined))

console.log('DocxXML 降级')
check('标题、段落、加粗', () => {
  const out = docxToMarkdown('<title>T</title><p>a</p><p><b>bold</b> tail</p>')
  assert.equal(out.title, 'T')
  assert.match(out.text, /^# T$/m)
  assert.match(out.text, /\*\*bold\*\* tail/)
})
check('嵌套列表缩进', () => {
  const out = docxToMarkdown('<ul><li>A<ul><li>B</li></ul></li></ul>')
  assert.match(out.text, /^- A$/m)
  assert.match(out.text, /^  - B$/m)
})
check('待办复选框', () => {
  const out = docxToMarkdown('<checkbox done="true">done item</checkbox><checkbox done="false">todo item</checkbox>')
  assert.match(out.text, /- \[x\] done item/)
  assert.match(out.text, /- \[ ] todo item/)
})
check('引用里的人名不丢', () => {
  const out = docxToMarkdown('<p>x <cite type="user" user-name="王胤明"></cite></p>')
  assert.match(out.text, /x @王胤明/)
})
check('链接保留 URL', () => {
  const out = docxToMarkdown('<p><a href="https://a.b/c">文字</a></p>')
  assert.match(out.text, /\[文字\]\(https:\/\/a\.b\/c\)/)
})
check('实体解码', () => assert.match(docxToMarkdown('<p>a &amp; b &lt;c&gt;</p>').text, /a & b <c>/))
check('纯文本不被误伤', () => {
  const plain = '普通正文，没有标签。'
  assert.equal(looksLikeDocxXml(plain), false)
  assert.equal(normalizeDocContent(plain).text, plain)
})
check('真实样式的文档不残留标签', () => {
  const sample =
    '<fragment mode="full"><title>智能纪要</title><blockquote><p>主题：X</p></blockquote><h1>总结</h1>' +
    '<ul><li><b>A</b></li></ul><readonly-block type="isv"></readonly-block></fragment>'
  const text = docxToMarkdown(sample).text
  assert.doesNotMatch(text, /<[a-z]/i)
  assert.match(text, /> 主题：X/)
  assert.match(text, /# 总结/)
})

console.log('多维表格渲染')
check('表清单认 id/rev/records_count，不出现 undefined', () => {
  const text = renderTables({ url: 'u', tables: [{ id: 'tblA', name: 'A表', rev: 7, records_count: 3 }] })
  assert.match(text, /table_id=tblA/)
  assert.match(text, /3 条记录/)
  assert.match(text, /rev=7/)
  assert.doesNotMatch(text, /undefined/)
})
check('老版本返回的 table_id/revision 也认', () => {
  const text = renderTables({ tables: [{ table_id: 'tblB', name: 'B表', revision: 9 }] })
  assert.match(text, /table_id=tblB/)
  assert.match(text, /rev=9/)
})
check('记录按 fields + 二维矩阵渲染，复杂单元格拍平', () => {
  const text = renderRecords({
    table: 'T',
    fields: ['名称', '状态', '人'],
    rows: [
      ['甲', ['完成'], [{ id: 'ou_1', name: '王胤明' }]],
      ['乙', null, []],
    ],
    recordIds: ['rec1', 'rec2'],
    hasMore: true,
    rev: 42,
  })
  assert.match(text, /\| 名称 \| 状态 \| 人 \| record_id \|/)
  assert.match(text, /\| 甲 \| 完成 \| 王胤明 \| rec1 \|/)
  assert.match(text, /\| 乙 \|  \|  \| rec2 \|/)
  assert.match(text, /还有更多/)
  assert.match(text, /rev=42/)
})
check('单元格里的换行与竖线不破坏表格', () => {
  const text = renderRecords({ table: 'T', fields: ['a'], rows: [['x\ny|z']] })
  assert.match(text, /x<br>y\\\|z/)
})
check('空表给结论而不是空表格', () => {
  const text = renderRecords({ table: 'T', fields: ['a'], rows: [] })
  assert.match(text, /没有记录/)
})

console.log('画板与评论渲染')
check('画板节点按上下再左右排序', () => {
  const text = renderWhiteboard({
    token: 'WB',
    nodes: [
      { id: 'b', type: 'composite_shape', x: 300, y: 100, text: { text: '右' } },
      { id: 'a', type: 'composite_shape', x: 100, y: 100, text: { text: '左' } },
      { id: 'c', type: 'composite_shape', x: 100, y: 400, text: { text: '下一行' } },
      { id: 'l', type: 'connector', x: 1, y: 1 },
    ],
  })
  assert.match(text, /1\. 左/)
  assert.match(text, /2\. 右/)
  assert.match(text, /3\. 下一行/)
  assert.match(text, /connector×1/)
})
check('多行文字保留缩进', () => {
  const text = renderWhiteboard({ token: 'W', nodes: [{ id: 'a', type: 'shape', x: 0, y: 0, text: { text: '标题\n细节' } }] })
  assert.match(text, /1\. 标题\n   细节/)
})
check('空画板给出提示而不是空白', () => {
  const text = renderWhiteboard({ token: 'W', nodes: [{ id: 'c', type: 'connector' }] })
  assert.match(text, /没有文字节点/)
})
check('画板原生表格按 row/col 还原（文字在 table.cells[].text 上）', () => {
  const nodes = [
    {
      id: 'q1:1',
      type: 'table',
      table: {
        meta: { row_num: 2, col_num: 3 },
        cells: [
          { row_index: 1, col_index: 2, text: { text: '阶段名' } },
          { row_index: 1, col_index: 3, text: { text: '门禁' } },
          { row_index: 2, col_index: 1, text: { text: '产品经理' } },
        ],
      },
    },
  ]
  const text = renderWhiteboard({ token: 'W', nodes })
  assert.match(text, /表格 1 块|表格 1（2 行 × 3 列）/)
  assert.match(text, /\|  \| 阶段名 \| 门禁 \|/)
  assert.match(text, /\| 产品经理 \|  \|  \|/)

  const [table] = collectTables(nodes)
  assert.equal(table.rowNum, 2)
  assert.equal(table.colNum, 3)
  assert.equal(renderTableMarkdown(table, 0).split('\n').length, 4)
})
check('只有表格、没有散文字的画板也要输出表格', () => {
  const text = renderWhiteboard({
    token: 'W',
    nodes: [{ id: 't', type: 'table', table: { meta: { row_num: 1, col_num: 2 }, cells: [{ row_index: 1, col_index: 1, text: { text: '甲' } }] } }],
  })
  assert.match(text, /\| 甲 \|  \|/)
  assert.doesNotMatch(text, /没有文字节点/)
})
check('评论带作者、引用与回复', () => {
  const text = renderComments({
    items: [
      {
        user_id: 'ou_1',
        create_time: 1792578120,
        is_solved: false,
        parent_type: 'WHITEBOARD_BLOCK',
        quote: '核实真实性',
        reply_list: {
          replies: [
            { user_id: 'ou_1', content: { elements: [{ text_run: { text: '主评论' } }] } },
            { user_id: 'ou_2', create_time: 1792578200, content: { elements: [{ text_run: { text: '回复一' } }] } },
          ],
        },
      },
    ],
    names: new Map([['ou_1', '许莹莹'], ['ou_2', '王胤明']]),
    total: 1,
    solved: 'all',
  })
  assert.match(text, /1\. 许莹莹/)
  assert.match(text, /引用：核实真实性/)
  assert.match(text, /评论：主评论/)
  assert.match(text, /回复 1（王胤明/)
})

console.log('im-markdown 清理')
check('提及之间留空格', () => {
  const text = cleanDocMarkdown('> 参会人：<at user_id="ou_1">张三</at><at user_id="ou_2">李四</at>')
  assert.match(text, /@张三 @李四/)
})
check('保留列表缩进', () => {
  const text = cleanDocMarkdown('- A\n\n  - B\n\n    - C')
  assert.match(text, /^  - B$/m)
  assert.match(text, /^    - C$/m)
})
check('去掉 fragment 包裹与占位符反引号', () => {
  const text = cleanDocMarkdown('<fragment mode="full">`[画板：WB1]`\n\n正文</fragment>')
  assert.equal(text, '[画板：WB1]\n\n正文')
})
check('只读块换成占位', () => {
  const text = cleanDocMarkdown('<readonly-block token="CAL1" type="calendar_event"></readonly-block>')
  assert.equal(text, '[日历日程：token=CAL1]')
})
check('中文标点前不多空格', () => {
  assert.equal(cleanDocMarkdown('负责人：<at user_id="o">张三</at>，截止'), '负责人：@张三，截止')
})
check('标题从 # 行提取', () => {
  const out = normalizeDocContent('# 周会纪要\n\n正文')
  assert.equal(out.title, '周会纪要')
  assert.match(out.text, /^正文$/m)
})
check('reference_map 里的 token 不丢', () => {
  const lines = describeReferenceMap({ sheets: { r1: { token: 'SHT', 'sheet-id': 'abc' } }, comments: { c1: { data: 'x' } } })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /token=SHT sheet-id=abc/)
})

console.log('DocxXML 内嵌资源')
check('内嵌电子表格不被静默丢弃', () => {
  const text = docxToMarkdown('<p>a</p><sheet token="SHT" sheet-id="abc"></sheet><p>b</p>').text
  assert.match(text, /\[内嵌电子表格：token=SHT sheet-id=abc\]/)
})
check('引用表格保留类型与 token', () => {
  const text = docxToMarkdown('<p>见 <cite file-type="sheets" token="T2">销售表</cite></p>').text
  assert.match(text, /引用sheets：销售表：T2/)
})
check('内嵌多维表格', () => {
  const text = docxToMarkdown('<bitable token="BT"></bitable>').text
  assert.match(text, /\[内嵌多维表格：token=BT\]/)
})

console.log('错误翻译')
check('令牌失效给出重新登录建议', () => {
  const text = formatApiFailure({ error: { code: 99991663, message: 'invalid token' } }, ['im', '+chat-list'])
  assert.match(text, /lark-cli auth login/)
})
check('沙箱写失败给出可执行建议', () => {
  const text = formatApiFailure({ error: { message: 'keychain Set failed: operation not permitted' } }, ['auth', 'status'])
  assert.match(text, /沙箱|凭据库/)
})

console.log('渲染')
check('clip 带截断说明', () => {
  const text = clip('x'.repeat(100), 10)
  assert.match(text, /已截断/)
  assert.match(text, /共 100 字符/)
})
check('clip 不超限时不加尾巴', () => assert.equal(clip('short', 100), 'short'))
check('文档头含 token 与修订', () => {
  const text = renderDoc({ title: 'T', kind: 'docx', token: 'abc', revision: 7, scope: 'full', content: 'body' })
  assert.match(text, /T/)
  assert.match(text, /token：abc/)
  assert.match(text, /修订：7/)
})
check('群列表带 chat_id', () => {
  const text = renderChats({ chats: [{ name: '储能事业部', chat_id: 'oc_1', description: 'd' }], query: '', types: '群聊' })
  assert.match(text, /oc_1/)
  assert.match(text, /feishu_chat_history/)
})
check('消息渲染带发送人与 message_id', () => {
  const text = renderMessages({
    chatId: 'oc_1',
    messages: [
      { create_time: '2026-09-21 14:29', sender: { name: '张三' }, msg_type: 'text', content: '你好\n世界', message_id: 'om_1' },
    ],
    order: 'desc',
  })
  assert.match(text, /张三/)
  assert.match(text, /你好 世界/)
  assert.match(text, /om_1/)
})

console.log('注册面')
const { tools } = loadTools({})
check('11 个只读工具全部注册', () => {
  const names = [...tools.keys()].sort()
  assert.deepEqual(names, [
    'feishu_bitable_read',
    'feishu_chat_history',
    'feishu_chat_list',
    'feishu_doc_comments',
    'feishu_doc_read',
    'feishu_message_search',
    'feishu_minutes_read',
    'feishu_search',
    'feishu_sheet_read',
    'feishu_status',
    'feishu_whiteboard_read',
  ])
})
check('没有写操作工具', () => {
  for (const name of tools.keys()) assert.doesNotMatch(name, /send|write|update|create|delete/)
})
check('enableChat=false 时只剩文档类工具', () => {
  const { tools: docsOnly } = loadTools({ enableChat: false })
  assert.deepEqual([...docsOnly.keys()].sort(), [
    'feishu_bitable_read',
    'feishu_doc_comments',
    'feishu_doc_read',
    'feishu_minutes_read',
    'feishu_search',
    'feishu_sheet_read',
    'feishu_status',
    'feishu_whiteboard_read',
  ])
})
check('每个工具都有 parameters 与 output', () => {
  for (const [name, tool] of tools) {
    assert.equal(typeof tool.execute, 'function', name)
    assert.equal(tool.parameters.type, 'object', name)
    assert.equal(tool.output.schema.type, 'string', name)
  }
})
check('lark-cli 可解析（未安装时给出可执行建议）', () => {
  const resolved = resolveLarkBin('')
  if (resolved.ok) {
    assert.match(resolved.bin, /lark-cli$/)
    return
  }
  // CI 或没装 lark-cli 的机器：这里不该抛栈，而要给出「怎么装/怎么授权」
  assert.match(resolved.detail, /lark-cli auth login/, `报错不够可执行：${resolved.detail}`)
})

// ── 用假 CLI 验证 runner 的边界行为（错误信封在 stderr、身份参数、超时杀进程组）──
{
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'lark-fake-'))
  const fake = join(dir, 'lark-cli')
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      'const argv = process.argv.slice(2)',
      "if (argv.includes('--fail')) {",
      "  process.stderr.write(JSON.stringify({ ok: false, identity: 'user', error: { type: 'api', code: 99991400, message: 'too many request', log_id: 'LOG1' } }) + '\\n')",
      '  process.exit(1)',
      '}',
      "if (argv.includes('--hang')) { setTimeout(() => {}, 60000); process.stdout.write('{}'); }",
      "else process.stdout.write(JSON.stringify({ ok: true, identity: 'user', data: { argv } }) + '\\n')",
    ].join('\n'),
  )
  chmodSync(fake, 0o755)

  const runner = createRunner({ larkBin: fake, profile: '', identity: 'user', timeoutMs: 5000 })

  const failed = await runner.runJson(['docs', '+fetch', '--fail'])
  if (failed.ok !== false) throw new Error('stderr 错误信封没被识别')
  if (!failed.message.includes('code=99991400')) throw new Error(`丢了错误码：${failed.message}`)
  if (!/频控|等 /.test(failed.message)) throw new Error(`没有限流建议：${failed.message}`)
  passed += 1
  console.log('  ✓ stderr 里的错误信封被翻译成建议')

  const okRun = await runner.runJson(['docs', '+fetch', '--doc', 'X'])
  if (okRun.ok !== true) throw new Error('正常路径失败')
  if (okRun.data.argv.at(-2) !== '--as' || okRun.data.argv.at(-1) !== 'user') {
    throw new Error(`没有显式传身份：${JSON.stringify(okRun.data.argv)}`)
  }
  passed += 1
  console.log('  ✓ 业务命令显式带 --as user')

  const auth = await runner.runJson(['auth', 'status'])
  if (auth.ok !== true) throw new Error('auth 分支失败')
  if (auth.data.argv.includes('--as')) throw new Error(`auth 不该带 --as：${JSON.stringify(auth.data.argv)}`)
  passed += 1
  console.log('  ✓ auth 子命令不带 --as')

  const started = Date.now()
  const hung = await runner.runJson(['docs', '+fetch', '--hang'], { timeoutMs: 800 })
  const elapsed = Date.now() - started
  if (hung.ok !== false || !hung.message.includes('没有返回')) throw new Error('超时没被识别')
  if (elapsed > 4000) throw new Error(`超时没有及时终止：${elapsed}ms`)
  passed += 1
  console.log(`  ✓ 超时会终止调用链（${elapsed}ms）`)
}

console.log(`\n${passed} 项通过`)
