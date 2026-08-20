# Design Review — plan.md (Round 15)

Date: 2026-08-20
Author: Codex
Status: CHANGES REQUESTED

## Summary

R15 的方向正确：它确实把未量化的自动回收腿从 10 个交付物收成 5 个，`d147e58~1..d147e58` 对 plan 是 803 行删除、201 行新增；supervisor、Chrome shim、官方插件 cutover、activation 状态机、legacy drain 工具和 Chrome.app 内容身份都已退出。本轮没有理由恢复这些机制，JSONL audit ledger、P3 one-shot quarantine、P1 不改官方插件身份也都符合裁决。

但当前稿还不能实施。阻塞点不是被裁掉的自动回收架构，而是收窄时误删/遗漏了三个仍属于窄范围的契约：

1. R15 把 P0 已有的 lifecycle `authorityCheck` 连同 P2 activation authority 一起从文字和 TDD 中删掉了；classifier 只能证明“它是 MCP”，不能证明“当前仍获准 teardown”。
2. census 没有可持久表达 `unknown` 或“这两周尺子一直在工作”的 schema；若直接骑现有 reaper，会把 `ps` 失败或 Bridge 停摆伪装成零残量/无数据。
3. P3 的 `quiet gate → lsof → rename` 不是租约；新 MCP 可以在最后一次 `lsof` 与 rename 之间打开旧目录，Unix rename 仍会成功，所以“quarantine 结构上不可能再被进程打开”不成立。

这些都能在不恢复 supervisor、managed plugin、launch barrier 或状态机的前提下用小改动闭合。P1 的 CoreGraphics + 阳性对照 + UA 佐证是可判定、与症状同构的验收，本轮没有发现仍用 `--headless` argv 子串或 env-presence 冒充 P1 成功的行。

## Verified against code

| claim | verdict | evidence |
|---|---|---|
| P0 当前默认只给 3 秒，两个生产入口未覆盖 | VERIFIED | `mcp-descendant-reaper.ts:170-179`；`runner-teardown.ts:61-78`；`plugin.ts:6762-6781`。上游 `coreBundle.js:72239-72252` 给 `gracefullyCloseAll()` 15 秒 watchdog。 |
| P0 的 5 + 16 + 2 = 23 秒分段本身一致 | VERIFIED WITH CONDITION | 算术与“最后一次成功 TERM + 16 秒”一致；但 5 秒 dispatch 必须包含初始枚举、fresh snapshot、classifier、既有 authority probe 和全部 TERM，而不是从 `reapCandidates()` 内部才起表。 |
| R15 没有放松 P0 | FALSE | pre-cut plan 的 KILL 前契约是 `fresh exact snapshot + authority gate`，TDD 也有“authority 丢失停止信号”；现稿 `plan.md:75,138` 改成 classifier/identity，然而 `mcp-descendant-reaper.ts:137-145,184-204` 仍有 sticky `authorityCheck`，`close-runner.ts:673-697` 依赖它阻止 Linear reopen 后继续 teardown。现稿 `plan.md:98,116` 还残留 “authority check” 字样，内部也不一致。 |
| census 可复用现有 Chrome reaper 的 timer 和采样数据 | FEASIBLE, NOT AN ATOMIC SNAPSHOT | mount 是 `plugin.ts:7008-7068` 的单 timer/single-flight；`chrome-session-reaper.ts:153-267,492-508` 实际分别运行 comm、command/ppid、etime/lstart 三次 `ps` 再按 PID 拼接。可复用同一 sweep 的三张 map，但不能声称是一份原子 OS snapshot。 |
| census 目前能 fail-closed 区分坏传感器与空集合 | NOT SPECIFIED | primary `ps` 失败时现有 reaper直接返回空 result（`chrome-session-reaper.ts:492-502`）；age sensor 失败只进 `errors`（`:503-508`）。plan 的 JSONL schema 只有 `candidates`（`plan.md:279`），没有 `status/unknown/sensor_errors`；MCP classifier 的三态不能替代 Chrome census 自己的采样健康状态。 |
| census 的年龄门始终至少 30 分钟 | CONTRADICTED BY CURRENT MOUNT | `plugin.ts:7018-7025` 接受任何 `> 0` 的 `FLYWHEEL_CHROME_REAPER_ORPHAN_GRACE_MIN`；现稿同时写“≥ 30 分钟”与“沿用该 env”（`plan.md:277`）。若复用，census 要单独取 `max(30, configured)`，不能改变 legacy agent-browser 的值。 |
| `session_events` row 会自动进入 event-route / Discord relay | FALSE AS STATED | `StateStore.insertEvent()` 只 INSERT + save（`StateStore.ts:5584-5611`）。`event-route.ts:1168-1182` 是 HTTP ingest 自己插入后继续执行，Lead delivery 在同一请求流程的 `:2998-3159`；直接调用 `insertEvent` 不会回流 event-route。现有 Chrome reaper 已直接写 `chrome_session_reaped`（`chrome-session-reaper.ts:821-848,850-884`）而不触发该 relay。JSONL 仍是更清晰的 founder-red-line 边界，但理由应改成“独立、无消费者的度量账本”，而不是错误描述现有表。 |
| classifier 的 lexical/canonical `.bin` 规则符合本机真实包 | VERIFIED | 本机 `.bin/playwright-mcp` 是 package-local symlink `../@playwright/mcp/cli.js`，realpath 精确落到同包 `cli.js`；当前 cache 是 `@playwright/mcp@0.0.79`。因此 `plan.md:315-316` 的 lexical + `lstat` + canonical 规则正确。 |
| P0/P3 从同一个 classifier 实现执行 | PARTIAL | 单一 TS source 可以成立；P0 直接编译 import。P3 从 repo-local `dist` 动态 import 的模式确实存在于 `fly-1648-hot-loop-closeout.mjs:379-390`，但该模式只拒绝 missing dist，不拒绝 stale dist。TeamLead build 已生成 `dist/build-identity.json`（`packages/teamlead/package.json:44`），P3 应用它证明 artifact 与当前 HEAD 相符。Chrome census 本身不需要 MCP classifier。 |
| P3 的 mtime 门等价于被删掉的 inode generation fence | ONLY FOR TRUE DELETE + RECREATE | 上游 `createUserDataDir()` 对精确原名调用 recursive `mkdir`（本机 `coreBundle.js:72983-72989`）。目录真的被删除后再创建，新的根目录 mtime 会晚于 `reviewed_at`；但已存在目录被再次使用时 recursive `mkdir` 不换 inode，子目录内写入也不保证更新根 mtime。只读实测至少 5 个现存 profile 的最新嵌套项比根目录 mtime 晚 3–11,482 秒。故它可作“同名重建”窄门，不能声称证明“review 后未被再次使用”。 |
| 同根 dot-prefixed rename 不会被 `createUserDataDir` 主动选中 | VERIFIED | 上游只 join 精确的 `mcp-${browserToken}-${rootPathToken}`；它不枚举 cache root。成功的同根 rename 是原子的，若实际跨 device 则 rename 应以 `EXDEV` 失败而源目录不丢。 |
| quiet gate + `lsof +D` + rename 消除了所有 launch race | FALSE | quiet census/lsof 都只是瞬时读。进程可在 lsof 返回空后、rename 前打开源树；rename 打开的目录仍可成功。现稿 `plan.md:429,590` 的“结构上不可能”因此过强。另，本机无匹配的 `lsof +D` 正常返回 exit 1 + 空输出；仓库已有正确 fail-closed 判法见 `flywheel-log-janitor.sh:795-829`，新脚本应复用其语义。 |
| P3 不应挂现有 janitor | VERIFIED | janitor 的通用文件路径使用 `rm -f`，目录 release 路径另有专门递归探针；full dry-run scope 绑定脚本 SHA（`flywheel-log-janitor.sh:1005-1059`），apply 在失配时拒绝（`:1093-1095`）。独立 one-shot 脚本更窄。 |
| P1 settings landing spot 与 writer 防线有现实依据 | VERIFIED | 本机 settings 的 `env` 有 4 个既有 key，playwright 官方 identity 仍 enabled；`setup-mcp-on-demand.sh:21-68` 有拒 symlink/坏 JSON、按需 backup、保 mode、同目录替换和幂等模式。Lead launcher确实经 `env -i` 并显式传 HOME/可选 `CLAUDE_CONFIG_DIR`（`claude-lead.sh:1821-1889,1931-1932,2007`），所以让 Claude 从各自 config root 读 `env` 再用行为探针验收是合理的。 |
| P1 capability acceptance 可判定且不再依赖 argv/env 推断 | VERIFIED | `plan.md:231-248,457` 直接量目标 PID 的 layer-0 on-screen window 数，以 founder Chrome > 0 作同尺阳性对照，UA 只是佐证。`plan.md:460` 的“Chrome argv”磁盘普查行应收紧为 `comm + parsed --user-data-dir`，但它不是 P1 pass 判据。 |
| §11 准确记录 scope cut | MOSTLY | 六个 R14 交付物及其因果理由与 git diff 对得上，且没有必要恢复；但 `plan.md:643` 的“P0 一个字没松”被上述 authority-gate delta 反证。reopen 三条件公开了延期风险，不是 silent drop；不过“连续两周”需要 census coverage heartbeat 才可证明，第三条“不是短命 churn”还应给出数字阈值或明确由 operator sign-off。 |

## What's Good (Keep)

- 保持 R15 的 scope ruling：不恢复 supervisor、ownership shim、managed plugin cutover、activation/barrier、content hash 或自动 drain 工具。
- P0 的根因优先级、三态 probe、`pid+lstart+command`、23 秒整批上限和 `confirmedGone` 终态语义都应保留。
- P1 只设置 `PLAYWRIGHT_MCP_HEADLESS`，不碰 `PLAYWRIGHT_MCP_ISOLATED` 或官方插件 identity；runner / Lead / founder Terminal 三类都做真实能力验收。
- census 使用独立 JSONL ledger、只在现有 tick 上跑、不创建新 timer、不产生 `session_events` row、不接 notifier/Discord/publish-report 的方向正确。
- `ppid==1` 的版本边界、structured `comm + parsed user-data-dir`、不做 argv substring、无法归因默认保留都正确。
- P3 保持 one-shot、人工复核 manifest、只 rename 不 delete、同根 quarantine、观察期后才单独人工删除；不要重新挂 FLY-1330 janitor。
- `--isolated` 继续押后。它会改变 profile 根并让本期 census 失明，且优先级会遮住 extension 路径。

## Issues & Recommendations

1. **HIGH — R15 误删了既有 P0 lifecycle authority gate。**

   **Issue:** `plan.md:75,138` 现在只要求 exact identity + MCP classifier，并删除了 authority-loss TDD；但 current code 的 `authorityCheck` 是 close-runner 的既有 reopen fence，不是 R14 被裁掉的 activation authority。现稿随后仍要求“慢 authority check”纳入 5 秒预算（`:98,116`），形成自相矛盾。

   **Why it matters:** Linear reopen 可以在 16 秒轮询窗内发生。classifier 仍会正确判定目标是 MCP，却完全不能回答 teardown 是否仍获授权；若按现稿实现，reopen 后仍可能 TERM/KILL runner 的 MCP descendants，并让外层 sticky abort 失去内部信号边界保护。

   **Concrete fix:** 把 P0 KILL/TERM gate 写成合取：fresh exact identity + classifier match + **现有 caller-provided sticky lifecycle `authorityCheck`**。authority probe throw/false 都 sticky fail-closed；在每个 TERM、每个 KILL 前重验，并受所属阶段剩余预算限制。恢复“authority 在轮询中/多 PID 中途丢失 → 后续零信号、outer teardown blocked”的测试，同时保留 classifier 改判/PID reuse 的独立测试。§11 改成“未放松 P0，且明确保留既有 lifecycle authority；它与已删除的 P2 activation authority 无关”。

2. **HIGH — audit census 目前可以把传感器坏掉或没运行写成/解释成零残量。**

   **Issue:** JSONL 只有 candidates，没有 observation health；existing reaper 对 primary `ps` failure 返回空 result。候选集不变就永不追加，也无法证明所谓“连续两周”期间 Bridge/census 实际运行。30 分钟硬门又会被现有 env 降低。operator drain 的初次 TERM 前也没有要求紧邻信号做 fresh exact revalidation。

   **Why it matters:** census 是 scope cut 后决定是否永远不做 follow-up 的唯一数据面。坏尺子、停跑两周和真实零残量必须可区分；否则 scope cut 会从“数据驱动”退化成 silent drop。短 grace 还会把计划自己承认的正常 churn 计成孤儿。

   **Concrete fix:** ledger row 至少改成 `{observed_at,status:"ok"|"unknown",effective_grace_min,mcp_cache_versions,sensor_errors,candidates}`。comm/cmd/age 任一整批失败、候选缺 lstart/age、跨三张 map 无法一致拼接都写 `unknown`，绝不写 clean empty；unknown→ok/ok→unknown、候选集合变化、boot，以及低频 coverage heartbeat（例如每天一次）才追加，仍远低于 1 MB。census 的 effective grace 单独用 `max(30, configured)`，不改变 legacy path。把“三次 ps 拼接”称为同一 sweep sample，不称 atomic snapshot。`--once --print` 在 operator 的 TERM **和** KILL 前都 fresh re-read exact `pid+lstart+comm+parsed profile`；任何 mismatch/unknown 都不发信号。若版本只能读当前 cache，字段名必须明确是 `mcp_cache_versions[]`，不得暗示它证明了 orphan 的创建版本。reopen criterion 3 给出数字规则，或明确写 operator sign-off 而非机械 gate。

3. **HIGH — P3 的 pre-rename race 与最终删除门仍未 fail-closed。**

   **Issue:** quiet gate 和 pre-rename `lsof +D` 之间没有 lease。新 MCP 可以在最后一次 lsof 后打开旧 profile，随后目录被成功 rename 到 quarantine；因此 quarantine 可能正被活进程使用。观察期内若原名被重新创建，现稿承诺的“原样 rename 回去”还会因 destination exists 失败。七天后的手动 `rm -rf` 也没有要求重新跑 lsof/owner/root/symlink 检查。

   **Why it matters:** one-shot 并不会取消这个 TOCTOU；它可以打扰一个刚启动的 founder/runner 浏览器，后续人工 delete 还可能删除仍打开的树。`mtime` 只识别真正 delete+mkdir 的新根，不是 in-place reuse sensor。

   **Concrete fix:** 不恢复任何自动 barrier。把 P3 明确放进一个**人工维护窗**：停止 Bridge 的自动 launch surface、关闭/暂停 runner 和 Lead、协调 founder 在脚本结束前不启动 Claude；fresh quiet gate 只是验证该窗。每个成功 rename 后立刻对 quarantine 路径再跑一次递归 lsof：命中或 sensor error 时，若原路径仍 absent 就原子 rename 回去并记 `race_rolled_back`；若原路径已被新建则保留两边、记 `operator_required`，绝不声称可自动恢复。最终人工删除前再次验证 exact quarantine path、非 symlink、owner、ledger、`lsof +D` empty（按 rc=1 + empty stdout 才算空）；任一失败不删。把 §4/§9 的“结构上不可能”改成这个诚实边界。manifest mtime 可保留为窄的 recreated-path gate，但不要把它描述成 inode fence 的等价替代。

4. **MEDIUM — census 的“结构隔离”需要落到 capability/API，而当前 events-table 理由不实。**

   **Issue:** plan 一面说改 `chrome-session-reaper.ts`，一面说“census 模块”的静态 import guard；若 census 实际住在已有 reaper module，它天然与 `StateStore`、`signalProc`、`killProc` 同域，guard 会失去意义。单测注入 kill 函数再断言零调用，比根本不授予这些 capability 弱。另一方面，`session_events` 并没有 insert 后自动 relay 的通用消费者。

   **Why it matters:** founder 的红线应由最小可审 API 保证，而不是靠未来实现者记住“别把返回值喂给 kill loop”。错误的 StateStore 论证也会让后人误判现有架构。

   **Concrete fix:** 保持 JSONL，但把 audit census 放进独立模块；入口只接收只读 sweep sample、clock/version reader 和 append-only ledger writer，不接收 `store`、registry、notifier、`signalProc` 或 `killProc`。周期调用只拿到 summary/log line，不拿可复用的 kill candidates；`--once --print` 是单独的只读 presentation seam。静态测试应同时钉 imports、函数参数/返回类型和 plugin call site。把文案改成：JSONL 是特意与 session/event/Discord domain 分开的无消费者 ledger，而非声称任何 `insertEvent` 都会被 event-route relay。

5. **MEDIUM — “single implementation”还缺 built-dist freshness；classifier 也有可删的调用面/形状。**

   **Issue:** P3 `.mjs` 从 `dist` import 同一 source 的编译物，但 stale dist 仍可与当前 manifest/script 一起运行。`fly-1648` 只能证明该 pattern 存在，不能证明 artifact fresh。另，Chrome census 不需要 MCP classifier；当前官方插件只产生 npm/npx wrapper + node `.bin` inner，本机 symlink规则已覆盖。表中的“直接可执行 exact argv0 basename + realpath”没有生产 caller，也未定义 bare basename 如何按该进程的 PATH/cwd 做 canonical resolution。

   **Why it matters:** stale classifier 可把 P3 quiet gate 错读成 clean，正好破坏“同一实现”的安全声称；无用 shape 增加解析歧义和测试面。

   **Concrete fix:** P3/`--once` 在 import 前校验 `dist/build-identity.json.artifactBuildSha == git rev-parse HEAD`，missing/mismatch 时提示先 build 并 fail closed；不需要恢复 bundle installer/SHA receipt。把 caller 表改成 P0 + P3；P2 Chrome census 复用 Chrome parser/sweep health。删除 direct-executable shape，除非先指出真实 launch surface 和精确解析算法；保留并测试 npm、npx、`.bin`、canonical `cli.js` 四种实际/合理形状即可。

6. **LOW — P1 验收与 descope 记录只需两处收口。**

   **Issue:** capability gate本身已正确，但 §5 row 5 仍写“Chrome argv”，而 §5.1 的 stage-0 corpus/formula/产品上限没有出现在交付物清单。§11 的“P0 一个字没松”也不真实。

   **Why it matters:** 前者容易让实施者退回 raw substring inventory；后者会让 WebGL 硬门变成无人负责的前置。

   **Concrete fix:** row 5 明写 `comm + parsed --user-data-dir + exact lstart`，不写 raw argv reasoning。把 WebGL stage-0 artifact（corpus、ready signal、metric、固定 product ceiling、calibration/validation split）列为 P1 writer 部署前的 QA deliverable；无需新增生产模块。修正 §11 的 P0 authority 说明。P1 的 window count + positive control + session UA 保持不变。

## Deletion candidates

以下可以删，不会重开已关闭的洞：

1. 从 classifier caller 列表删除 **census**；Chrome orphan census 不需要识别 MCP server，P0/P3 才需要。
2. 删除没有生产 launch surface 的 **direct executable** classifier shape；若以后真实出现，再以现场 argv/comm/canonical 证据加回。
3. P1 writer 不必暴露三个同级公共模式。可收成 `apply` + receipt-aware `rollback`；`rollback` 内部在 SHA 相符时走 exact preimage fast path，否则只恢复该 key 的 preimage/fail closed。独立 `remove` 只在 preimage 本来 absent 时才是正确 rollback。
4. 删除“events 表会自动 Discord relay”和“半年必然 < 1 MB”两条不实/无证明的解释；用低频 health heartbeat 后直接给可计算上限。

不应删除：P0 classifier 本身（现有 reaper确实漏 inner）、P3 quiet gate、recursive lsof、human-reviewed manifest、same-root quarantine、P1 GPU/WebGL gate。被 R15 裁掉的六项里，没有一项需要恢复；真正误删的是既有 P0 lifecycle authority gate，而不是任何 P2 activation machinery。

## Verdict

CHANGES REQUESTED — address items above
