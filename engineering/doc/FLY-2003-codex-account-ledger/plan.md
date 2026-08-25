# FLY-2003 Codex 三号台账与单号收敛 — 实施计划
Issue: FLY-2003 (https://linear.app/geoforge3d/issue/FLY-2003/账号台账-codex-接号器整理三号对齐身份自动记账杜绝错账)
日期: 2026-08-24
基于: research.md

## 最终范围与验收

完成后，Flywheel 的 Codex 路径满足：

1. registry/ledger 只有 `school`、`personal`、`business`；Personal 是默认 primary，另两个是 Founder 手动 backup；zombie 目录没有资格。
2. `codex-profile status` 由 live `auth.json` JWT claim 得出真实身份，sidecar 只作 hint；输出不含 token。
3. `use` / `save` 在写前验证 label↔identity；global 与 runner-private launcher 都显式绑定正确 home，不被 ambient `CODEX_HOME` 误导。
4. 新 runner 在任何 home/worktree credential/GH token write 前验证 source 属于三号 registry：三个 canonical 都可用，non-primary 明示 manual backup；unknown/zombie/malformed fail closed、零 credential/home 残留。
5. status/use/save/provision 成功后自动写无 token、slot-scoped 的 per-profile last-known ledger snapshot。
6. `next`、runner daemon fallback、global one-shot fallback 的自动账号轮换全部退役；auth/quota 错误原样返回并给人工命令。
7. guard installer 原子收敛 truthful global profile tool，保留旧版 backup，兼容清理 legacy release。
8. 不新增任何 quota warning/monitor/Bridge event；该需求按 Lead 裁定移入 Founder-gated follow-up。
9. Claude quota daemon、Claude registry、Claude 自动切号字节与行为不变。

## Task 1：共享三号 registry 与真实身份解析（RED → GREEN）

**新增/修改文件**

- 新增 `packages/claude-runner/agents/codex-account-registry.json`
- 新增 `packages/claude-runner/bin/codex-account-core.mjs`
- 新增 `packages/claude-runner/bin/codex-account-core.d.mts`
- 新增 `packages/claude-runner/src/codex-account-identity.ts`（typed re-export）
- 新增 `packages/claude-runner/test/codex-account-identity.test.ts`
- 修改 `packages/claude-runner/src/index.ts`

**RED**

先写测试覆盖：

- registry 集合固定为 `school, personal, business`，唯一 primary 是 personal；
- 正常 JWT 提取 email、OpenAI account id、plan，映射 canonical label/mode；
- malformed JSON、缺 token、非 JWT、畸形 base64、未知 email 全部返回明确错误，不猜 label；
- `personal1/personal2` email 是 unknown，不因目录名获得资格；
- public identity 序列化不出现 `id_token/access_token/refresh_token`；human formatter 默认 redacted email；
- core 拒绝 symlink auth/registry 和非 regular file。

运行：

```bash
pnpm --filter flywheel-claude-runner test:run -- codex-account-identity.test.ts
```

**GREEN**

身份/JWT/registry 逻辑只在受 Biome/FLY-1455 扫描的 `.mjs` core 实现；`.d.mts` 提供 TypeScript 类型，`src` 只作 typed re-export。registry 通过 `import.meta.url` 从 package-shipped `agents/` 读取，确保 CLI/src/dist/vendored release 使用同一事实。

## Task 2：profile CLI 真实 status + 显式 home scope（RED → GREEN）

**新增/修改文件**

- 新增 `packages/claude-runner/bin/flywheel-codex-profile.mjs`
- 修改 `packages/claude-runner/bin/flywheel-codex-profile`（runner-private launcher）
- 修改 `packages/claude-runner/test/codex-shim.test.ts`
- 修改 `packages/claude-runner/test/runner-env-isolation.real-tmux.test.ts`

**RED**

fixture 使用三号真实结构 JWT，断言：

- sidecar=school、auth=personal 时 `status` 第一事实为 personal，并标 `DRIFT`；默认 email redacted，`--json` 无 token；
- `list` 固定显示三号，逐个显示 missing/healthy/mismatch，并把 `personal1/personal2` 标 untracked；
- `use business` 的源 JWT 实际为 Personal 时非零退出，目标 auth/sidecar 字节不变；
- 合法 `use school` 拒绝 symlink，原子替换、0600、再验证后更新 sidecar；
- `save business` 只有当前真实 Business 时才原子回存；
- `next` 稳定非零且不修改文件；
- core CLI 未传绝对 `--home` 时拒绝；它不读取 ambient `CODEX_HOME`；
- runner-private launcher 显式用 execution home，两个 home 的人工 `use` 互不写对方；
- 模拟 global launcher 时，即使 ambient `CODEX_HOME=/lead-home`，显式 `$HOME/.codex` 才被写，Lead home 字节不变。

**GREEN**

`.mjs` CLI 要求 caller 显式传绝对 home；pool 也归一化并拒绝 symlink。runner-private extensionless launcher传 `${CODEX_HOME:-$HOME/.codex}`。human status 默认 redacted email，sidecar 只作 drift hint。所有 credential 写入使用同目录唯一 temp、chmod 0600、`fsync`、rename，复制后重新解析验证，再更新 sidecar。

## Task 3：三号 identity ledger 自动记账（RED → GREEN）

**新增/修改文件**

- 新增 `packages/claude-runner/src/codex-account-ledger.ts`
- 新增 `packages/claude-runner/test/codex-account-ledger.test.ts`
- 修改 `packages/claude-runner/bin/flywheel-codex-profile.mjs`
- 修改 `packages/claude-runner/src/index.ts`

**RED**

测试覆盖：

- root 默认 `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/codex-account-ledger`，复用已登记 plumbing seam；显式测试 dependency 可 override；
- production state 与 529/QA state 写入完全隔离；
- status/use/save/provision 的成功 observation 分别记录 `lastSource`；
- 每个 canonical profile 是独立 snapshot；字段只有 version/profile/email/accountId/plan/lastObservedAt/lastSource/lastHomeFingerprint/mode；
- home 只保存 normalized absolute path 的 sha256 fingerprint，不保存明文 path/execution id；
- snapshot temp+fsync+rename，最终 mode 0600；并发 last-writer-wins 也只能看到完整 JSON；
- unknown/mismatch/malformed 不创建或覆盖 canonical ledger；
- snapshot 文本不包含任何 auth token/canary；
- `list --json` 合并 registry/pool live health 与 ledger last-known observation，但 ledger 不覆盖 live identity authority。

**GREEN**

实现 per-profile last-known snapshot，不做无限 append history/新 DB。CLI 的 status/use/save 成功后调用；Task 4 provisioning 成功后调用。失败只输出无秘密诊断。直接 `codex login` 后第一次 status 会以 live auth 自动修正 ledger，无需 sidecar 先同步。

## Task 4：canonical runner birth preflight（RED → GREEN）

**修改文件**

- 修改 `packages/claude-runner/src/codex-home.ts`
- 修改 `packages/claude-runner/src/CodexTmuxAdapter.ts`
- 修改 `packages/claude-runner/test/codex-home.test.ts`
- 修改 `packages/claude-runner/test/CodexTmuxAdapter.test.ts`

**RED**

新增测试：

- source Personal → 正常 provision，目标 `auth.json`/`.active` 是 personal，ledger source=provision；
- source School/Business → 作为 Founder 人工 backup 正常 provision，目标 `.active` 与 actual 一致，并 log `manual_backup_active`；
- source unknown/zombie/malformed/missing → 在 `provisionGitHubCredential()`、execution home 创建、GH token/config write 前抛错；
- 预先存在 execution home 时，拒绝也不覆盖原文件；
- `provisionCodexHome()` defense-in-depth 在被直接调用时仍拒绝非 canonical；
- `discoverAccountPool` 只返回 registry 中实际存在的三号，额外目录不进入结果。

**GREEN**

新增纯 `assertCodexSourceIdentity()`；Adapter 在 GitHub credential provisioning 前调用，home 内再次校验。三个 canonical 都允许，只有 Personal 是 normal mode，School/Business 记录 manual backup；unknown/zombie/malformed fail closed。更新 FLY-123 rotation 注释与 health 文案为 personal-default/manual-backup。

## Task 5：两个 fallback 退役自动轮换（RED → GREEN）

**修改文件**

- 修改 `packages/claude-runner/bin/flywheel-codex-with-fallback`
- 修改 `scripts/codex-with-fallback.sh`
- 修改 `scripts/__tests__/codex-guard.test.sh`
- 视语义修改 `packages/claude-runner/test/codex-daemon-runtime.test.ts` 与旧 TUI 注释

**RED**

先证明：

- daemon wrapper 直接 `exec codex "$@"`，退出码/stream/信号不经账号轮换；
- one-shot wrapper 保留总 timeout、attempt timeout、孤儿 sweep、stream capture；
- 429/auth expired 返回原失败，不调用 `codex-profile next/use` 或 `account-rotation-notify`；
- model unsupported 最多在同一个账号上去掉原 model 并尝试一次 `gpt-5.5`，不查询/写 profile；
- quota/auth 错误文案只建议 `codex-profile status` 与 Founder 人工 `codex-profile use <backup>`，不假装自动恢复；
- source 中无 automatic profile caller。

**GREEN**

daemon wrapper 收敛成 no-timeout passthrough。one-shot guard 保持 FLY-1887 process-group timeout/cleanup，只删除 profile count/账号轮换循环。`flywheel-comm account-rotation-notify` 与 Bridge `account_rotation` 暂留兼容/人工 incident surface，但没有 automatic fallback caller。

## Task 6：global profile 随 guard 原子部署（RED → GREEN）

**修改文件**

- 修改 `scripts/install-codex-guard.sh`
- 修改 `scripts/__tests__/codex-guard.test.sh`

**RED**

installer harness 断言：

- release 包含 wrapper、guard、profile CLI `.mjs`、shared core `.mjs`/`.d.mts`、registry，content hash 覆盖全部；
- `~/.local/bin/codex-profile` 是 managed shim，固定执行 current profile CLI + `--home "$HOME/.codex"`，不透传 ambient `CODEX_HOME`；
- 从模拟 Mufasa pane 调 global tool 时，只改 global home；
- 首次替换旧 profile 保存独立 `.bak`，重复安装不覆盖 backup；
- staged profile 能执行 `status --json`；文件 mode 与 symlink cutover 约束成立；
- disable sentinel 只禁 one-shot guard，不删除/回退已安装 truthful profile；
- retention 能清理 legacy 2-file 与新完整 release，未知 shape fail-safe 跳过。

**GREEN**

扩展同一个 stable release/cutover，不新增 updater。global 与 runner-private launcher共享 core，但显式 home 不同。安装只发布工具，不自动改 live auth、不删除 `personal1/2`、不重启服务。

## Task 7：回归、全库验证、精确 head code review

targeted：

```bash
pnpm --filter flywheel-claude-runner test:run -- \
  codex-account-identity.test.ts \
  codex-account-ledger.test.ts \
  codex-shim.test.ts \
  codex-home.test.ts \
  CodexTmuxAdapter.test.ts
pnpm --filter flywheel-config test:run
bash scripts/__tests__/codex-guard.test.sh
```

强制全库 gate：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/codex-guard.test.sh
```

额外安全检查：

```bash
rg -n 'codex-profile (next|use)|account-rotation-notify' \
  packages/claude-runner/bin/flywheel-codex-with-fallback \
  scripts/codex-with-fallback.sh
rg -n 'quota.*warning|codex_quota_warning' \
  packages/claude-runner packages/teamlead scripts
git diff --check
```

第一个 `rg` 预期无命中；第二个只允许历史文档/既有非 FLY-2003 内容，不能有本单新 warning surface。

随后：

1. 更新 `progress.md`；
2. commit + push feature branch；
3. `stage set code_review`；
4. 按 codex-author 协议创建新 `review_code` gate + `request-review`，轮询到 APPROVED；CHANGES 则 TDD 修复、推新 head、重新开 gate；
5. 检查 inbox 并消费 Lead instruction；
6. 创建 PR（base `main`），不 merge、不请求 ship approval、不部署/重启；
7. docs/progress 最终更新作为 PR 最后一个 commit；
8. `complete --route needs_review --pr <NUMBER>`，最后将 resident goal标 complete。

## 回滚与部署说明

- runner daemon wrapper、global guard/profile 都由 repo/installer 管理；回滚 PR 后 updater 可在下一部署窗恢复旧 release。
- installer 保留首次覆盖前的 wrapper/profile `.bak`，但正常 rollback 不应重新启用自动轮换。
- 本 implement node 不运行 installer 到真实 `$HOME`、不移动真实 profile 目录、不执行 `request-restart.sh`、不运行 `restart-services.sh`。
- merge 后部署仍由 00:00/12:00 updater 班车负责。production 三号 physical quarantine 与 Business Founder re-login 是部署/人工步骤。
- 部署清单必须同步更新仓库外的 `~/.claude/rules/codex-multi-account.md` 与 `~/.claude/skills/codex-image/SKILL.md`：只保留三号、删除 `personal1/personal2` 与自动 `next`/auto-rotation 叙述，并按 live JWT 校准 plan。此 implement node 只登记该人工部署步骤，不直接改生产 `$HOME`。
- quota warning follow-up 必须先取得 Founder 对新告警层的明确授权；不能从本 PR 的 ledger 旁路自动上线。
