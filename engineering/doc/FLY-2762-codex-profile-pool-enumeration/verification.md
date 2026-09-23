# FLY-2762 动态 Codex 号池 — 验证记录
Issue: FLY-2762 (https://linear.app/geoforge3d/issue/FLY-2762/codex-号池五号-flywheel-codex-profile-把号池写死为-schoolpersonalbusiness)
日期: 2026-09-22
基于: plan.md

## 消费者发现

对本单每个生产改动文件分别以完整路径、文件名、父目录执行了
`git grep -lF`。保留并执行了以下直接消费者：

- `claude-runner` 的 pool、identity、install、ledger、home、shim、tmux/daemon
  相关测试；
- `teamlead` 的 StateStore、capacity route/snapshot、account quota view、quota
  observer/probe/runtime/coordinator/recovery/outbox/notification 相关测试；
- `codex-quota-client`、`codex-guard`、home link/reconcile/launch fence、
  `flywheel-lead`、`package-onboard-smoke` shell 套件；
- FLY-2688 的账号页渲染夹具。该夹具在本轮预检中暴露出新增必填
  `tokenState` 后的运行时崩溃，已补齐状态输入。

排除的命中逐类如下；这些命中不执行测试代码，或不消费本单运行时 API：

- 历史 `engineering/doc/**`、`product/doc/**` 中的路径/文件名引用；
- `kill-path-inventory.json`、`child-process-census.json` 等静态清单，只记录文件存在或
  终止边界；
- `dist/**` 生成物，改由受影响包 build 重新生成；
- 父目录名 `packages/claude-runner/bin`、`packages/teamlead/src/bridge`、
  `packages/teamlead/src/codex-quota`、`scripts` 的宽泛文档/库存命中；
- 不导入改动符号、只含相同通用文件名或目录文本的其他测试。

## 静态验收

- `loadCodexAccountRegistry|CodexAccountRegistry`：`packages scripts` 中 0 命中。
- `Codex 三号` 与 `expected school, personal, or business`：0 命中。
- 用户点名的 `[`school`,`personal`,`business`]` 非测试字面量：0 命中。
- 仅保留 `codex-quota-store.ts` 中有注释的
  `LEGACY_CODEX_QUOTA_POOL = ["business", "personal", "school"]`，只用于解释历史 v1
  capacity fact；不参与当前号池枚举。
- 设计列出的 13 个旧 v1 注册表夹具残留判据：0 命中。
- `git diff --check`：通过。

## 本地可执行证据

- `pnpm lint`：退出 0（仅既有 warning）。
- `flywheel-claude-runner`、`flywheel-teamlead` typecheck：通过。
- `flywheel-claude-runner...`、`flywheel-teamlead...` build：通过。
- `...flywheel-claude-runner` dependents typecheck：通过（runner、edge-worker、
  teamlead、voice-bridge、voice-codex）。
- Claude 定向 Vitest：7 files / 363 tests 通过。
- Teamlead 定向 Vitest：15 files / 206 tests 通过。
- Claude `vitest related`：10 files / 557 tests 通过。
- Teamlead `vitest related`：589 files / 8,279 passed、4 skipped；无失败、无
  `worker_rpc_timeout`。这是依赖扇出产生的 related 集合，不冒充 exact-head CI。
- 最终旧夹具迁移后复跑：Claude install/refresh 2 files / 24 tests，Teamlead runtime
  1 file / 24 tests，全部通过。
- `codex-quota-client.test.sh` 与 `node --test codex-quota-client.test.mjs`：各 17/17。
- `codex-guard.test.sh`：49/49。
- `codex-home-link-truth.test.sh`：16/16；reconcile 与 launch fence：通过。
- `flywheel-lead.test.sh`：75/75。
- `package-onboard-smoke.test.sh`：26/26。

## 代码复审阻断回归

首轮同步后代码审查指出两个阻断项，均按 TDD 收口：

- `pool_exhausted` 的旧实现把 quota 观测超过 60 秒也解释成“号池变化”，会绕过未来
  `next_attempt_at` 并每 tick 重探整池。先把 coordinator 用例推进 61 秒，稳定复现
  `observe` 被调用 2 次的失败；随后把绕过条件缩为“当前目录枚举中出现上次观测没有的
  `{profile, accountKey}`”，陈旧观测继续服从 backoff，新增号仍可立即触发一次重探。
- real-tmux 环境隔离测试仍读取已经迁移为 v2 的静态注册表夹具，复审环境稳定报
  `registry.profiles` 不可迭代。测试改为在自身临时 `profilesRoot` 写入 auth 后调用生产
  `loadCodexAccountPool`，不再依赖已删除的 v1 shape。

阻断修复后的当前工作树重新验证：

- `pnpm lint`：退出 0（仅既有 warning）。
- Claude 定向 Vitest：9 files / 370 tests；Teamlead 定向 Vitest：15 files / 206 tests。
- Claude `vitest related`（real-tmux 改动）：1 file / 1 test。
- Teamlead `vitest related`（store/coordinator 改动）：563 files / 7,876 passed、4 skipped；
  无失败、无 `worker_rpc_timeout`。
- 两个受影响包的 typecheck/build、Claude 下游 typecheck：全部通过。
- `git diff --check`：通过。

## 最新 main 同步复核

合入 `origin/main@83eb300f2` 后，`StateStore.ts` 与 `bridge/plugin.ts` 自动合并且无
冲突；复核确认 main 的 standing-authority 接线和本单的动态号池接线均保留。同步后
重新执行 Claude 8 files / 369 tests、Teamlead 15 files / 206 tests，以及两个受影响包的
typecheck/build 和 Claude 下游 typecheck，全部通过。该同步后 HEAD 需要独立代码审查；
同步前审查结果不作为新 HEAD 的批准。

## PR CI 与 Lead advisory 收口

首个 PR 自动 CI run `35819826577` 在 head `bf9f7915f` 的 Script Tests 6/6 job
`107049270001` 真实执行后失败；其中 FLY-1663 launchd-native lifecycle 为 49 passed / 5
failed。失败均来自测试构造的最小 Codex source home 没有 `profiles/`，而 runner birth
路径在读 source auth 前强制枚举动态号池。该结果是当前 HEAD 的代码/夹具兼容性问题，
不是 admission 或配额失败。

按 TDD 修复并覆盖两个边界：

- runner 的 `discoverAccountPool` 对不存在的 profiles 根目录返回空池；读取最小 source
  home 时复用既有 `identifyCodexAuth` fallback，从 auth 中稳定推导 `account-*` 身份。
  已存在但类型错误或不可读的 profiles 根目录仍由生产 loader fail closed。
- FLY-1663 的 production-birth 夹具创建动态 `profiles/business/auth.json`，因此需要命名
  profile 的断言来自本单定义的目录枚举，不恢复静态注册表。
- 按 Lead 对复审 advisory 的明确处置，quota projection 把 `authHealth=missing` 或
  `note=read_failed` 保持为 `authUnusable=true`；账号页继续显示“未探 / 本次读取失败”，
  不会把坏号渲染成可用。

红灯证据：生产改动前 Claude `codex-home.test.ts` 为 163 passed / 2 failed；Teamlead
capacity/view 为 39 passed / 1 failed。生产 fallback 完成但夹具尚未迁移时，完整 FLY-1663
脚本为 53 passed / 1 failed，唯一失败是仍期望 business、实际正确推导为 account-id。

绿灯复核：

- Claude 定向：1 file / 165 tests；Teamlead capacity/view：2 files / 40 tests。
- `bash scripts/__tests__/fly1663-qa-launchd.test.sh`：54 passed / 0 failed。
- Claude `vitest related src/codex-home.ts --run`：9 files / 548 tests。
- Teamlead `vitest related src/bridge/capacity-snapshot.ts --run`：131 files / 1,678 tests；
  无失败、无 `worker_rpc_timeout`。
- `pnpm lint`：退出 0（仅 25 个既有 warning）；5 个改动 TypeScript 文件的 Biome check
  通过。
- `flywheel-claude-runner...` 与 `flywheel-teamlead...` build、两个 owning package
  typecheck：全部通过。
- FLY-1663 脚本的新增消费者发现命中 CI workflow、kill-path inventory、foundation
  sibling fixture 与 CI source fixture；保留执行直接脚本和 related 测试，静态 inventory、
  文档及不消费改动路径的 sibling fixture 不重复执行。

这些修复形成新的实现 HEAD，必须重新取得 effective code review；旧 head
`6979f01cc` 的批准不覆盖本节改动。push 后由 PR 自动触发新 CI，不手工请求 full CI。

新实现 HEAD `01aa32364` 的自动 PR run `35821444423` 已完成：classifier、Quick Gate
（build + typecheck + lint）和 `CI Scope OK` 通过，其余 unit/script matrix 按 scoped 分类跳过。
这是 exact-head 的 scoped CI 证据，不是 full-suite `CI OK`。

代码复审 question `90ead08f-998a-43c9-b3e9-9ccd55ce62e2` / request
`064111b7-8587-41e5-87ea-f31975ebe80a` 在精确实现 HEAD `01aa32364` 返回
`reviewVerdict=APPROVED`。复审确认 Lead 指定的 missing/read_failed 页面回归完全关闭，前一轮
两个 HIGH 继续关闭。剩余 MEDIUM/LOW 均为非阻断 follow-up：坏 slot 隔离、
`list --refresh` CLI 覆盖、缺失/符号链接 pool 的 CLI 与日志语义、`refresh_invalid`
predicate 完整性、new-member fail-closed 覆盖、字面量 grep guard、无机器读数空态/legend，
以及 quota snapshot lstat 降级。

reviewer 额外执行的受影响定向测试与 shell family 均绿；其并发跑完整 Claude package 时有两个
diff 外文件失败，但两者在同一 HEAD 单独执行均绿，且 reviewer 明确归因于并发 host load。
因此本文不把该 aggregate 尝试列为通过证据，也不把它误报为本单代码失败。

## 页面验证边界

账号页渲染夹具可生成当前 HTML，定向测试覆盖 token 状态列、六号动态行、红色异常行、
HTML 转义和 390px 横向滚动样式。实际像素截图在当前受管 macOS runner 上未产出：
Chromium/系统 Chrome 在 Mach bootstrap 阶段被环境拒绝并以 SIGTRAP/SIGABRT 退出，
WebKit/Firefox 未安装。该环境失败不作为页面通过证据；独立 QA 仍需在可启动浏览器的环境
执行 1440×1200 与 390×900 截图核验。

## 证据边界

以上均为本地定向/相关验证，不称为 full suite 或 `CI OK`。未读取或改写真机
`~/.codex` 凭据，未切共享账号；六号真实探活、部署后账号页截图和 frozen-head exact-head CI
由 QA 阶段完成。
