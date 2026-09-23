# FLY-2766 GPT-6 Sol 切换兼容 — 实施验证
Issue: FLY-2766 (https://linear.app/geoforge3d/issue/FLY-2766/模型跟随最新-codex-模型别名化工作流模板-implement-节点与-cli-默认模型不再写死版本号gpt-56-sol-gpt-6)
日期: 2026-09-22
基于: plan.md

## 本轮代码结论

主体实现代码头为 `cf7085dda`；与 `origin/main@83eb300f2` 技术同步后，自动 CI inventory
修订代码头为 `a004403f5`。本 PR 只准备 Codex/Sol 一侧，不发布生产模板、不改 CLI config、
不派 QA、不重启或合并：

- runner founder TUI 的 `codex resume --remote` 保留 `-C`，不再重复传
  `-s workspace-write` / `approval_policy=never`；daemon 端权限合同未改；
- native skill admission 只接受 `0.153.2 + 旧树`、`0.154.0 + 新树`、
  `0.156.0 + 新树` 三个精确组合，未知版本与树错配 fail-closed；manifest 记录实际版本；
- registry 新增 exact `gpt-6-sol`，仅 `runner` / `workflow` 可选，runner 仅 `xhigh`；
  无 alias，不进入 `lead` / `cron` / `dispatch`，`codex` 仍指向 `gpt-5.6-sol`，Astra 不变；
- home canary 从该 home 的 `packages/standalone/current/codex` 读取版本；origin canary 只接受
  resolver 给出的 versioned immutable origin。两者都不启动模型、不写生产。

## Lead rework：baseline 根目录软链

Lead 在真实主机物化 origin 后发现 `~/.codex-259-qa/packages` 是指向
`/Users/xiaorongli/.codex-242/packages` 的目录软链。旧代码把逻辑路径写进 baseline，origin
canary 又要求该字符串等于自身 realpath，导致三版内容 digest 全部正确却一致
`native_skill_baseline_unverified`。

本轮新增了「configured origin root 经过目录软链」的 RED 用例；最小修复只在受信 pinned-origin
配置边界把 root 解析为 canonical path，再交给既有完整树验证与 source copy。home、每个子目录和
文件的 canonical / symlink / digest / file-count 守卫均未放宽。origin canary 同样报告 canonical
`selectedOrigin`，不再拿含软链的配置字符串与 realpath 做必然失败的比较。

在生产真实路径只读执行 plan T5 校验段后，`0.153.2`、`0.154.0`、`0.156.0` 三版全部
`status=passed`，各返回 6 个 source，`selectedOrigin` 均位于
`/Users/xiaorongli/.codex-242/packages/native-skill-baselines/<version>/skills/.system`；
`modelStarted=false`、`productionMutated=false`。阴性对照 `0.155.0` 仍以 exit 1 返回
`native_skill_baseline_unverified`。本轮没有改动 Lead 已物化的只读 origin。

## 项目 × 节点切换矩阵

只读查询当前 `workflow_category_binding` 得到 7 个项目；每个项目都把 `code` 绑定到
`tpl_code`、把 `simple_code` 绑定到 `tpl_simple_code`。当前 active revision 分别是
`tpl_code@14`、`tpl_simple_code@6`，两者 `implement` 都仍是 `gpt-5.6-sol`。下表是严格按
runbook 完成生产 cutover 后必须逐项目证明的状态，不是本地代码已完成的生产声明：

| 项目 | `tpl_code/eng_design` | `tpl_code/implement` | `tpl_code/qa` | `tpl_simple_code/implement` | `tpl_simple_code/qa` | Claude Lead 解析 |
| --- | --- | --- | --- | --- | --- | --- |
| flywheel | `fable`（本单不改） | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `opus` / `opus[1m]` 由 FLY-2775 验收 |
| geoforge3d | `fable`（本单不改） | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `opus` / `opus[1m]` 由 FLY-2775 验收 |
| growth | `fable`（本单不改） | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `opus` / `opus[1m]` 由 FLY-2775 验收 |
| joycon-typeless | `fable`（本单不改） | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `opus` / `opus[1m]` 由 FLY-2775 验收 |
| personal-assistant | `fable`（本单不改） | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `opus` / `opus[1m]` 由 FLY-2775 验收 |
| raya | `fable`（本单不改） | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `opus` / `opus[1m]` 由 FLY-2775 验收；Raya Lead 载体保持 `gpt-6-astra` |
| tidal-echo | `fable`（本单不改） | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `gpt-6-sol` | 当前 `claude-opus-5`；本单不改 | `opus` / `opus[1m]` 由 FLY-2775 验收 |

受管 snapshot 命令因当前 runner 缺少 snapshot owner 上下文而返回
`snapshot_owner_unavailable`，没有创建副本；随后使用 `sqlite3 -readonly` 加
`PRAGMA query_only=ON` 直接读取上述两张表，进程退出即关闭 handle，全程零写。

## Consumer discovery 与排除

对所有 production changed files 都以完整相对路径、文件名、父目录分别执行了
`git grep -lF`。父目录 needle 天然覆盖整个 package / scripts 树，按下列逐类规则处理了每个命中：

1. `codex-runner-tui-window.ts`：保留直接 helper test、`CodexTmuxAdapter`、real-tmux、
   reconcile、async-exec/socket 等 `vitest related` 消费者；历史 exploration/plan/QA 文档只引用
   文件名，排除；kill-path inventory 与 child-process census 只锁进程身份/路径，本次没改路径或
   kill 语义，排除其静态字符串命中。
2. `model-builtins.ts` / `model-tiers.ts` / `feature-flags/truth.ts`：保留 import graph 选出的
   30 个 config test files（registry/config/binding/display/phase、writer/loader、flag truth/drift 等）；
   历史工程/产品文档、审计原始清单只引用路径，排除；父目录命中的其余 config 文件由
   `vitest related` 证明没有直接依赖本次 changed modules，排除。
3. teamlead `deployment.ts`、native baseline/home/resource、`runtime-factory.ts`：保留
   deployment、native home/skills/pinned baseline、runtime factory/default runtime/default parent、
   Codex Lead TUI/runtime 与 parity drill 等 20 + 5 个 related test files；FLY-2519 等历史 review/
   verification JSON/Markdown、CI 路径快照和 child-process census 仅为档案或路径盘点，排除。
   新 `native-resource-baseline-0154-0156.ts` 的完整路径与文件名没有额外字符串消费者；实际
   import 由 TypeScript `.js` specifier 和 related graph 覆盖。
4. 两个 canary scripts：行为断言最终并入 CI 已枚举的
   `qa-codex-lead-parity.test.mjs`；独立新 test 文件因 root Node suite inventory 要求被删除，
   没有修改 `ci.yml`。历史文档、CI 路径快照仅引用脚本路径，排除；父目录 `scripts` 的其余
   命中不导入这两个脚本，排除。
5. changed tests 与本 issue docs 本身不是 production 依赖源；测试已直接运行，docs 不执行，
   因此不从它们继续扩张测试面。测试夹具和历史文档中的 `gpt-5.6-sol` 保留，不代表当前 alias/
   default 已切换。
6. symlink rework 再次以 `native-home.ts` 与 origin canary 的完整路径、文件名、父目录执行
   `git grep -lF`。`native-home.ts` 的字符串命中仍只有历史 review/evidence 与 CI inventory，实际
   TypeScript 消费者由 `vitest related` 的 17 files / 326 tests 覆盖；`lead-capabilities` 父目录命中
   的历史文档、kill-path inventory 与 child-process census 只记录路径，排除。origin canary 的
   exact 文件名消费者只有本 issue plan 与已执行的 `qa-codex-lead-parity.test.mjs`；`scripts`
   父目录的全仓命中不 import 该独立入口，排除。

## 本地验证

| 验证 | 结果 |
| --- | --- |
| T1 RED | helper 60 tests 中 2 个旧 client permission override 断言失败，其余 58 通过 |
| T1 GREEN / related | claude-runner 6 files、214 tests 全绿；含 helper 60、adapter 130、real tmux 3 |
| T2 RED | 目标版本、resolver、runtime manifest 共 5 failures / 11 passed |
| T2 GREEN direct | 6 files、25 tests 全绿；canary Node tests 2/2 |
| T2 related | source graph 20 files / 345 tests；changed-test graph 5 files / 24 tests，全绿 |
| native tree 实测 | 0.153.2 当前 home 60-file 全树 canary 通过；隔离 0.156.0 生成树同时通过 0.154.0/0.156.0 pin；旧/新错配与 0.155.0 拒绝 |
| T3 RED | registry/catalog/display/phase tag 共 4 failures / 19 passed |
| T3 direct | registry/config/display/phase 4 files / 62 tests 全绿 |
| config related | 30 files / 498 tests 全绿；首次 related 暴露 canary env 未分类，补为 non-flag per-invocation selector 后复跑通过 |
| review revision RED | prototype-like version、缺失 origin、canary child env 三类新增断言按预期失败 |
| review revision GREEN | teamlead related 19 files / 341 tests；native canary subset 3/3；真实 0.153.2 home canary 通过 |
| scripts | `node --test scripts/__tests__/qa-codex-lead-parity.test.mjs`，9/9（含 native canary 3 项） |
| lint | `pnpm lint` exit 0；25 条既有 warning，零 error，未修改无关文件 |
| builds | `flywheel-claude-runner...`、`flywheel-config...`、`flywheel-teamlead...` 均成功 |
| dependent typecheck | `...flywheel-config` 最终 13 个 workspace packages 全绿；首次 `voice-codex` 因 sibling `voice-bridge` dist 未构建失败，构建 `flywheel-voice-codex...` 后整条复跑通过 |
| main sync | config related 30 files / 498 tests；teamlead related 20 files / 346 tests；canary 3/3；milestone guard 32/32；affected builds、13-package dependent typecheck、lint 与 diff check 全绿 |
| symlink rework RED | `native-pinned-home.test.ts` 4 项中新增目录软链用例唯一失败，错误为 `native_skill_home_unverified` |
| symlink rework GREEN | `native-pinned-home.test.ts` 4/4；teamlead `vitest related` 17 files / 326 tests；canary Node suite 9/9 |
| 生产真实 origin 只读复核 | canonical root=`/Users/xiaorongli/.codex-242/packages/native-skill-baselines`；0.153.2 / 0.154.0 / 0.156.0 均 passed 且各 6 sources；0.155.0 阴性 exit 1 |
| symlink rework build / lint | `pnpm --filter "flywheel-teamlead..." build` 成功；`pnpm lint` exit 0，25 条既有 warning、零 error |
| hygiene | `git diff --check` 通过，worktree clean |

没有运行本地 full package suite，也没有请求 full CI。focused/related、build/typecheck、review、
PR CI 与后续 frozen-head QA 是不同证据；`CI Scope OK` 不能称作 full-suite 或 ship 证据。

## 首轮代码复审

首轮 effective code review 在 `c2dc1063c` 上通过（question
`dca1ed34-9bc2-4598-82db-50064ee221ab`，request
`81dd3d74-4bf2-4193-b291-e694c7ea3757`），无 HIGH blocker。其 advisory 在 milestone 前按以下方式处理：

- resolver 只接受 map 的 own key，`constructor` / `toString` / `__proto__` 全部以
  `baseline_drift` fail-closed；
- missing-home 路径先验证 pinned origin 存在，缺失时统一返回
  `native_skill_home_unverified`，不泄漏原始 ENOENT；
- home canary 探测 `codex --version` 时使用不可写 `HOME=/dev/null` 且不传
  `CODEX_HOME`；测试已从源代码 grep 改成 fake-binary 行为断言；
- 删除旧资源清单中未使用且重复的 origin root，root 只由 versioned resolver 构造。

另两项属于已明确冻结顺序的部署风险，而不是本实现节点可执行动作：registry 代码不得在 host
binary 升级和 smoke 前部署，三个 immutable origin 必须先物化并通过 canary；这些仍是下节的
merge/deploy 硬前置。literal-last milestone 提交后会对最终 HEAD 再发起一次 effective review。

## `origin/main` 技术同步

PR 首次推送后 GitHub 报 `mergeStateStatus=DIRTY`。按合同把
`origin/main@83eb300f2c9b35c76ac5be29b3bab2477e607b99` 合入当前 feature branch；唯一手工冲突是
`packages/config/src/feature-flags/truth.ts` 的同一 allowlist 插入点，解法同时保留 FLY-2766 的
native baseline selector 和 main 上 FLY-2654 的两个 standing-authority plumbing key。
`packages/teamlead/src/lead-capabilities/deployment.ts` 自动合并后仍保留 FLY-2766 的 versioned
resource deployment entry。没有修改 `ci.yml` 的 branch-side 内容，也没有 push main。

合并提交 `13f89345b2d66141f499b54e9ad968b1923762c1` 后重新运行受影响验证：config related
30 files / 498 tests、teamlead related 20 files / 346 tests、canary 3/3、milestone layout
32/32、claude-runner 与 teamlead package-plus-dependency build、13-package dependent typecheck、
`pnpm lint`（零 error、25 条既有 warning）和 `git diff --check` 全部通过。旧 review 不用于覆盖
这个新头；milestone 重新成为最后提交后另开 final exact-head review。

自动 PR CI run `35810692177` 的 Quick Gate job `107021368682` 在当前代码上真实执行后红于
`qa-fly-2766-native-canary.test.mjs` 未被 `ci.yml` 显式枚举。没有扩大范围修改 `ci.yml`；把同样的
三项断言并入已枚举的 `qa-codex-lead-parity.test.mjs`，并删除新 root Node suite。修订代码头
`a004403f5` 上，本地该 suite 9/9 通过，`ci-shell-suite-enumeration.test.sh` 证明 85 个 root
Node suites 全部已枚举。旧 CI run 不会被手工重跑；新 push 的自动 run 才能形成新头证据。

## 尚未执行的硬前置与 QA

- Lead 已按 `plan.md` T5 把 `0.153.2`、`0.154.0`、`0.156.0` 三份只读 origin 物化在真实
  canonical packages 根。本轮修复后 implement worktree 的只读校验三版均通过；QA 仍须在新的
  exact reviewed HEAD 重跑同一段并保留 receipt，不能拿本轮 implement 输出代替独立 QA。
  origin 已在 merge 前就位，合入后不再与 00:00/12:00 updater 班车竞争，也不需要
  disable/bootout updater；禁止改动或从 active home 重写这些 origin。
- 隔离验证 runner 0.153.2 / 0.156.0 TUI、Lead 0.156.0 cold start、review companion、四个
  home 切换与 smoke 均归后续 QA/Lead；本节点未执行。
- binary/config 健康全部通过后，才可严格最后发布 `tpl_code` 与 `tpl_simple_code` 的新 revision；
  `tpl_eng_heavy` 已 retired，不动。随后逐个新派 7 个项目的 `code` / `simple_code`，核对日志和
  pane 首屏都是 `implement=gpt-6-sol`。已在飞 snapshot 不改；开放但未 pin 的 run 可能读取新
  revision，因此 template publication 必须是最后一步。
- 四个 Codex home 全部稳定运行 0.156.0 一周后，由 Lead 删除 0.153.2 / 0.154.0 临时 pin；
  本单不另开票，但这一周窗口结束前不能提前缩窄。
