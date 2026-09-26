# FLY-2873 Codex 测试房附件读取 — 实施计划
Issue: FLY-2873 (https://linear.app/geoforge3d/issue/FLY-2873/病根529-房-codex-载体-lead-在测试房读不了附件默认-direct-出站没有读取身份transport-unavailable)
日期: 2026-09-24
基于: research.md

## 锁定目标

只修 529 test-deploy 的 Codex slot 出站选择、Bridge 环境投影与 carrier 状态隔离，让 full-access 测试 Lead 对齐 529 使用的 mufasa full-access / 通用生产入口默认走 bridge，并在启动 carrier 前拥有附件读取所需的 endpoint、API token、slot-local evidence/assertion/receipt 路径与 runtime 自生 carrier generation。生产 launcher、附件 route、carrier 校验和 bot 权限不改；companion 默认 direct 是兼容既有 QA，不声称它代表所有生产入口。

## 已确认测试 seam

1. `scripts/lib/qa-lead-artifacts.sh` 的纯 shell helper：profile + 显式 override → effective outbound；bridge transport → 精确变量投影或缺变量 fail loud。
2. `scripts/__tests__/test-deploy-fly1389.test.sh` 的 CX 真启动链：`test-deploy → slot env file → launchd wrapper → Codex runtime`。该 seam 已通过一次性 harness 在当前头复现 `missing canonical env FLYWHEEL_BRIDGE_URL`。
3. `scripts/lib/qa-slot-env-contract.json` 的 declarative redirect seam：Bridge 必须把 carrier evidence/assertion/receipt 投到 `${SLOT_DIR}/state`，Lead launch env 必须拿到同一组坐标。
4. `packages/teamlead` 现有附件 scope/router/MCP 测试：证明给定稳定 validator 结果时读取链不需要 route 改动，并保留 carrier drift 阴性保护；它们不替代真实文件隔离测试。

## TDD 切片

### 切片 1：profile-aware 出站与 fail-loud helper

先改测试：

- 扩展 `scripts/__tests__/qa-codex-lead-layers.test.sh`：
  - full-access 无 override → `bridge`；
  - companion 无 override → `direct`；
  - 显式 `direct|bridge` 覆盖默认；
  - 非法 mode 拒绝；
  - bridge 缺 URL 或 token 时非零退出，错误只含变量名；
  - bridge 成功只输出 `FLYWHEEL_CODEX_LEAD_OUTBOUND`、`FLYWHEEL_BRIDGE_URL`、`FLYWHEEL_API_TOKEN` 三个 assignment；direct 只输出 mode。
  - `qa-slot-env-contract.json` 精确把 `FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE`、`FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR`、`FLYWHEEL_LEAD_RECEIPT_DIR` redirect 到 slot-local 路径，且均受 `mustBeUnderRoot` 启动约束。

确认红后，在 `scripts/lib/qa-lead-artifacts.sh` 增加两个纯 helper：effective mode 解析与 transport assignment 渲染。不得记录 secret 值。

### 切片 2：真实 test-deploy 投影

先改 `scripts/__tests__/test-deploy-fly1389.test.sh`：

- 把主 Codex fixture 改为生产 slot 2 同形的 `full-access`，移除 CX 的显式 bridge override，要求默认到 bridge；保留额外 companion fixture 作为 direct 对照。
- fake runtime 在 bridge 模式把 `FLYWHEEL_BRIDGE_URL` 与 `FLYWHEEL_API_TOKEN` 列为必需项；token 证据只写 `[present]`。
- fake runtime 同时要求 `FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE`、`FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR`、`FLYWHEEL_LEAD_RECEIPT_DIR`，并把非 secret 坐标写入证据。
- CX 断言：runtime 看到 slot-local URL、token present、full-access profile 与 bridge mode；Bridge 与 runtime 看到完全相同的三条 slot-local carrier 路径，且没有一条位于 `$HOME/.flywheel`；Bridge auth 已启用。
- CXX 断言：同一 campaign 内 full-access main=bridge、companion extra=direct，互不串 mode/secret；显式 `TEST_CODEX_LEAD_OUTBOUND_MODE=direct` 时 full-access 回退 direct 且不要求 bridge token。

确认当前头在 `FLYWHEEL_BRIDGE_URL` 缺失处红后，最小修改 `scripts/test-deploy.sh`：

1. 顶层 knob 允许空值作为“按 profile 默认”，只拒绝非空非法值。
2. 把 per-slot API token 生成收敛为一个幂等 helper；reply-by-issue/generalized 保持原调用语义；任何 effective bridge Codex Lead 在启动前也调用它。
3. 启动 Lead 前扫描本 campaign 的 Codex profiles，计算是否需要 Bridge auth；只在需要时生成 slot-local token。Claude-only、companion/direct 默认房和显式 full-access/direct 房保持无 token 路径。
4. `qa_slot_start_lead` 在创建 Codex home/注册 launchd 前调用纯 helper：
   - full-access 默认 bridge、companion 默认 direct；
   - bridge 写入 `FLYWHEEL_BRIDGE_URL=http://localhost:<slot-port>` 与 `FLYWHEEL_API_TOKEN=<slot token>`，同时保留 MCP 已消费的 `BRIDGE_URL`/`TEAMLEAD_API_TOKEN`；
   - 任一 bridge 关键坐标为空立即返回非零，错误点名缺失变量但不打印值。
5. `scripts/lib/qa-slot-env-contract.json` 增加三条 redirect；Bridge 从 contract render 获取它们，Lead base assignments 使用相同 `${SLOT_DIR}/state/...` 字节，目录在启动前以 0700 创建。
6. Bridge 启动分支按“token 是否存在”启用 auth；reply-by-issue 的三个 feature flags 仍只受 `TEST_REPLY_BY_ISSUE=1` 控制，避免把附件 auth 与回复功能绑定。只有 campaign 中确有 effective bridge Codex Lead 才让普通房进入 token 分支。

### 切片 3：回归与清理

- 重新运行两个 shell 测试，确认红→绿。
- 重新运行四个附件相关 Vitest，确认 route 与 carrier negative guards 仍绿。
- 从 CX 生成的 Bridge/runtime 证据各读取两次 carrier 坐标，并确认 contract/render/launch env 完全相同；不读取 secret 值。
- 搜索并删除所有临时 `[DEBUG-*]` 或一次性 harness；不做无关重构。

## 相关验证

本地只运行以下范围：

```text
bash scripts/__tests__/qa-codex-lead-layers.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/inbound-attachment-scope.test.ts \
  src/bridge/__tests__/lead-inbound-attachment.test.ts \
  src/lead-backends/codex/lead-actions/__tests__/lead-actions-integration.test.ts \
  src/lead-backends/codex/__tests__/codex-lead-tui-runtime.test.ts
pnpm lint
pnpm --filter "flywheel-teamlead..." --filter "flywheel-claude-runner..." build
```

改变 shell/TypeScript 后，再按节点协议运行：

- 所有新增或改变的 `scripts/__tests__/*.test.sh`；
- changed TypeScript 的 owning package `vitest related <changed-ts-files> --run`（若最终没有 TypeScript diff，记录不适用）；
- 用每个 changed file 的完整路径、文件名、父目录分别执行 `git grep -lF`，保留所有匹配或逐项记录排除理由；
- `git diff --check` 与 secret-value 扫描。

不跑本地全 package suite，不请求 ordinary-head full CI。当前 implement handoff 没有冻结头，因此不运行 `ci-full ensure`。

## 生产不变证据

- diff 中不得出现 `packages/teamlead/scripts/run-codex-lead-*.sh`、`packages/teamlead/src/bridge/lead-inbound-attachment.ts`、`packages/flywheel-comm/src/lead-lease.ts`。
- 生产相关 launcher blob SHA 在改动前后相同；PR body 披露该证据。
- companion/direct 与显式 full-access/direct 对照保持 direct 且无 bridge token，证明不是全局强切 bridge。
- 生产运行时文件没有 diff；新增的 slot contract 坐标阻止 test Bridge 再覆盖生产 carrier evidence。

## 已知影响与残余边界

- full-access 测试房的默认 outbound 从 direct 改为 bridge，`CodexOutboundSender` 与 `lead_actions.discord_send` 都随之切换；依赖旧 direct 行为的 FLY-2655、FLY-2799、FLY-2808 等配方可显式设置 `TEST_CODEX_LEAD_OUTBOUND_MODE=direct` 回退。回归必须锁住这个开关。
- Lead 先于 Bridge 启动，启动时 outbound preflight 预期先 unavailable、约 30 秒后 fail-open；Bridge 起稳后第一条真实回复必须在 QA 证据中出现 `lead-outbound ... status=sent` 和 authorized probe，不能把 startup fail-open 当成功证据。
- API token 会挂载其他 capability 路由。carrier 三类文件和 `teamlead.db` 本单隔离；plugin 中仍硬编码 HOME 的 outbound dedup / standing-authority 根不在本单改动面，作为残余测试状态污染风险在 PR 披露并另单跟踪。附件 read 不写这两处。

## 现场 QA 交接

implement 节点不自行开/拆 529 房。PR 完成后由 DAG QA 在 Lead 授权下：

1. 以 slot 2/full-access Codex Lead 启动房间，不改 bot1 频道权限；
2. 至少间隔一个 FleetPoller 周期两次采样 slot-local evidence 文件，确认 `test-slot-2-<lead>` key 持续存在，且生产 evidence 文件没有 slot-2 key；
3. 先让 Lead 发一条真实回复，保存 `bridge.log` 的 `lead-outbound ... status=sent` 与 authorized probe 记录；
4. 在房内投递一张截图和一个文本附件；
5. 由 Lead 自己调用 `discord_read_attachment`，记录 native image 与文本内容；
6. 阴性对照显式设置 direct，只接受 `transport_unavailable`；`carrier_expired` 属于正向隔离失败，不能算合格阴性对照；
7. 通知 FLY-2757 QA 补测 founder 选择 B 的读取一跳。

## 提交与交付

1. 代码/测试与过程文档形成小提交，并在每个批次更新 progress ledger。
2. 跑有效 code review gate；blocking finding 修复后以新头重新 review。
3. push feature branch，创建 PR；PR body 清楚区分本地测试、scope CI、未做的 529 真机硬红。
4. 最后一个 commit 只能新增/更新 `engineering/doc/milestones/FLY-2873.md`；随后不再改头。
5. 完成 `complete --route needs_review --pr <number>`，不派 QA、不 merge、不 ship。
