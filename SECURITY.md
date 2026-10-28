# 安全说明

## 凭据

本仓库**不含任何凭据**：没有 app id / app secret、没有 access token、没有 refresh token，
也没有真实的文档地址、群名或租户域名。测试里出现的链接与 token 全部是占位符。

凭据由 lark-cli 自己保管，插件只是调用它：

- macOS：`~/Library/Application Support/lark-cli/`
- Windows：`%APPDATA%\lark-cli\`
- Linux：`~/.config/lark-cli/`

每个使用者都要用自己的飞书账号执行一次 `lark-cli auth login`。插件不读取、不复制、
不缓存凭据，也不把文档正文落盘。

**如果你发现仓库里意外出现了凭据**，请立刻在 GitHub 上开一个 Security Advisory
（Security → Report a vulnerability），不要开公开 issue。同时提醒提交者到飞书开放平台
重置该应用的 secret 并重新授权。

## 权限模型与已知取舍

- 工具运行在 DSH 宿主进程里，**不经过 `workspace-write` 文件沙箱**。这是为了能复用
  lark-cli 的凭据库并正常刷新令牌；代价是插件以当前用户的权限运行。
- 因此本仓库只注册**只读**命令：没有任何发消息、改文档、删文件的入口。
- 插件能读到什么，取决于授权账号此刻在飞书里的可见范围；没有额外提权路径。

## 报告问题

- 安全漏洞：Security → Report a vulnerability（私密）
- 一般缺陷：GitHub Issues
