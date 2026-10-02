# FLY-3136 手机远程只读看控制台 — 设计评审记录
Issue: FLY-3136 (https://linear.app/geoforge3d/issue/FLY-3136/cloudflaref2-annie-在任何地方用手机登录自己的-google-邮箱就能打开-bridge-控制台第一版只读)
日期: 2026-10-01
基于: plan.md

Codex（gpt-6-astra / xhigh），同一线程 3 轮，R3 **APPROVED**。plan.md 在批准后不再改动（批准 blob 必须一致）；R3 的非阻塞建议记在这里，实现时照做。

| 轮次 | 结论 | 发现 | 处理 |
|---|---|---|---|
| R1 | CHANGES REQUESTED | 2 HIGH / 3 MEDIUM / 1 LOW：只读页面初始化访问被删 DOM（首屏即崩）；快照嵌套 error 透传本机路径与 YAML 原文；launchd 重启绕过隧道守卫；监听地址与隧道目标 IPv4/IPv6 不一致；远程关停无上限；JWT 自写成本 | 全部采纳：结构化省略 + DOM 执行测试；显式投影 + `config_unreadable`；受管启动器；固定 `127.0.0.1` + 单一 origin；有界幂等关停；改用 `jose` |
| R2 | CHANGES REQUESTED | 1 HIGH：校验人写 YAML 时漏掉 `originRequest.bastionMode`（离线实测可把实际转发目标改成由客户端头决定，绕到主端口）；1 LOW：email 类型 / 未来 iat / JWKS 错误按阶段分类 | 全部采纳：改为从 `.env` 从零生成固定结构配置 + `env -i` 净化环境（去 token 覆盖）+ 主端口 Cloudflare 头绊线；C2 对齐 |
| R3 | **APPROVED** | 1 LOW（非阻塞）：主端口绊线只能拒绝「带 Cf-Ray / Cf-Connecting-Ip / Cf-Access-Jwt-Assertion 头的 HTTP 请求」；TCP / bastion 字节流里的内层 HTTP 不带这些头 | 见下 |

## 实现时必须遵守的 R3 文案收紧（不改 plan.md，以此为准）

- C5 主端口绊线的定位是「**拒绝携带这些头的普通 HTTP 误转发，并提供诊断信号**」，不是「任何 Cloudflare 隧道流量都会被拒」。
- plan.md 中 C5、C6「剩余风险」、§4、§7.1 里「无论隧道配置以何种方式漂移……都收不到」「即使发生也会 403」等绝对表述，在代码注释、runbook、PR 描述里一律按上一条的有限保证来写：**手工代理 / 在 Cloudflare 后台迁移或编辑隧道，不在保证范围内**（runbook 明令禁止）。
- C7.6 用例命名与断言写成「带指定头必拒绝」，不要解释成「任意 Cloudflare 传输必拒绝」。
- 不因此扩大主 app 的鉴权改造范围。

## 批准范围
- 受管、本地托管（credentials-file）的 Cloudflare named tunnel + Access；Tailscale 仍需 founder 选择 + Host spike；research §3.1 的临时隧道候选**不在**本次批准范围。
- 设计批准不代表 C7 测试、代码评审、真机手机验收已通过。
