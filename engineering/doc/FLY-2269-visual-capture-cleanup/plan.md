# FLY-2269 visual-capture 浏览器清理 — 实施计划
Issue: FLY-2269 (https://linear.app/geoforge3d/issue/FLY-2269/发布链泄漏-visual-capture-与-publish-report-同形的-chrome-页泄漏proofshot-start)
日期: 2026-09-02
基于: research.md

## 0. Design review 修正

R1 verdict 为 CHANGES_REQUESTED。以下八项全部采纳：

| findingKey | 修正 |
|---|---|
| `session-split-silent-empty-manifest`（HIGH） | start/exec 明确解析到同一绝对 session root、递归 discovery、零 PNG fail-loud；R2/R3 进一步纠正 cwd 方案为 start=项目 cwd + 绝对 output、exec=outputDir cwd。 |
| `unconditional-record-stop-not-owned` | 仅 owned browser 或 start 成功返回时 stop recording；shared + start failure 不停别人的 recording。 |
| `owned-path-has-no-tab-baseline` | 当时要求所有状态采 baseline；R6 真机证据证明 absent pre-list 有副作用，最终规则改为 present 才采、absent 由 session membership 证明 owned、unknown 零 close。 |
| `tab-window-vs-unlocked-agent-browser-users` | post-list 放在 ProofShot start 返回/抛错的紧邻 finally，窗口只覆盖 start；后续 3D exec 不重算所有权。 |
| `timeout-asserted-not-exercised` | 除 options 单测外，用会挂住的真实子进程桩测量约 15 秒返回；QA 再跑同一行为探针。 |
| `unspecified-cwd-and-env-seam` | VisualCaptureArgs 增加 `env` seam；ProofShot/agent-browser 共享同一显式 env；R2/R3 进一步区分 start 项目 cwd 与 exec/direct outputDir cwd。 |
| `publish-report-behavior-not-strictly-unchanged` | 明确 timeout 会进入既有 warning/fallback；增加 timeout-error 降级测试。 |
| `pnpm-codex-rescue-entrypoint-does-not-exist` | 删除不存在的 pnpm script 写法；按节点协议用 `codex:rescue` skill 形态，并以 request-driven gate 为有效 verdict。 |

### R2 no_verdict 原始 findings（六条）

R2 输出缺失机器可读判决，Lead 后续提供了完整原文。以下六条没有一条静默省略：

| finding | 处理状态 |
|---|---|
| `start-cwd-breaks-dev-server`（HIGH） | 采纳：start 保持项目 cwd，以绝对 `--output` 指向 session root；exec 才用 outputDir cwd，避免 UI `--run` 在空目录失败及 git metadata 丢失。 |
| `slow-test-timeout-coverage` | 采纳：hang-stub `it` 显式 `timeout: 40_000`，独立于其他 focused suites；stub 派生继承 stdout 的孙进程覆盖 daemon 形状。 |
| `shared-start-failure-orphans-own-recording`（MEDIUM） | 决定不在 shared/unknown + start failure 时 stop：客户端超时后服务端可能已开录，但没有证据可区别外来 recording，误停风险更高；§6/§9 明列残差与隔离恢复路径。 |
| `discovery-symlink-scope-narrowing`（LOW） | 采纳且不缩窄既有语义：递归仍收录指向 regular file 的 symlink，但不遍历 symlink directory；正/负单测锁定。 |
| `implicit-default-config-dependency`（LOW） | 采纳：outputDir 写/验证最小 `proofshot.config.json` 固定 exec root；start 的绝对 `--output` 覆盖项目/祖先 config。已有 config 不覆盖、不误删。 |
| `owned-path-has-no-tab-baseline`（LOW） | 当时采纳无条件 pre-list；R6 真机实测证明 absent 时 tab-list 会主动 spawn browser，故由 R6 更强证据取代，改为 absent 不 pre-list、present 才采 baseline。 |

### R3 CHANGES_REQUESTED 原始 findings（五条）

R3 reviewer 明确给出 CHANGES_REQUESTED，但 JSON 截尾导致 coordinator no_verdict。以下
五条逐项处理；重复项仍列出，便于审计每轮状态：

| finding | 处理状态 |
|---|---|
| `start-cwd-breaks-dev-server`（HIGH） | 采纳：同 R2，B1/B2/§6/§9 全部改为 start=项目 cwd + 绝对 output、exec=outputDir cwd，并增加真实 UI `--run` QA。 |
| `owned-skips-ownership-crosscheck`（MEDIUM） | 交叉校验保留但由 R6/R7 改为无副作用的 session-list membership 复核；不再以会 spawn 的 tab-list 交叉校验。 |
| `shared-start-failure-orphans-own-recording`（MEDIUM） | 明确决定不做无证据 stop；§6 写出残留与恢复，§9 把该歧义故障单列，不虚称下一轮必然自动恢复。 |
| `discovery-symlink-scope-narrowing`（LOW） | 采纳：保持 symlink-file 兼容、拒绝递归 symlink-dir，并各留测试。 |
| `implicit-default-config-dependency`（LOW） | 采纳：本轮 local config 固定 exec root；验证 pre-existing config，禁止覆盖/删除。 |

### R4 APPROVED advisories（两条 LOW）

R4 reviewer 实质 verdict 为 APPROVED，但 JSON 截尾导致 coordinator no_verdict。两条
非阻塞 finding 均采纳：

| finding | 处理状态 |
|---|---|
| `absent-branch-classifier-underspecified`（LOW） | 当时采纳四态分类器；R6 安装字节/真机证据证明 absent tab-list 会 spawn 且 sentinel 仅是 UI 文案，因此分类器整段删除，不保留 mock-only 分支。 |
| `qa-item5-scope-conflicts-with-item10`（LOW） | 采纳：§9 第 5 条限定为 cleanup 获授权的常规注入；第 10 条明确是 shared/unknown + 客户端超时/服务端已开录的歧义例外，分别写出 pass 判据。 |

### R5 CHANGES_REQUESTED（五条）

| finding | 处理状态 |
|---|---|
| `recursive-discovery-picks-up-prior-round-artifacts`（HIGH） | 采纳：start 前快照既有 session dirs；start 返回后读取/校验新 `.session.json.sessionDir`，必须是 session root 下 start 前不存在的直属真实目录；artifact discovery 只扫该目录。同一 outputDir 重跑测试证明第二轮 manifest 不含第一轮路径。 |
| `no-session-sentinel-substring-matches-siblings`（MEDIUM） | 采纳：解析 structured error 后只接受 trim 后整串等于两条 sentinel；复数/带端口兄弟串与任何其他文本一律 unknown，负向测试固定。 |
| `proofshot-start-exit-zero-on-stale-session-treated-as-success`（MEDIUM） | 采纳：start 前若 `.session.json` 已存在立即 fail-loud，不调用 start/exec、不授予 record-stop/close 权限、不删既有 state。start 返回后还必须读到合法的新 state 才算 succeeded。 |
| `fixed-15s-timeout-lacks-normal-latency-headroom-evidence`（MEDIUM） | 采纳：§9 台架记录每次 session/tab list elapsed、最大值与 15 秒比值；正常最大值若超过 5 秒，PR 必须说明仍采用 15 秒的依据。 |
| `before-arm-hard-fails-so-manifest-comparison-is-not-symmetric`（LOW） | 采纳：BEFORE 明确预期每轮 stop 处 exit 1 且 tab/renderer 净增，只作泄漏计数对照；artifact/manifest 字节判据限定 AFTER。 |

### R6 CHANGES_REQUESTED（三条）

| finding | 处理状态 |
|---|---|
| `unconditional-prelist-autospawns-the-browser-it-measures`（HIGH） | 采纳：session-list 明确 present 时才 pre-list；absent 直接用可信空 baseline且不触发 tab-list，unknown 不做会 spawn 的 pre-list并禁止 tab/whole close。测试与 QA 断言首轮起每轮 cleanup 后 session membership、tab、renderer 都精确回到初始 baseline。 |
| `no-session-sentinels-are-ui-strings-not-cli-errors`（MEDIUM） | 采纳：删除 absent 错误 sentinel 分类器和伪造分支测试；research 记录两条字符串只属于 stream-viewer UI，CLI absent tab-list 的真实行为是 spawn + success。 |
| `record-stop-authorization-narrowed-to-state-validation`（MEDIUM） | 采纳方案 (i)：pre-existing state 检查通过后，ProofShot start exit 0 即设置 `startReturned` 并授权 record-stop；state 校验只授权 exec/discovery，不撤销已成立的 recording ownership。 |

Lead 对 R6 的收口决定：在“不 spawn 的 ownership probe”与“完全删除 pre-list”之间选择
前者，不新增机制。具体复用已有的 `session list --json` membership；R6 reviewer 的隔离
对照已证明该命令本身不 spawn，spawn 点是 absent session 上的 `tab list`。因此 absent
仍可在 start 抛错时证明后续 browser 属于本轮并 whole-close；present 才执行安全的 tab
baseline；unknown 零 close。sentinel classifier 删除，record-stop 恢复为 start 成功返回
即授权。R7 是最后一轮设计审：若无 HIGH，采纳 MEDIUM/LOW 后直接实现；若仍有 HIGH，
把原文交 Lead 裁决，不自行开 R8。

### R7 CHANGES_REQUESTED 与 Lead 裁定（三条）

| finding | 处理状态 |
|---|---|
| `post-list-still-spawns-on-absent-session`（HIGH） | Lead 裁定采纳为全局 G1：任何 direct spawn-capable agent-browser 命令只能在无副作用 post session-list 证明本轮 absent→同一 target present、ownership=owned 后调用；start 在 openBrowser 前失败且仍 absent 时跳过 post tab-list，零 tab 命令。 |
| `invariant-7-still-requires-the-deleted-prelist-crosscheck`（MEDIUM） | 采纳：whole-close 唯一充分条件改为 ownership=owned；删除所有 pre-list 条件，调用矩阵逐项给出守卫。 |
| `absent-branch-lost-its-concurrent-user-crosscheck`（MEDIUM） | 按 Lead G3 不新增探针：紧邻 ProofShot start 前再用无副作用 session-list 复核 target 仍 absent；start 后 target 出现才记为本轮 owned。之后外部用户蹭入本轮 session 无法检测，§6 明列残差；整树 close 仍只按记录 target。 |

Lead 同时要求 R8 是最后裁定轮：若仍有 HIGH，不再自行改稿，把原文交 Lead 直接裁进
实现；若无 HIGH，采纳 MEDIUM/LOW 后直接实现，不开 R9。R2–R7 其余已采纳项保持。

### R8 CHANGES_REQUESTED 与 Lead 最终裁定（三条）

| finding | 处理状态 |
|---|---|
| `g1-fail-loud-on-present-session-disables-the-feature`（HIGH） | Lead 裁定采纳 reviewer 方案 (i)：恢复生产常态 present/shared。present 下 tab-list 已真机证明无副作用，可采 baseline、只关 post-minus-pre；absent 不 pre-list，bootstrap 后 owned whole-close。增加 present 起手真机臂。 |
| `probe-failure-now-aborts-the-whole-capture`（MEDIUM） | 采纳：probe failure=unknown + warning，但继续 ProofShot capture；无 baseline/ownership 时零 tab/browser close，记录安全残差，不把 timeout 升级成整条功能消失。 |
| `table-labels-tab-list-as-unconditionally-spawn-capable`（LOW） | 采纳：调用表改为条件分类——absent 时 tab-list 会 spawn（禁用），present 时 non-spawn（R8 生产机实测）；pre shared baseline 与 guarded post-list 分行。 |

最终裁定要求不再开 R9；本表连同 R8 三条原文是进入实现的 pinned 设计补丁。R2–R7
已采纳的 timeout、session/artifact、stale-state、recording 与所有权安全项继续有效。

## 1. 锁定目标与范围

目标：visual-capture 每次 ProofShot start 尝试后，都按本轮可证明的所有权回收
Chrome page/browser 与 recording；连续调用时 tab/renderer 不随 N 增长，外来 tab
存活，下一轮 start 仍成功。所有 agent-browser 同步子进程最多等待 15 秒。

只修改：

- `packages/flywheel-comm/src/agent-browser-runner.ts`（新增内部共享 runner）
- `packages/flywheel-comm/src/commands/publish-report.ts`
- `packages/flywheel-comm/src/commands/visual-capture.ts`
- `packages/flywheel-comm/src/proofshot/artifact-discovery.ts`
- `packages/flywheel-comm/src/__tests__/agent-browser-runner.test.ts`（新增）
- `packages/flywheel-comm/src/__tests__/artifact-discovery.test.ts`（新增）
- `packages/flywheel-comm/src/__tests__/visual-capture.test.ts`
- FLY-2269 DOC-FLOW 文档与最终 milestone

不改 reaper、ProofShot/agent-browser 安装版本、Bridge、CLI flags、环境配置、依赖或
`CLAUDE.md`；不 dispatch QA、不 merge/ship/deploy。

## 2. 行为不变量

1. ProofShot start 固定调用方项目 cwd，并传绝对
   `--output {outputDir}/proofshot-artifacts`；exec 固定 `cwd: outputDir`，由 output-local
   config 解析到同一 session root。不得拆 session，也不得让 UI `--run` 在空 outputDir
   启动 dev server。
2. start 前用唯一无副作用探针 `session list --json` 检查 target membership；R6 隔离
   对照证明它不 spawn。initial 与紧邻 start 前各探一次：任一次失败则 ownership=unknown、
   warning 但继续 capture；两次成功时以紧邻结果分类，present=shared、absent=owned
   candidate，状态翻转要 warning。shared 才执行 pre `tab list --json` 采 baseline；absent/
   unknown 不 pre-list。
3. start 前若 session root 已有 `.session.json`，立即 fail-loud：不得调用 start/exec、
   record-stop 或 browser/tab close，也不得删除旧 state。否则先快照 root 下既有直属
   session directories；`startAttempted=true` 必须在调用 ProofShot 前设置，start 返回或
   抛错都进入同一 cleanup。
4. ProofShot start 返回或抛错后先运行无副作用 `session list --json`。owned candidate
   只有在同一 target 由 absent→present 时升级 ownership=owned；shared 只有 post 仍
   present 才保留可信 baseline；post absent/失败一律降为 unknown。unknown 不因 post
   present 反推 ownership。
5. pre-existing state 检查通过后，ProofShot start exit 0 设置 `startReturned=true`；post
   membership 明确 present 时，它授权本轮 `record stop`（recording 所有权独立于 browser
   ownership）。仍须读取新 `.session.json`，
   校验 `sessionDir` 是 session root 下 start 前不存在、非 symlink 的直属真实目录，才
   设置 `stateValidated=true` 并允许 ProofShot exec/discovery。state 缺失、越界、旧目录
   或 malformed 都 fail-loud、不读取旧 artifact。
6. 只有 post membership 明确 target present 时，才在 start 调用的紧邻 finally 运行
   post `tab list --json`：owned 的 pre 集合是可信空集；shared 使用 start 前可信 baseline；
   稳定 `/^t\d+$/` post-minus-pre ids 才是本轮 tab。post absent/unknown 必须跳过，避免
   tab-list 自己 spawn；后续 screenshot/3D navigation 不重算差集。
7. whole-close 的唯一充分条件是 ownership=owned；优先对记录的同一 session 整树
   `agent-browser close`，失败只 fallback 关闭 post-list 已识别的稳定 tab ids。不得引用
   已删除的 pre-list 交叉校验。
8. shared 绝不 whole-close，只逐个关闭 guarded 差集 ids，外来 baseline tab 必须存活；
   unknown 继续 capture但零 tab/browser close。不得保留 mock-only no-session sentinel
   classifier。
9. `record stop` 只在 `startReturned=true` 且 post membership 明确 present 时执行（失败
   重试一次）；ProofShot start 抛错时不 stop recording，但 owned 仍 whole-close、shared
   仍关闭可信差集。
10. cleanup 顺序固定为：按上述条件 stop recording → page/browser close → 删除仅本轮
   新建的 `{outputDir}/proofshot-artifacts/.session.json` → 删除仅本轮新建的 output-local
   `proofshot.config.json`；pre-existing state/config 均保留。
11. probe、record stop、close、session-state remove 失败均 warning 并继续；cleanup
   不遮蔽 primary start/screenshot/manifest/notify 错误。
12. 成功路径在 artifact discovery/manifest/notify 之前执行 cleanup，避免后处理期间
   继续占用 Chrome；finally 只补尚未执行的同一 cleanup，禁止二次 stop。
13. artifact discovery 只从已校验的本轮 `sessionDir` 确定性递归；收录 regular file 与指向
   regular file 的 symlink，但不遍历 symlink directory；若没有至少一个 PNG，命令必须
   fail-loud，不得写出成功的空 manifest。
14. `VisualCaptureArgs.env ?? process.env` 是唯一 env 基线；profile/stream/session 对
   ProofShot 与 direct agent-browser 完全一致。start cwd 是调用方项目 cwd，exec/direct
   agent-browser cwd 是 outputDir。
15. `publish-report` 除新增 timeout 异常语义外行为不变；超时必须进入既有
   warning/fallback，不能扩大 browser ownership。
16. output-local config 不存在时才以 exclusive create 写入最小
   `{ "output": "./proofshot-artifacts" }`；若已存在，只在其 output 解析到同一 session
   root 时继续，绝不覆盖；cleanup 只删除本轮创建的 config。

### 2.1 agent-browser 调用清单与守卫

| 调用点 | spawn 分类 | 唯一允许条件 |
|---|---|---|
| direct `session list --json`（initial、紧邻 start 前、start 后） | non-spawn（R6 隔离实测） | 任意状态可调用；失败只产生 unknown + warning，不中止 capture、不授予 close 权限。 |
| direct pre `tab list --json` | target absent 时 spawn；present 时 non-spawn（R6/R8 实测） | 紧邻 start 前 membership 明确 present；结果成为 shared baseline。absent/unknown 禁用。 |
| `proofshot start` 内部 `agent-browser open` / `record start` | lifecycle command，会创建/使用 browser | pre-existing ProofShot state 不存在；shared/owned-candidate/unknown 都继续 capture。 |
| direct post `tab list --json` | target absent 时 spawn；present 时 non-spawn（R6/R8 实测） | start 后 membership 明确 target present；owned 用空 baseline，shared 用可信 baseline，unknown 即使 post present也无 baseline、禁用。 |
| `proofshot exec ...` 内部 agent-browser 调用 | lifecycle command | `startReturned=true` 且 `stateValidated=true`；probe unknown 不取消 capture。 |
| direct `record stop`（最多两次） | present 时使用既有 session | `startReturned=true` 且 post membership 明确 target present。 |
| direct `close`（整树） | destructive | ownership=owned；命令使用记录的同一 target session env。 |
| direct `tab close <tN>` | present 时使用既有 session、destructive | shared 的 guarded 差集；或 owned whole-close 失败 fallback。id 必须来自 guarded post-list 且匹配 `/^t\d+$/`。 |

任何 tab 命令在 target absent/unknown 时禁止调用，而 present 下 tab-list 已实测不 spawn。
shared 仅获逐 tab 差集权限，owned 才获 whole-close，unknown 零 close；实现与测试须逐项
对照此表，不能另藏 direct agent-browser 调用。

## 3. Slice A — agent-browser timeout（RED → GREEN）

### A1. RED

新增 `agent-browser-runner.test.ts`，mock `node:child_process.execFileSync`：

- JSON 调用返回 UTF-8 stdout，并断言 options 含 `timeout: 15_000`；
- 非 JSON 调用返回 undefined，并断言同一 timeout；
- cwd/env 原样转发，命令固定为 `agent-browser` + argv（不经 shell）。
- 另用 PATH 中一个真实可执行 hang stub 调用 default runner；stub 派生一个继承 stdout
  的孙进程以模拟 daemon 形状，测量调用在约 15 秒抛出 timeout，而不是等 stub/孙进程
  自然结束。该 `it` 显式设置 `timeout: 40_000`，并保留宽松 13–25 秒断言窗口避免 CI
  抖动。

先运行：

```bash
pnpm --filter flywheel-comm exec vitest run src/__tests__/agent-browser-runner.test.ts
```

预期因模块尚不存在而 RED；保存输出并提交测试。

该慢测文件作为 Slice A 的独立 focused invocation 运行；后续 artifact/visual/publish
focused suites 另起一次 invocation，不把 15 秒 wall time 混入其他行为测试。

### A2. GREEN

新增内部模块并导出：

- `AGENT_BROWSER_CALL_TIMEOUT_MS = 15_000`；
- `RunAgentBrowser` / opts 类型（`cwd`、`env`）；
- `defaultRunAgentBrowser()`，JSON/非 JSON 两分支都设置 timeout。

`publish-report.ts` import 该 runner，删除本地无 timeout 实现，并继续 re-export
`RunAgentBrowser` 类型避免内部消费者漂移。publish-report 增加一个注入 ETIMEDOUT 的
preflight 测试，证明 timeout 异常进入保留 shared browser 的既有降级。运行新 test 与
publish-report focused suite，预期全绿；提交最小 GREEN。

## 4. Slice B — ProofShot session/artifact 对齐（RED → GREEN）

### B1. RED：真实目录形状

新增 `artifact-discovery.test.ts` 与 visual-capture 用例：

- fixture 形状为 `{outputDir}/proofshot-artifacts/<timestamp_slug>/step-ui.png`，不再把
  PNG 伪造在 outputDir 顶层；
- 断言 start opts.cwd 等于调用方项目 cwd、argv 含绝对 session-root `--output`；exec
  opts.cwd 等于 outputDir，且 output-local config 把 exec 指到同一 root；
- 断言 UI `--run <devCommand>` 仍由项目 cwd 的 start 调用承载，不会落到空 outputDir；
- 断言递归发现 nested PNG，manifest.selected 指向该绝对路径；
- 断言 symlink-file PNG 保持可发现、symlink directory 不递归；
- 同一 outputDir 模拟连续两轮、各有独立 session dir，第二轮 manifest/selected 只含
  第二轮 state 指定目录，绝不含第一轮路径；若 state 指回 start 前已存在目录则 fail；
- 没有 PNG 时 visualCapture rejects，且不会返回 `selected: []` 成功 envelope。

当前代码因 start/exec session split、缺少 local config、discovery 非递归而 RED。

### B2. GREEN：最小 session 对齐

- start 保持项目 cwd 并传绝对 `--output <sessionRoot>`；exec 传
  `{cwd: outputDir, env}`；在 start 前 exclusive-create 或验证 output-local config；
- start 前拒绝 pre-existing `.session.json` 并快照直属 session dirs；start 返回后读取
  state，严格校验新 `sessionDir` 的类型、边界与 freshness，只把该绝对路径交给 discovery；
- `discoverArtifacts()` 改成确定性递归，保留 symlink-file，跳过 symlink directory；
- artifact selection 前要求至少一个 PNG，否则抛明确错误；
- session-state 路径改为 `{outputDir}/proofshot-artifacts/.session.json`。

运行 artifact-discovery + visual-capture focused tests，预期 GREEN。

## 5. Slice C — visual-capture lifecycle（逐条 RED → GREEN）

### C1. RED：start failure 不再跳过 cleanup

先改 visual-capture focused tests 的基线 stub，使每次测试显式模拟 session/tab JSON，
再加第一条失败测试：

- preflight 明确 session 不存在，因此不调用会 spawn 的 pre-list，直接采用可信空
  baseline；
- start stub 在记录调用后抛 `Recording already active`；
- post membership 确认同一 target 已 present，guarded post-list 返回 start 新开的
  `t1/t2`；
- 断言不 record-stop（ProofShot 未成功返回），但仍 whole close 本轮 owned browser，
  lock 释放，caller 保留 start 原错。

再加 present/unknown 两臂 RED：present target 的 pre baseline 有外来 t9，post 有
t9/t10，只关闭 t10、不 whole-close；probe failure=unknown 仍完成 start/state/exec/
manifest，但零 tab/browser close。三臂是进入实现前的第一批 RED。

运行 focused suite，当前实现因完全不调用 agent-browser 而 RED。提交测试证据。

### C2. GREEN：最小 startAttempted + owned cleanup

给 `VisualCaptureArgs` 增加 `env` 与 `runAgentBrowser` test seam，复用 shared runner；
在 ProofShot start 前完成 initial + 紧邻 start 的两次 non-spawn membership；两次成功时
final present=shared并采 baseline、final absent=owned candidate，任一失败=unknown但继续。
用 start 的紧邻 finally 先复核 membership：present 时 owned/shared 可 guarded post-list，
unknown 不 tab-list。外层 finally 调同步 warning-only cleanup。实现 startReturned record
条件、owned whole close、shared stable-id close，删除本轮新建的 `.session.json`/config。
再次运行三臂，预期 GREEN。

### C3. RED/GREEN：ownership guards

依次添加并实现以下判别测试，每加一组先确认当前实现按预期失败：

1. initial/final target present：采 shared baseline，capture 成功，外来 t9 存活，只关
   post-minus-pre t10/t11，membership 逐字不变、零 whole-close；
2. initial 或紧邻 start 前 session probe 失败：ownership unknown、warning但 capture 仍
   成功，零 tab/browser close；若 startReturned 且 post membership present，仍 stop 本轮
   recording；
3. initial + second probe absent，ProofShot 抛错但 post membership 仍 absent：零 tab-list/
   record/close；若 post membership present则记 owned、guarded post-list、whole-close，之后
   session membership 回到调用前集合，首轮也不得净增 browser/t1；
4. post JSON 失败：start 成功时 record stop 仍执行，零误关；
5. whole close 失败：owned path 逐个 fallback，单个 tab close 失败不阻断后续 id；
6. record stop 首次失败：恰好重试一次并继续 close；两次失败 warning 仍继续 close；
7. screenshot failure + cleanup failure：caller 仍看到 screenshot 原错，lock 仍释放；
8. `.session.json` 与 local config 都只在本轮创建时删除，pre-existing 文件不删；已有
   config 只有解析到同一 session root 才允许继续，绝不覆盖。
9. 在 start 后、后续 3D `exec open` 期间注入的外来新 tab 不进入已冻结的 owned-id
   集合，证明识别窗口没有扩大到整个 capture。
10. pre-existing `.session.json` 立即 fail-loud，ProofShot 即使被 stub 成 exit 0 也不
    调用，且零 record-stop/close、旧 state 保留；start exit 0 但没有合法新 state 或 state
    指向旧/越界/symlink dir 不得设置 `stateValidated` 或读取 artifact，但仍须恰好执行
    本轮 recording 的 record-stop（失败重试一次）。
11. 按 §2.1 表对每个 agent-browser 调用断言 guard；尤其 post membership probe 失败时
    不得调用 post tab-list/record/close，start-before-open failure 的完整序列里零 tab
    命令；present tab-list 前后 membership 不变，absent tab-list 永不触发。

### C4. REFACTOR：统一顺序与 env

- 提取仅函数内使用的 JSON list parser / `cleanupCapture` closure，避免新增公共 API；
- 将显式 env 转给 ProofShot/direct agent-browser；start 明确项目 cwd + 绝对 output，
  exec/direct agent-browser 明确 outputDir cwd；
- 删除两个 `runProofShot(["stop"])` 与过时的 started/stopAttempted 状态；
- 更新文件头流程注释与测试中“所有调用都是 ProofShot”的旧断言。

运行：

```bash
pnpm --filter flywheel-comm exec vitest run src/__tests__/artifact-discovery.test.ts src/__tests__/visual-capture.test.ts src/__tests__/agent-browser-runner.test.ts src/__tests__/publish-report.test.ts
pnpm --filter flywheel-comm typecheck
pnpm --filter flywheel-comm build
```

## 6. Artifact 兼容性与已知取舍

当前安装的 ProofShot stop 无法可靠保留 shared browser；因此获批后实现不会在任一路径
调用它。实现先修正既有 session split，实际 artifact 在
`proofshot-artifacts/<timestamp_slug>/`；具体方式是 start 从项目 cwd 带绝对 output，
exec 从带最小 config 的 outputDir cwd 解析同一 root。start 后从新 state 固定本轮
sessionDir，discovery 只递归该目录，绝不扫同 root 的旧轮次；
至少一个 PNG 才能成功写 manifest。本轮创建的 `.session.json`/config 显式删除，保证
下次 start 不被 stale ProofShot state 拦住，也不受祖先 config 漂移影响。

代价是 ProofShot stopCommand 才生成的 SUMMARY/viewer/error bundle 不再新增。该边界
已在 exploration/research 中显式披露；不复制第三方 bundle 逻辑，也不以误关 shared
browser 换取 SUMMARY。PNG 路径与非空 manifest 是本单硬门；SUMMARY/viewer 缺失是
明确的降级边界，交由后续安全 finalize/ProofShot upstream fix 处理。

R2 记录的 recording 残差在 G1 后只剩 post membership unknown：start 前虽为 absent，
但 start 失败/返回后 non-spawn membership probe 若也失败，就不能确认 session id，任何
direct record/close 均被 G1 禁止。若客户端 `record start` 超时但服务端其实已开录，该
recording 可能残留并令下一轮 already-active；恢复需由运维确认 session/profile 所有权后
隔离清理。§9 单列该形状，不用无 ownership 证据的命令伪造恢复。

R8 最终裁定恢复生产常态 present/shared：present 下 tab-list 已实测无副作用，因此可采
baseline 并只关差集；absent 不 pre-list，bootstrap 后 whole-close；probe failure=unknown
仍继续 capture但零 tab/browser close。明确残差：(a) unknown 或 start 后 post membership
probe 失败时，本轮可能创建的 tab/browser 无 ownership 证据，只能 warning 保留；
(b) membership 确认 owned 后，外部用户再蹭入同一 recorded session 无法区分，整树 close
会一并结束它；按 Lead G3，该树仍属于本轮创建，不新增竞态探针。

## 7. Diff 与负向审计

实现后执行：

- `rg -n 'runProofShot\(\["stop"\]\)' packages/flywheel-comm/src/commands/visual-capture.ts`
  必须零命中；
- `rg -n 'execFileSync\("agent-browser"' packages/flywheel-comm/src` 只能命中共享 runner，
  且该调用 options 含固定 timeout；
- 检查 start 调用保留项目 cwd 且携带绝对 `--output`，exec/direct agent-browser 才用
  outputDir cwd；local config 以 exclusive create 且 cleanup 不删除 pre-existing 文件；
- `git diff origin/main -- packages/teamlead/src/bridge/chrome-session-reaper.ts CLAUDE.md`
  必须为空；
- 检查无依赖、CLI flags、config/env timeout knob 变化。

## 8. 全仓验证与代码审查

完成 focused/typecheck 后按合同执行：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

枚举并运行本分支新增的每个 `scripts/__tests__/*.test.sh`；预期本单不新增 shell test。
随后按节点协议以 `codex:rescue` skill 形态尝试 review-only 代码审查（绝不调用不存在的
pnpm script，绝不 raw `codex exec`），并按注入协议开 `review_code` gate +
`request-review`；后者的结构化 `reviewVerdict` 是有效门。CHANGES_REQUESTED 必须修复后
新开一轮；APPROVED advisories 报 Lead。

## 9. 独立 QA handoff

同一隔离 Chrome 台架分别运行 origin/main BEFORE 与本 PR AFTER，各连续 N≥3 份
visual-capture，并在一轮注入 `proofshot start`/recording failure：

1. 每轮前后记录 `session list --json` membership，并从 CDP `/json/list` 记录全部 tab 与
   本轮新 tab；AFTER 从首轮开始每次 cleanup 后两者都必须精确回到初始 baseline，不能
   只证明第 2..N 轮不再增长；
2. 按同一 user-data-dir 记录 `--type=renderer` 进程数；
3. 增加生产常态 present 起手臂：target shared session 预置外来 tab，capture 必须成功，
   只关闭 post-minus-pre 新 tab，外来 id/URL 存活且 cleanup 后 membership 逐字不变；
   absent 起手臂则 bootstrap owned browser、whole-close 后回到初始 baseline；
4. BEFORE 预期每轮在错误 cwd 的 ProofShot stop 处 exit 1，且 tab/renderer 随轮次净增；
   它只作为泄漏计数对照。AFTER 正常与常规注入失败轮都回到 baseline，tab/renderer
   不随 N 增长；
5. 对 cleanup 已获授权的常规注入（owned start failure，或 start 成功后 screenshot/
   record-stop failure），下一轮 start、screenshot、record stop 均成功；该判据不适用于
   第 10 条无 recording 所有权证据的歧义例外。
6. membership probe 故障注入时 warning 可见、capture/manifest 仍成功、零 tab/browser
   close；若 post 明确 present且 startReturned，record-stop 仍回收本轮 recording。另测
   start-before-open failure + post membership 仍 absent，完整序列零 tab 命令且
   membership 不变。
7. AFTER 每轮 stdout/manifest 的 selected 至少含一个存在且非空的 PNG，并记录路径与
   字节数；BEFORE 预期 exit 1、无 manifest，不做不对称的 artifact 字段比较。AFTER
   同一 outputDir 重跑两轮时，第二轮 manifest 不得含第一轮 sessionDir 的任何路径。
8. 用会挂住的 agent-browser 桩（或隔离真二进制故障注入）实测单次调用约 15 秒返回，
   记录 elapsed 与 timeout error；不得只引用 unit mock 的 options 断言。同时逐次记录
   正常 `session list --json` / `tab list --json` elapsed，报告最大值及其与 15 秒的比值；
   最大值若超过 5 秒，PR 必须说明为何仍保留 15 秒常量及其误超时风险。
9. AFTER 至少一轮使用 UI `--run` 真正启动 dev server，证明命令从项目 cwd（有
   package.json/git metadata）执行，而不是空 outputDir。
10. 另行记录 start 后 post membership probe=unknown，且客户端超时但服务端已开录的
    歧义注入；pass 判据是零 tab/record-stop/whole-close、记录残留 session/recording 状态
    及 owner-confirmed 隔离恢复路径。该例外不要求清理前的下一轮 start 成功，不用无
    证据命令换取伪造恢复。

实现节点不运行生产 Chrome、不关闭默认共享 session；把 built SHA、focused/full gates
与上述台架步骤交给 DAG QA 节点。

## 10. 提交与交接顺序

建议提交：

1. `test(FLY-2269): bound agent browser calls`（RED）
2. `fix(FLY-2269): bound agent browser calls`（GREEN）
3. `test(FLY-2269): expose proofshot session split`（RED）
4. `fix(FLY-2269): align proofshot artifacts`（GREEN）
5. `test(FLY-2269): expose visual capture page leak`（RED）
6. `fix(FLY-2269): clean visual capture browser ownership`（GREEN）
7. review 修复（如有）
8. `engineering/doc/milestones/FLY-2269.md` 必须是 PR 前 literal last commit

计划 commit 后绑定 design review，verdict 后不再修改本文件。全仓 gates 与 code review
通过后，先 recheck inbox，再提交 milestone、push、开 PR；最后执行
`complete --route needs_review --pr <NUMBER>`。不 dispatch QA、不请求 ship approval、
不 merge。
