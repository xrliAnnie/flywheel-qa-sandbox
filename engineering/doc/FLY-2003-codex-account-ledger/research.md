# FLY-2003 Codex 三号台账与单号收敛 — 调研
Issue: FLY-2003 (https://linear.app/geoforge3d/issue/FLY-2003/账号台账-codex-接号器整理三号对齐身份自动记账杜绝错账)
日期: 2026-08-24
基于: exploration.md

## 1. 最终范围裁定

Linear 最新 Founder comment 把最初的“三号自动池”改成：日常默认 Personal，School/Business 是人工 backup，不再自动轮换。Lead 对设计问题 `b64883bc-5aac-450f-bb01-1515b2393876` 明确：Claude 的 `com.flywheel.quota-monitor` 与自动切号不动，本单只做 Codex fallback 非轮换、身份/状态工具、三号台账。

设计审 R1 又暴露 quota warning 只有 runner 存活时才有数据的问题。Lead 对 `dddaedac-13d5-4646-a60f-2c95122d8d13` 最终裁定 C：quota warning 整个移出本单。机器级 warning 是新的告警层，触碰 Founder 因 watchdog 洪水设下的「禁新增告警层」红线；runner-only 半覆盖也禁止，因为比明确没有更误导。warning 需求只在 Linear 留档，后续另立 Founder-gated issue。

因此 FLY-2003 的实现验收只有三项：

1. Codex fallback 不自动切号；
2. status 由真实 auth identity 得出，sidecar 只作 hint；
3. registry/ledger 只承认 School、Personal、Business，并自动记录身份观测与人工切换。

## 2. 当前机器只读审计

审计仅解码非秘密 JWT claim，没有打印 token，也没有修改生产文件。

| 位置/标签 | auth.json 真实 email | account id | plan | 结论 |
|---|---|---|---|---|
| `~/.codex` | `xrliannie@gmail.com` | `1c06…fd5d` | pro | 当前真实 Personal |
| pool `personal` | `xrliannie@gmail.com` | `1c06…fd5d` | pro | 规范 primary |
| pool `school` | `xiaorongli2011@u.northwestern.edu` | `f5d5…e61f` | pro | 规范 manual backup；目前 quota wall |
| pool `business` | `xrliannie.b@gmail.com` | `4c0a…e67b` | prolite | 规范 manual backup；已知 `refresh_token_reused` |
| pool `personal1` | `xrliannie.1@gmail.com` | `559d…ca3f` | plus | zombie，不应再被发现 |
| pool `personal2` | `xrliannie.1@gmail.com` | `559d…ca3f` | plus | 与 personal1 同一真实身份，zombie |

另有 `~/.codex-infra-bot` 实际为 Personal、`~/.codex-mufasa` 实际为 School，说明 home 名称同样不能作为身份事实。生产迁移不能在开发阶段热改这些运行中 home；本 PR 提供新 birth 校验和显式人工工具，部署/空闲窗口再执行迁移。

## 3. 根因链路

### 3.1 status 读错事实源

`packages/claude-runner/bin/flywheel-codex-profile` 的 `show_status()` 只读 `$CODEX_HOME/.active`。直接 `codex login` 只改 `auth.json`，不会同步 sidecar，因此 status 可以稳定地报错账号。当前全局 `~/.local/bin/codex-profile` 也以 sidecar 为事实。

Codex `auth.json` 已包含可离线读取的 `tokens.id_token`：JWT payload 提供 email、OpenAI account id 和 plan claim。读取不联网、不刷新 token、不消费额度；它必须成为 status、use/save 校验和 runner birth 的权威输入。

### 3.2 自动 pool 无健康/身份门

runner shim `flywheel-codex-with-fallback` 根据目录数量设置重试次数，遇到 `refresh_token_reused`、429、model unsupported 后调用 `flywheel-codex-profile next`。`next` 动态枚举任意目录，因此 `personal1`、`personal2` 和坏掉的 `business` 都自动有资格；复制前也不验证目录 label 与 JWT identity 是否一致。

全局 `scripts/codex-with-fallback.sh` 同样按 `~/.codex/profiles/*` 轮换。per-home 隔离解决了并发文件覆盖，但没有解决“每个 home 都自动切到错误号”。两个 fallback 都必须删除账号轮换；model fallback 可留在同一账号，auth/quota 错误则原样返回并给出人工命令。

### 3.3 runner birth 需要 canonical 门，但不能锁死 backup

`provisionCodexHome()` 直接复制 `sourceCodexDir()/auth.json`。正常情况下 source 应为 Personal；Founder 人工执行 global `use school|business` 后，新 runner 继承 backup 是人工开关的预期结果。若强制 Personal，恰好在 backup 最需要的时候会让所有新 runner birth 失败。

正确规则是：在创建 execution home、写 worktree git credential 或 GH token 之前验证 actual identity 属于三号 registry。Personal 正常通过；School/Business 以 `manual_backup_active` 诊断通过；unknown、zombie、malformed、missing 才 fail closed。`provisionCodexHome()` 内再验证一次作为 defense-in-depth。

### 3.4 global/private CLI 不能共享 ambient home 语义

当前 repo tool 的 CODEX_HOME-awareness 在 runner-private 场景是隔离能力。若 installer 直接把同一 executable 暴露成 `~/.local/bin/codex-profile`，Founder 从 Mufasa 或 infra-bot pane 运行 `use personal` 时，ambient `CODEX_HOME` 会把 live Lead home 改掉，而不是 global `~/.codex`。

需要共享实现、分离 launcher：

- core CLI 本身必须要求显式绝对 `--home`，不读取 ambient `CODEX_HOME`；
- runner-private launcher 显式传 `${CODEX_HOME:-$HOME/.codex}`；
- global managed shim 无条件传 `$HOME/.codex`，即使环境里有其他 CODEX_HOME；
- `--home` 只由 managed launcher 使用，不作为容易误触的日常文案。

## 4. 单一身份事实实现

三号 registry 是 package-shipped、无秘密 JSON：

| label | email | role |
|---|---|---|
| `school` | `xiaorongli2011@u.northwestern.edu` | manual_backup |
| `personal` | `xrliannie@gmail.com` | primary |
| `business` | `xrliannie.b@gmail.com` | manual_backup |

account id 与 plan 是观测值，不硬编码。`personal1`、`personal2` 不在 registry，动态目录发现不能让它们重新获得资格。

身份/JWT/registry 逻辑放在 `packages/claude-runner/bin/codex-account-core.mjs`，使 Biome 与 FLY-1455 drift scan 能覆盖；旁边的 `.d.mts` 提供 TypeScript 类型边界。TypeScript runtime 与 profile CLI import 同一个 core，不复制解析逻辑。package 的 `files: [dist, bin, agents]` 已能发布三者；global installer 也必须把 core、CLI、registry 一起 vendor并纳入 hash。

解析规则：

- 只读 regular file，拒绝 symlink；
- JSON/JWT segment/base64url/payload 每层都验证；
- email 必须精确匹配 registry，未知 identity 不猜；
- account id / plan 从已知 OpenAI claim 读取，缺失可显示 unavailable，但不能影响 email→label 的确定性；
- public result 字段白名单，不带 id/access/refresh token；
- human status 默认 redacted email，`--json` 可给机器完整 identity，但仍无 token。

## 5. 三号台账存储

registry 解决“应该有哪些号”，还需要 ledger 回答“哪一个 home 实际用了谁、何时被观察/切换”。采用 `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/codex-account-ledger/`：`FLYWHEEL_STATE_DIR` 已在 config truth 中登记，529/QA slot 自然隔离，不新增 env seam。

结构按 canonical label 分片，避免多 runner 共享 read-modify-write：

```json
{
  "version": 1,
  "profile": "personal",
  "email": "xrliannie@gmail.com",
  "accountId": "…",
  "plan": "pro",
  "lastObservedAt": "2026-08-24T…Z",
  "lastSource": "status|use|save|provision",
  "lastHomeFingerprint": "sha256-of-normalized-absolute-home",
  "mode": "primary|manual_backup"
}
```

不保存原始 home path（避免把 execution id/用户名扩散进报告），只保存不可逆 fingerprint；不保存 token。写入用同目录唯一 temp、0600、`fsync`、rename。status/use/save/provision 成功后调用；unknown/mismatch 只返回诊断，不污染 canonical entry。list 实时扫描 pool 并合并 ledger 的 last observation。

本单不做无限事件日志：每号只保留 last-known snapshot，满足“自动记账”且不引入 retention/DB 大活。直接 `codex login` 后第一次 `status` 会从 live auth 自动纠正 ledger；sidecar 不需要先同步。

## 6. profile CLI 行为

- `status`：actual identity 是第一事实；sidecar 另行标 hint/drift；默认 email redacted；支持无 token JSON；成功时记录 observation。
- `list`：固定列 registry 三号，逐个验证 pool auth，显示 missing/mismatch/healthy；额外列 untracked dirs，但绝不赋予 use/fallback 资格。
- `use <label>`：只接受三号；源目录拒绝 symlink，源 JWT 必须与 label 一致；原子替换目标、0600、再验证后才写 sidecar/ledger。
- `save <label>`：Founder 重新 login 后回存；只有当前 actual identity 与 label 一致才原子保存，避免把 Personal 存进 Business。
- `next`：兼容命令名保留，但稳定非零并解释 automatic switching retired。

物理 `personal1`、`personal2` 不在本 PR 中不可恢复删除。它们立即失去 list/use/fallback 资格，并被 list 标 untracked；部署窗口可移动到 quarantine。

## 7. 安装与兼容

`scripts/install-codex-guard.sh` 当前 stable release 只有 wrapper+guard。新 release 包含 wrapper、guard、profile CLI、shared core/type boundary、registry；content hash 覆盖全部。global profile shim 固定传 `$HOME/.codex`，首次替换保留独立 `.bak`，重复安装不覆盖 backup。

retention 要同时识别 legacy 2-file release 与新 managed shape，未知内容仍 fail-safe 不删。disable sentinel 只禁 one-shot timeout guard；已安装的 truthful profile shim不被回退为旧 sidecar 工具。

删除 fallback caller 后，`flywheel-comm account-rotation-notify`、Bridge `account_rotation` route 暂时保留为兼容/人工 incident event surface；本单不额外发起跨 package dead-code migration，但代码和文档明确它不再有 automatic fallback caller。

安装器不自动复制 live auth、不删除 profile 目录、不重启服务。生产账号迁移与 Business Founder re-login 仍是显式部署/人工步骤。

## 8. 测试重点

1. sidecar=School、auth=Personal 时 status 报 Personal + DRIFT；
2. global shim 在 ambient CODEX_HOME 指向 Lead home 时仍只改 `$HOME/.codex`；
3. runner-private launcher 只改显式 execution home；
4. `use/save` 的 label↔JWT 不匹配时拒绝且目标字节不变；
5. `next` 永不复制；untracked personal1/2 不进入 canonical pool；
6. provisioning 接受三个 canonical，non-primary 明示 manual backup；unknown/zombie/malformed 在所有 credential write 前拒绝；
7. status/use/save/provision 写无 token、slot-scoped、原子 0600 ledger snapshot；
8. daemon/global fallback 的 auth/429 错误原样退出，不调用 profile/rotation notify；
9. installer 安装全套 shared implementation、global pinned-home shim、backup、两种 release retention，并保持幂等。
