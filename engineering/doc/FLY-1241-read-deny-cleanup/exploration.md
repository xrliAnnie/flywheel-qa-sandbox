# FLY-1241 删除 codex_lead_read_deny flag + read-deny-profile.ts — 探索

Issue: FLY-1241 (https://linear.app/geoforge3d/issue/FLY-1241/flag-cleanup-delete-codex-lead-read-deny-flag-read-deny-profilets-code)
日期: 2026-07-14
基于: 无

## 决定来源

FLY-1136 逐条 flag 审计,Annie 圈选 = **①删**(2026-07-14)。Tadashi 工程事实:「我们已全面转
AI-agnostic 全权限 → 这个 read-deny 的存在理由已消失。动的是 codex-lead 运行时,单独审。」

## What(issue 交付)

- 移除 `codex_lead_read_deny` flag(env `FLYWHEEL_CODEX_LEAD_READ_DENY`)+ 所有引用。
- 摘除 `read-deny-profile.ts` 代码路径。
- 因触及 codex-lead 运行时,单独 codex code review。

## read-deny 是什么(背景)

FLY-260 的产物:一个**只读 Codex Lead**(如 Mufasa 早期 companion 形态)的 model exec shell 跑在
Codex sandbox 下,legacy `sandbox_mode=read-only` 只挡**写 + 网络**,不挡**读** → shell 能
`cat ~/.codex-mufasa/auth.json` 把 token 经 Discord reply 外泄。read-deny = 用 Codex 0.140 的
`[permissions]` profile(`filesystem = "deny"`,kernel/Seatbelt 强制)+ `[shell_environment_policy].exclude`
把读也堵上,gated 在 default-OFF 的 `FLYWHEEL_CODEX_LEAD_READ_DENY=1` 后面。

**为什么存在理由消失**:全队已转 `full-access`(= Claude-equal,workspace-write + 网络 ON + 本地
gh/git,**无** read-deny),接受「Lead 能像 Claude pane 一样读磁盘」这个 Claude-equal tradeoff。
生产 `~/.flywheel/projects.json` 唯一 `codexProfile` = `full-access`。read-deny **生产从未启用**
(opt-in,default false)。

## 代码审计:read-deny 的完整删除面

### 核心源码

| 文件 | 处理 |
|------|------|
| `packages/teamlead/src/lead-backends/codex/read-deny-profile.ts` | **删整个模块**(READ_DENY_* 常量、isReadDenyEnabled、resolveReadDenyThread、assert*、extract*) |
| `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts` | 删 `readDeny` config 字段、`isReadDenyEnabled` import、read-deny×sandbox 校验、`content-coordination requires read-deny` guard、resolveReadDenyThread 调用、buildThreadParams 的 sandbox-param omit 分支、启动日志 read-deny 行 |
| `packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts` | 删 resolveReadDenyThread import + 调用、`FLYWHEEL_CODEX_LEAD_READ_DENY:"0"` full-access pin、read-deny 分支 |
| `packages/teamlead/src/lead-backends/codex/tui-window.ts` | 删 `readDeny?` spec 字段;`buildTuiCommand` 三元 `fullAccess ? [...] : readDeny ? [] : ["-s read-only"]` → `fullAccess ? [...] : ["-s read-only"]` |
| `packages/teamlead/src/lead-backends/codex/lead-actions/mcp-config.ts` | full-access「must NOT set default_permissions」断言 → 保留(仍是有效 full-access guard),注释去 read-deny 措辞 |
| `packages/teamlead/src/lead-backends/codex/lead-actions/{lead-actions-main,config}.ts` | 仅注释提及 read-deny → 更新措辞 |
| `packages/config/src/feature-flags/registry.ts` | 删 `codex_lead_read_deny` flag entry(governance_gate) |

### 脚本

| 文件 | 处理 |
|------|------|
| `packages/teamlead/scripts/codex-lead-tui-home.sh` | 删 `write_read_deny_config` + read-deny 分支;`ensure_daemon` 的 read-deny stop-before-start 保留(full-access 也需要,pin ⑤) |
| `packages/teamlead/scripts/templates/codex-read-deny-profile.toml` | **删 template** |
| `packages/teamlead/scripts/run-codex-lead-mufasa-tui.sh` / `run-codex-lead-mufasa-tui-fullaccess.sh` / `run-codex-infra-bot-tui.sh` | 删 READ_DENY export/引用 |

### 测试(删 / 改)

`read-deny-profile.test.ts`(删)、`fly260-read-deny-enforcement.test.sh` + `fly260-read-deny-appserver-probe.mjs`(删)、
`codex-lead-runtime.test.ts` / `tui-window.test.ts` / `mcp-config.test.ts` / `codex-lead-tui-runtime.test.ts` /
`codex-lead-tui-home.test.sh` / `run-codex-lead-mufasa-tui*.test.sh`(改:去 read-deny 断言)。

### 不动(历史/无关)

`doc/engineer/plan/{new,archive,inprogress}/*`、`qa-fly310/*`、`product/doc/FLY-1091-*/audit.md`、
`.claude/skills/*`(本 issue 自动注入的 context)= 历史存档,不改写。

## 🔑 关键 scope 决策:content-coordination profile

**content-coordination 硬依赖 read-deny,是这次删除的真正难点。**

事实:
1. Runtime `codex-lead-runtime.ts:719` fail-closed:`content-coordination && !readDeny → throw`。
2. **content-coordination 没有独立 config 写入路径** —— `codex-lead-tui-home.sh:525-529` 明确注释:
   "no append_lead_actions_mcp here — content-coordination REQUIRES read-deny ... the lead-actions
   MCP block is only ever written on the read-deny path above"。即 content-coordination 的 config.toml
   完全建在 `write_read_deny_config` 之上;非-read-deny 路径**故意不 append** lead-actions MCP。
3. content-coordination **生产 dormant**(projects.json 只用 full-access)。
4. content-coordination 的**全部安全理由** = read-deny(read-only + 挡读,让 proactive-outbound Lead 读不到本地 secret)。

→ 删 read-deny 会**结构性打断** content-coordination,除非净新建一条 plain-read-only config 路径。

### 两个选项

**Option A(推荐)— read-deny 与 content-coordination profile 一起删。**
- 理由:content-coordination 没有独立 config 路径(删 read-deny 即结构性打断);生产 dormant;
  给它净新建一条 plain-read-only config 只会**重新打开** read-deny 当初堵的 secret-exfil 洞
  (一个能读 secret 又有 proactive discord_send 的只读 Lead)。它已被 full-access + FLY-304
  proactive discord_send 取代。
- **保留**共享的 lead-actions MCP 基建(`discord-send-core` / `alias-allowlist` / `mcp-config` /
  `lead-actions-main` —— full-access 也用它,line 1341 + 744)。只删 content-coordination **profile**
  (enum 值 + 其 read-only×read-deny gating + `content-coordination-contract.md` + shell 的
  content-coordination 分支 + `append_lead_actions_mcp` 的 profile-gate)。
- 额外面:`ProjectConfig.ts` codexProfile enum 去 `content-coordination` + 其 cross-field 校验、
  `content-coordination-contract.md`、`run-codex-lead-mufasa-tui.sh` 的 content-coordination 分支、相关测试。
- 净效果:结构干净,无 latent 洞,生产零行为变化(生产不用 content-coordination)。

**Option B(备选)— 只删 read-deny,保留 content-coordination(解耦)。**
- 需给 content-coordination 净新建 plain-read-only base config + 去掉 `requires read-deny` guard。
- 代码更多,且给一个 dormant profile **重新引入** secret-exfil 洞(read-only Lead 能读 secret + proactive discord)。
- 不推荐。

## 预期结果

- read-deny(flag + 模块 + 全部 plumbing + template + 测试 + registry entry)删净。
- full-access / companion / write-capable Lead **字节兼容**(它们的 config 路径不依赖 read-deny)。
- content-coordination 按 Tadashi 拍板处理。
- 全测 + CI 绿;单独 codex code review(触及 codex-lead runtime)。
- **生产零行为变化**(生产跑 full-access,不受影响)。
