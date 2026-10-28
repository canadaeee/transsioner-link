# Transsioner-CLI · 飞书连接器

把本机已登录的 **lark-cli** 接成 DSH 的只读工具：Agent 可以直接读企业飞书的**云文档、
电子表格、多维表格、画板、评论、妙记**，也能**查群、读群消息、跨群搜消息**。

不重新实现飞书 API，不保存任何凭据，不缓存正文——每次调用都是一次实时读取，
权限就是你此刻在飞书里的可见范围。

> 仓库名是 `transsioner-link`，npm 包名是 `transsioner-cli`。DSH 按包名登记 bundle，两者不冲突。

---

## 🔑 凭据：每个人用自己的，仓库里没有

**本仓库不包含任何凭据、令牌、文档地址或群名。** 你看到的所有链接、token、群名都是占位符。

凭据只存在你本机 lark-cli 自己的库里，插件从不读取、复制、缓存它们：

| 平台 | 凭据位置 |
|---|---|
| macOS | `~/Library/Application Support/lark-cli/` |
| Windows | `%APPDATA%\lark-cli\` |
| Linux | `~/.config/lark-cli/` |

所以**每个人第一次使用时，都要用自己的账号授权一次**：

```bash
lark-cli auth status                    # 先看现状，user 身份应为 ready
lark-cli auth login                     # 未授权时执行，浏览器里用你自己的飞书账号登录
lark-cli auth login --profile larktest  # 想和日常凭据隔离时，用独立 profile
```

授权用的是**你自己的**账号，读到的也只能是你自己可见的内容。你所在企业的自建应用
需要先开通下面[那组 scope](#前置条件)，否则会报权限不足。

提交代码前请确认 `.env`（联调用的本地链接）不会被带上——`.gitignore` 已经挡住了它，
跑 `npm run verify` 也会检查仓库里没有凭据文件。

---

## 安装

三种方式任选，第一种最省事。

**① 直接在 DSH 里填仓库地址（推荐，随时跟远端走）**

插件页 → 添加插件 → 粘贴：

```
https://github.com/canadaeee/transsioner-link
```

DSH 会用 pnpm 把仓库克隆到当前 profile 并登记成 bundle，装完重启生效。
想固定某个版本就在后面加 `#v1.1.1`。

**② 用 Release 里的 tgz（国内网络拉 GitHub 不稳时更可靠）**

```
https://github.com/canadaeee/transsioner-link/releases/latest/download/transsioner-cli.tgz
```

**③ 本地目录（自己改代码时用）**

插件页 → 添加插件 → 填本目录绝对路径。这种方式是软链，改完代码重启即生效；
前两种是快照，升级要重新安装。

> 手动等价物：把包加进 profile 的 `dependencies` 与 `dsh.profile.bundles`，再 `pnpm install`。
> 不推荐手改——profile 的 `package.json` 与 `cordis.patch.yml` 由宿主管理。

---

## 前置条件

1. **本机装有 lark-cli**，并已用**你自己的账号**完成授权（见上一节）。
2. **你所在企业的自建应用已开通这些权限**（`feishu_status` 可逐项核对）：

   | 能力 | scope |
   |---|---|
   | 文档正文 | `docs:document.content:read`、`docx:document:readonly` |
   | 电子表格 | `sheets:spreadsheet:read` |
   | 多维表格 | `base:record:read`、`base:table:read` |
   | 群信息 | `im:chat:read` |
   | 群消息 | `im:message:readonly`、`im:message.group_msg:get_as_user` |
   | 云文档搜索 | `search:docs:read` |
   | 消息搜索 | `search:message` |
   | 知识库节点 | `wiki:node:read` |

   缺哪个就找管理员在开放平台补，补完 `lark-cli auth login` 重新授权。

---

## 为什么是「插件」而不是让 Agent 跑命令

DSH 的 `bash` 工具在 `workspace-write` 沙箱里执行。lark-cli 刷新用户令牌时要写凭据库，
沙箱会拒掉这次写入，于是**用户身份的调用在会话里时通时不通**：

```
keychain Set failed: open .../refresh-storage-probe.enc.xxx.tmp: operation not permitted
```

本插件在自己的宿主进程里直接 `spawn` lark-cli（不经过 bash 沙箱），
复用系统里唯一那份凭据库，因此不会产生第二份会互相顶掉 `refresh_token` 的副本。

**代价要说清楚**：这些工具**不受文件沙箱约束**。所以本插件只注册读命令——
发消息、改文档、删文件一律不提供。

---

## 工具

| 工具 | 用途 | 典型入参 |
|---|---|---|
| `feishu_status` | 连接自检：lark-cli 位置、应用、user/bot 状态、已授权范围 | — |
| `feishu_search` | 按关键词搜云文档/知识库/表格 | `{query:"周报"}` |
| `feishu_doc_read` | 读文档正文（docx、旧版 doc、wiki 节点自动解析） | `{url:"https://…/docx/xxx", scope:"outline"}` |
| `feishu_sheet_read` | 工作表清单 / 指定区间 CSV | `{url:"…/sheets/xxx", sheet:"Sheet1", range:"A1:F30"}` |
| `feishu_bitable_read` | 多维表格的数据表 / 记录 | `{url:"…/base/xxx", table:"数据表1"}` |
| `feishu_chat_list` | 我所在的群（可关键词搜索） | `{query:"周会"}` |
| `feishu_chat_history` | 某个会话的消息记录 | `{chat:"产品周会", limit:20}` |
| `feishu_message_search` | 跨会话搜消息 | `{query:"上线时间", start:"2026-10-01T00:00:00+08:00"}` |
| `feishu_whiteboard_read` | 读文档/画板里的节点文字 | `{url:"…/wiki/xxx"}` |
| `feishu_doc_comments` | 文档、表格、画板的评论与回复 | `{url:"…/docx/xxx"}` |
| `feishu_minutes_read` | 妙记的总结、待办、章节、关键词 | `{url:"…/minutes/xxx"}` |

约定：
- 链接与 token 通用；`/docx/`、`/docs/`、`/wiki/`、`/sheets/`、`/base/` 都能识别，类型不匹配会明确告诉你该用哪个工具。
- 长文档先 `scope:"outline"` 看结构，再 `scope:"section"`/`keyword` 局部读；也可以用 `offset`/`limit` 分段。
- 单次返回有字符上限（默认 3 万），超出会截断并提示怎么继续。

---

## 配置

在 `cordis.patch.yml` 的那一行里改：

| 字段 | 默认 | 说明 |
|---|---|---|
| `larkBin` | 自动查找 | lark-cli 绝对路径；PATH 里没有时填这个 |
| `profile` | 当前 profile | 多套飞书应用时指定 |
| `identity` | `user` | `user` 以你的身份读；`bot` 只能读共享给机器人的内容 |
| `timeoutMs` | `60000` | 单次调用超时 |
| `maxChars` | `30000` | 单次返回给模型的字符上限 |
| `enableChat` | `true` | 设为 `false` 只保留文档类工具（合规收紧时用） |
| `homeDir` | 空 | 排障用：把 lark-cli 状态重定向到别的 HOME。**正常不要设**，会造成令牌副本 |

---

## 自检与测试

```bash
npm test            # 离线冒烟：链接解析、DocxXML 降级、错误翻译、注册面、runner 边界
npm run verify      # 交付自检：manifest / files / locale / 图标 / 包内容 / 无凭据文件
```

联调用**你自己的**数据，仓库里没有别人的链接可借：

```bash
cp .env.example .env    # 填上你有权限的文档、表格、群名
node --env-file=.env test/live.mjs
```

没填的项会跳过，不算失败；填了却读不到才是失败。

**别用「复制凭据目录」的方式做联调。** 飞书的 `refresh_token` 是一次性的：
副本刷新成功拿到新令牌，但沙箱写不回原库，等于把系统那份作废、而新令牌也随副本丢了。
要隔离就跑一次独立授权：

```bash
lark-cli auth login --profile larktest
LARK_TEST_PROFILE=larktest node --env-file=.env test/live.mjs
```

否则直接在 DSH 会话里跑 `live.mjs`（宿主进程不受文件沙箱限制，刷新能正常落盘）。

---

## 读文档为什么用 `im-markdown`

`docs +fetch` 的 `--doc-format` 有三档：`xml`（默认）、`markdown`、`im-markdown`。
在 1.0.88 上实测，`markdown` 只转换部分块类型，`<title>`、`<blockquote><p>`、
`<cite>`、`<table>`、`<grid><column>` 都会原样留下（等于给模型喂 XML）；
`im-markdown` 会把残留的 DocxXML 一起降级：

- 表格 → 真正的 Markdown 表格（单元格内换行用 `<br>`）
- 任务列表 → `- [ ]`
- 提及 → `@姓名`（本地再补空格，避免 `@张三@李四` 粘在一起）
- 画板 / 内嵌表格 / Base / 日历日程 → 占位符 + token，可以继续读

代价：`<grid>` 的分栏会被摊平（列与列的对应关系丢失），只读块只剩 token。
若你的 CLI 版本仍然返回纯 DocxXML，[lib/docx.js](lib/docx.js) 里有完整的本地转换兜底。

另外 runner 会设 `LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1` 和 `LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1`，
免得每次调用都带一条「有新版本」的 `_notice`。

---

## 版本适配（v1.1.1）

- **多维表格记录**：`lark-cli` 1.0.98 起移除了 `base +record-list --format markdown`
  （只剩 `json` 内联矩阵与 `ndjson` 落盘），旧代码会直接收到
  `deprecated format: markdown is no longer supported`。现在统一用
  `--format json` 拿 `fields` + 二维 `data`，由插件自己渲染 Markdown 表格，
  并额外保留 `record_id` 列，1.0.88 与 1.0.98 都能跑。
- **数据表清单**：`base +table-list` 返回的字段是 `id` / `rev` / `records_count`，
  不是 OpenAPI 文档里的 `table_id` / `revision`，以前会渲染成 `table_id=undefined`；
  现在两个名字都认，顺带显示记录条数。
- **画板原生表格**：`whiteboard +export --output-type raw` 里表格是 `type: "table"`
  节点，文字在 `table.cells[].text.text`（坐标 1 起始），不在 `node.text.text` 上。
  以前只读后者，流程图里的阶段名/泳道名/门禁整块丢失；现在按 `table.meta`
  的行列数还原成 Markdown 表格。
- **错误提示**：缺权限时把 `missing_scopes` 原样列出来；`232034`（应用未发布）
  与 `wiki:node:retrieve` 有针对性建议。

---

## 已知限制

- **旧版文档**（`/docs/`、wiki 指向的旧 doc）只能读整篇纯文本，没有标题层级和范围读取。
- 文档里的图片、画板、电子表格内嵌块只留占位（`[图片：xxx.png]`、`[画板]`），不下载二进制。
- `docs +fetch --doc-format markdown` 在 lark-cli 1.0.8x 上仍返回 DocxXML，插件内置了降级转换；
  升级到会真正输出 markdown 的版本后，转换自动跳过（内容里没有标签）。
- 群消息只读文本内容；图片/文件给的是 `[Image: xxx]` 这类占位，不自动下载附件。
- 飞书接口有频控；连续大量读取时 `lark-cli` 会返回限流错误，等一会儿再试。
- 消息搜索**不返回群名**，只给 `chat_id`；要群名可以先 `feishu_chat_list`。

---

## 安全边界

- 只注册读命令，没有任何发送/修改/删除入口。
- 不读、不写、不缓存凭据；凭据始终在 lark-cli 自己的库里。
- 不把正文落盘；返回给模型的文本只存在于会话日志中。
- 工具调用**不受 workspace 文件沙箱约束**（这是能用起来的前提，也是设计上的取舍）。
  插件以你的权限在宿主进程里运行，因此**只装你信任来源的插件**。
- 失败时会把飞书的 `code` / `type` / `log_id` 一起带出来——报障时贴这段信息最有用。
  lark-cli 把**成功**写 stdout、**失败**写 stderr，本插件的 runner 两边解析。

---

## License

MIT，见 [LICENSE](LICENSE)。
