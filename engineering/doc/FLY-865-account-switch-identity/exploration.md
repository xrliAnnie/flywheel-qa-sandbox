# FLY-865 账号切换只换 token 不换显示身份 — 探索

Issue: FLY-865 (https://linear.app/geoforge3d/issue/FLY-865/bug-账号切换只换-token-不换显示身份-新-claude-status-仍显示旧账号阻塞-696-enable)
日期: 2026-07-04
基于: 无(上游 = FLY-696 M1)

---

## 1. 问题定义

FLY-696 M1 的机器级账号切换(`flywheel-claude-profile use <name>`)只做了 **认证 token** 的切换,没有同步 **显示身份**。用户视角 = 切换「从来没生效」。

Annie 真机复现(2026-07-04):drill 切 shopping→business,drill 报成功,但**新开** claude `/status` 仍显示 shopping 的 email/org。

## 2. 已核实证据(本 runner 现场复查,非猜测)

切到 business 后、restore 之前的机器状态:

| 位置 | 值 | 说明 |
|------|-----|------|
| Keychain `Claude Code-credentials` | business token | ✓ switch 写了 auth token |
| `~/.flywheel/claude-profiles/.active` | business | ✓ 池状态对 |
| `~/.flywheel/claude-accounts.json` active | business | ✓ store 对 |
| **`~/.claude.json` 的 `oauthAccount`** | **仍是 shopping** | ✗ **显示身份没换** |

`/status` 读 email/organization 的来源 = `~/.claude.json` 的 `oauthAccount` block:

```
oauthAccount = {
  accountUuid, emailAddress, organizationUuid, organizationName,
  displayName, organizationType, ...(subscription/rate-limit 元数据)
}
```

**根因**:切换链路里没有任何一处 touch `~/.claude.json` / `oauthAccount`:
- `flywheel-claude-profile use`(bash)只 swap Keychain + 写 `.active`。
- TS `switch-executor` → `applyProfile` → 就是调 `flywheel-claude-profile use`,不额外做事。
- 每个 profile 的 `.credentials.json` 只存 token blob(`claudeAiOauth.{accessToken,refreshToken,expiresAt,scopes,subscriptionType,rateLimitTier}`)—— **不含任何账号身份**(没有 accountUuid/emailAddress/org)。

所以切换后 token=business / 显示=shopping,进入**不一致状态**。

## 3. 关键约束

- **RED LINE(FLY-696 沿用):绝不写坏 claude login。** 任何对 `~/.claude.json` 的写必须原子(tmp+rename)、可失败但不破坏文件、失败时 token 切换本身已 verify-before-commit 保护。
- **切换的两条真实入口都必须覆盖**:手动 `flywheel-claude-profile use`(Annie/QA 直接跑)+ 自动轮转(Bridge executor 经 `applyProfile` 调同一条 bash `use`)。→ 修在 bash `use` 路径上,一处覆盖两条。
- **不能从 token 派生身份**:Claude OAuth token 是 opaque `sk-ant-oat01-…`(非 JWT),排除「从 token 解 email/org」。
- **quota-safe QA**:验收全程用假 fixture,不烧真额度、不碰真登录(env override 指向 scratch keychain + scratch `.claude.json`)。

## 4. 候选路径

### 路径 1 —— capture 补存 oauthAccount,use 时写回(推荐)

- `capture <name>` 在存 Keychain token 的**同时**,把当前 `~/.claude.json` 的 `oauthAccount` block 快照进 `pool/<name>/oauthAccount.json`(0600)。
- `use <name>` 在 Keychain verify-before-commit **之后**,原子地把 `pool/<name>/oauthAccount.json` 写回 `~/.claude.json` 的 `oauthAccount` 字段(保留其余所有 key)。
- **优点**:确定性,不依赖 claude 任何未文档化行为;token+身份成对存/成对切。
- **代价**:需要每个账号的 oauthAccount 被 capture 过一次。当前 `~/.claude.json` 只有 shopping 的身份,business/personal/school 需各自「login → capture」一次采集(清单见 §6,由 Lead 协调 Annie,不自己拉她)。
- **fallback**:profile 没有 `oauthAccount.json`(旧 capture 或未采集)→ **不静默留错身份也不 clear**:响亮 warn(token 已切、显示身份未更新,需 re-capture),`use` 仍 exit 0(token 切换是主功能,已成功)。非回归(= 现状),但 warn 让缺口可见。

### 路径 2 —— 清空 oauthAccount 逼 claude 重取(不推荐)

- `use` 时删/置空 `~/.claude.json` 的 `oauthAccount`,赌 claude 启动会用(已切好的)token 重拉身份。
- **否决理由**:
  1. bug 本身证明 claude **不** 从 token 重新 reconcile 身份(否则换 token 就自动换显示了)。ABSENT 情形是否重取属未文档化行为,且 quota-safe 无法验证(要真 token + 真 launch)。
  2. 清空 oauthAccount 有触发 claude 启动 **重新 login 提示** 的风险 → 撞 RED LINE「绝不写坏 login」。
- 结论:排除。

### 路径 3 —— 其他 claude-native 机制

无可靠的本地机制在不 login 的情况下从 token 取身份。排除。

## 5. 推荐

**路径 1**(capture 补存 + use 写回),原因:确定性、不碰 login red line、与现有「token 成对存池」模型一致。

`capture` 额外打印采集到的 `emailAddress` 供操作者肉眼核对(token opaque 无法程序化校验 token↔身份一致,靠「login 后立即 capture」的操作纪律 + 回显核对)。

## 6. 需要 Annie 一次性 re-capture 的账号(Lead 协调,勿自己拉 Annie)

当前 `~/.claude.json` 只含 shopping 身份。修好后要让**全部** 4 个 profile 的切换都显示对,需逐个「登进该账号 → 跑 capture」采集身份:

| profile | 现有 token | 现有身份快照 | 需要 |
|---------|-----------|-------------|------|
| shopping | ✓ | ✓(当前 active) | 修好后 `capture shopping` 一次即可(身份已在 `.claude.json`) |
| business | ✓ | ✗ | `claude login`(business)→ `capture business` |
| personal | ✓ | ✗ | `claude login`(personal)→ `capture personal` |
| school | ✓ | ✗ | `claude login`(school)→ `capture school` |

> 代码修完即可先只用 shopping+一个已采集账号做 quota-safe drill 验收(全用假 fixture);真机 4 账号采集是上线 696 enable 前的一次性运维步骤,由 Lead 协调。

## 7. 已知限制(文档化,沿用 FLY-696 模型)

`~/.claude.json` 是 claude 自己的可变文件。若切换时有 **live claude session** 在跑,它下次写 `.claude.json` 会用内存里的旧 oauthAccount 覆盖我们的写 → 显示身份被 clobber。这与 FLY-696「live session 不 hot-swap、等 reset」同源,属 claude-side 固有 raciness,MVP 不解(要彻底解需 claude 配合)。Annie 复现的症状(**新开** window /status 显示旧账号)在无并发 live-session-写 的窗口内被本修复解决。

## 8. 改动范围(最小)

- `packages/claude-runner/bin/flywheel-claude-profile`:`capture` 增采集身份 + `use` 增写回身份 + 新 env override(`FLYWHEEL_CLAUDE_JSON`,默认 `~/.claude.json`)。
- 测试:扩 `packages/claude-runner/test/claude-profile.test.ts`(unit,scratch `.claude.json` fixture)+ 视需要补 integration。
- **无 TS 逻辑改动**(executor 透明继承)。
