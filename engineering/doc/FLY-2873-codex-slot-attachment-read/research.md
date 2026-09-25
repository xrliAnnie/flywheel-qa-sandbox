# FLY-2873 Codex 测试房附件读取 — 调研
Issue: FLY-2873 (https://linear.app/geoforge3d/issue/FLY-2873/病根529-房-codex-载体-lead-在测试房读不了附件默认-direct-出站没有读取身份transport-unavailable)
日期: 2026-09-24
基于: exploration.md

## 结论

(a) 与 (c) 不是“direct 模式缺同一份 carrier 身份”这一个根因；设计评审后对 (c) 的根因完成了二次取证和修正。

- **(a) 是部署模式不对齐**：529 的 slot 2 当前是 `codexProfile=full-access`；`run-codex-lead-mufasa-tui-fullaccess.sh` 与通用 `flywheel-lead.sh` 默认 `bridge`，而 `scripts/test-deploy.sh` 无条件默认 `direct`。`tryResolveLeadAttachmentContext` 对 direct 明确返回 `undefined`，`discord_read_attachment` 因此按设计返回 `transport_unavailable`。另一个生产入口 `run-codex-infra-bot-tui.sh` 默认 direct，所以测试房的 profile 映射是对齐 529 所用的 full-access Lead 入口，不是声称所有生产 Codex 入口都相同。
- **(b) 是测试房别名投影缺口**：test-deploy 给 Lead 的 base env 只有 `BRIDGE_URL` 与 `TEAMLEAD_API_TOKEN`；Codex runtime 在 bridge 模式启动前要求 `FLYWHEEL_BRIDGE_URL` 与 `FLYWHEEL_API_TOKEN`。现有 CX 测试的 fake runtime 没把这两个变量列为必需项，所以假绿。
- **(c) 是测试房 carrier 状态没有隔离**：TUI runtime 每个存活实例会把 assertion 写到 `FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR ?? ~/.flywheel/state/carrier-assertions`；每个 Bridge 的 FleetPoller 又会把本 Bridge 看见的 Lead 集合整份覆写到 `FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE ?? ~/.flywheel/lead-carrier-evidence.json`。529 环境 contract 没登记这两项，slot Bridge 与生产/其他 slot Bridge 因而争用同一个 HOME 文件。附件 scope 在捕获和 fetch 期间多次复核，slot-2 key 被其他 Bridge 的整份快照抹掉后，正确的 fail-closed 结果就是 `scope_denied`/`carrier_expired`。

换言之，修复点是 test-deploy 的 profile-aware 出站选择、Bridge auth/endpoint 投影、carrier evidence/assertion/receipt 的 slot-local 隔离与部署前检查；不改生产 launcher、不改附件 route，也不放松 carrier fence。

## 反馈环证据

### 现有测试为何没抓到

构建相关包后运行：

```text
bash scripts/__tests__/test-deploy-fly1389.test.sh
Results: 24 passed, 0 failed
```

CX 场景虽然以 `TEST_CODEX_LEAD_OUTBOUND_MODE=bridge` 启动真 wrapper，但 fake Codex runtime 的 `required` 列表只检查了 mode，没有检查 bridge endpoint/token。

### 可红的真实 launch seam

在一次性 `/tmp` 派生 harness 中只给同一个 fake runtime 增加 bridge 模式必需变量断言，保留 `test-deploy → launchd wrapper → Codex runtime` 全链。当前头稳定失败：

```text
Error: missing canonical env FLYWHEEL_BRIDGE_URL
Results: 22 passed, 1 failed
```

失败发生在 Codex Lead topology convergence 前，和 FLY-2757 的 bridge-mode fatal 同一症状。仓库未保留该临时 harness；批准计划后会把等价断言落进正式 CX 回归。

### carrier/route 二次取证

评审后只读采样 `~/.flywheel/lead-carrier-evidence.json` 四次，18 秒内看到了生产 key → 空集合 → `test-slot-1-flywheel-test-1` 的整份快照轮换；同一 HOME 的 assertion 目录同时存在 `test-slot-{1..4}-*.json`。这直接证明不同 Bridge 正在共写默认 evidence 文件，和 FLY-2757 “初验通过、复核 `carrier_expired`”的时序吻合。

此前运行的四个相关文件为：

```text
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/inbound-attachment-scope.test.ts \
  src/bridge/__tests__/lead-inbound-attachment.test.ts \
  src/lead-backends/codex/lead-actions/__tests__/lead-actions-integration.test.ts \
  src/lead-backends/codex/__tests__/codex-lead-tui-runtime.test.ts
```

结果为 `4 files / 69 tests passed`。它们覆盖稳定 carrier 的多次 `assertCurrent`、carrier drift 拒绝、真实 MCP child 读取 TXT/native image，以及 TUI runtime bridge 配置；但 `inbound-attachment-scope.test.ts` mock 了 carrier validator，因此不能证明真实 evidence 文件是单写者。结论是保留这些阴性保护，同时把真实文件坐标纳入 CX 部署回归。

## 配置链对照

| 环节 | 529 对齐入口 | 当前 test-deploy | 必需修复 |
|---|---|---|---|
| 默认出站 | mufasa full-access / 通用 launcher 为 `bridge` | 无条件 `direct` | full-access 默认 bridge；companion 为兼容既有 QA 保持 direct；显式测试旋钮仍可覆盖 |
| runtime endpoint | `FLYWHEEL_BRIDGE_URL` | 仅 `BRIDGE_URL` | 给 Codex runtime 投影 `FLYWHEEL_BRIDGE_URL=http://localhost:<slot-port>` |
| runtime token | `FLYWHEEL_API_TOKEN`（可由 `TEAMLEAD_API_TOKEN` 别名得到） | 仅 `TEAMLEAD_API_TOKEN`，且普通房可能为空 | 为 bridge Codex slot 建立 slot-local token，并同时给 Bridge 与 Lead；给 runtime 投影 `FLYWHEEL_API_TOKEN` |
| MCP endpoint/token | `BRIDGE_URL` / `TEAMLEAD_API_TOKEN` 按变量名转发 | base env 已有，但 token 可能为空 | 保留别名并在部署前非空校验 |
| carrier assertion | runtime 写私有 assertion | 默认写共享 `~/.flywheel/state/carrier-assertions` | `FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR=${SLOT_DIR}/state/carrier-assertions` 同时给 Bridge 与 Lead |
| carrier evidence | Bridge FleetPoller 整份发布 | 默认写共享 `~/.flywheel/lead-carrier-evidence.json` | `FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE=${SLOT_DIR}/state/lead-carrier-evidence.json` 同时给 Bridge 与 Lead |
| readiness receipt | carrier self-check receipt | 默认落 HOME | `FLYWHEEL_LEAD_RECEIPT_DIR=${SLOT_DIR}/state/carrier-receipts` 同时给 Bridge 与 Lead |
| carrier claim | runtime 生成，按 `FLYWHEEL_LEAD_CARRIER_INSTANCE_ID` 名称下发 | runtime 已有同一机制 | 不改 raw claim 语义 |

## 最小修改面

1. `scripts/lib/qa-slot-env-contract.json`：登记 evidence、assertion、receipt 三个 slot-local redirect，使 Bridge 环境拒绝继承 HOME 默认坐标。
2. `scripts/test-deploy.sh`：解析 profile-aware effective outbound；bridge 模式确保 slot-local API token、给 Bridge 开 auth、给 Codex runtime 同时投影新旧变量名；把同一组三个 carrier 路径传给 Lead，并在创建 carrier artifact 前检查非空。
3. `scripts/lib/qa-lead-artifacts.sh`：将 mode/default 与 bridge env 组装抽成纯 helper，便于缺变量阴性测试；不承载 secret 值到日志。
4. `scripts/__tests__/test-deploy-fly1389.test.sh`：CX 改成 full-access 529 同形，默认启动 bridge，fake runtime 必须检查新变量与三条 carrier 路径；断言 token 只显示 `[present]`，不落原值。
5. `scripts/__tests__/qa-codex-lead-layers.test.sh`：覆盖 profile/default/override、显式缺 endpoint/token，以及 contract 的三条 redirect。

## token 门控后的状态写点

给普通 full-access slot Bridge 配置 API token 会额外挂载 Lead capability 路由。carrier evidence/assertion/receipt 在本单内全部隔离；`teamlead.db` 已是 slot-local。现有 Bridge 仍把 `codex-lead-outbound-dedup.db` 和 standing-authority 文件根绑定到 `homedir()`，没有可用的 test-deploy env override。它们只有实际调用相应写路由时才产生写入，本单不改生产 plugin 来扩散范围；该残余隔离风险会在 PR/QA 交接中明确披露，并另开跟踪项。附件读取本身不写这两个位置。

## 启动时序

test-deploy 先等 Lead ready、再启动 Bridge。bridge-mode runtime 的 outbound preflight 因此会先经历约 30 秒 unavailable 后 fail-open，Bridge 启动后仍保持 bridge mode。本地 fake runtime 不模拟该 preflight；QA 必须用第一条真实回复的 `bridge.log` `lead-outbound ... status=sent` 与 authorized probe 记录证明出站最终可用，再验附件读取。

## 不做

- 不修改 `packages/teamlead/src/bridge/lead-inbound-attachment.ts` 或 carrier 校验语义。
- 不把 raw carrier claim 或 API token 写入证据 JSON、TOML、argv、日志或错误。
- 不触碰生产 launcher 字节，不改变 bot1 权限，不由 implement 节点开/拆 529 房。
- 不把本地模块回归冒充 QA 的 529 真机硬红；真实截图 + 文本读取由 QA 节点完成。
