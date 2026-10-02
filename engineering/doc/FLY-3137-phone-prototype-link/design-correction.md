# FLY-3137 手机能打开的原型链接 — 设计更正
Issue: FLY-3137 (https://linear.app/geoforge3d/issue/FLY-3137/cloudflaref3-runner-做的能用的原型给一个手机能打开的-https-链接annie-在手机上就能真的点真的存数据)
日期: 2026-10-01
基于: plan.md

> 状态：本更正已在设计返工中**并入 plan.md v7**（§3、§5.0、§5.1、§5.4、§10），以 plan.md 为准；本文件保留为变更来由记录。

## quick_email 名单门的增量加固

### 风险

`quick_email` 的名单门由 cloudflared 启动参数 `--allowed-mail` 提供。源站目前不核验 Cloudflare Access JWT；如果启动参数漏传，临时隧道会退化成等价于 `quick_public` 的公开源站。

plan v6 §5.1-6 已有第一道激活门：`quick_email` 只有在外网自检得到 `302`，且 `Location` 主机为 `login.trycloudflare.com`、查询参数 `hostname` 等于本隧道主机后，才允许激活和发卡；否则以 `start_failed` 关闭且不发布链接。本更正在此基础上增加以下防线。

### 启动前双重断言

1. Bridge 在 spawn 租约看门程序前读取并校验 `tunnel-args.json`：`quick_email` 必须包含 `--allowed-mail`，且参数中的邮箱集合与当前项目配置名单完全相等；缺失、重复、额外或遗漏邮箱都 fail closed，不启动任何进程。
2. 租约看门程序在 spawn cloudflared 前独立执行同一校验；不符即退出，不产生隧道。

### 运行中立即熔断

`quick_email` 的周期外网探测只要取得一个确定 HTTP 响应，而结果不是「`302` 到 `login.trycloudflare.com` 且 `hostname` 等于当前隧道主机」，就立即关闭预览，不走普通网络失败的连续四次宽限。新增关闭原因 `access_gate_missing`，中文显示「名单门失效」。超时、断网等无法确认名单门是否缺失的情况仍按普通可达性失败累计。

> v8 修订（新 thread 评审 R1）：「确定 HTTP 响应」的口径收窄为 plan.md §5.4 的单一分类器 `classifyPublicProbe()`——只有 2xx（源站内容直接可见）或跳转去向/`hostname` 不对才是 `access_gate_missing`；401/403/404/429、5xx、530、超时、断网、DNS 失败都是 transient，走四次宽限。另新增 cloudflared 启动隔离（专属 `--config` + 白名单环境），见 plan.md v8 §5.0。

### JWT 后续验证

v1 不依赖源站 JWT 校验，安全防线是激活前外网自检、启动前双重参数断言和运行中立即熔断。真机 QA 的 `quick_email` 场景在 OTP 登录后额外记录源站收到的请求头：若存在 `Cf-Access-Jwt-Assertion`，另开 follow-up 评估源站本地核验代理或校验库；该 follow-up 不扩大本单 v1 范围。

### 部署边界

cloudflared ≥2026.9.3 的升级仍是 plan §9 的人工部署前置。实现阶段不修改宿主机安装。
