# FLY-1188 M4 T-2 代价链重估 — remote-control daemon 驱动常驻 /goal TUI

Issue: FLY-1188 (URL 不可得,只写 issue 号)
日期: 2026-07-12
基于: 同文件夹 research.md(TUI /goal 实测修正)+ plan.md §6(原 exec-cycle dispatcher 方案,本文评估其替代)

## 0. 结论(一句话)

**T-2 的代价链已经被 infra-bot 先例吃掉了大头**:`codex app-server --remote-control` daemon + WS 机器客户端 + cmux TUI 人类客户端这套三件套在 codex-infra-bot-lead 上已生产运行 2 天(launchd 管 daemon,`codex-lead-tui-runtime.js` 是机器侧),M4 不需要从零造 daemon 层——**复用 `packages/teamlead/src/lead-backends/codex/` 的 6 个传输/生命周期组件,新写的只有 runner 语义层(一个 `codex-runner-tui-runtime` 变体)**。原 plan §6 的 exec-cycle dispatcher(completion signal / parked 状态机 / auto-continue 三件套)整体作废,被原生 /goal + daemon 常驻取代。

## 1. infra-bot 先例盘点(什么可以直接抄)

生产实证(2026-07-12 实查):
- daemon:`codex app-server --remote-control --listen unix://…`(PID 92604,launchd 直管,`CODEX_HOME=~/.codex-infra-bot`,RSS ~90MB)
- 机器客户端:`codex-lead-tui-runtime.js`(PID 92526,node sidecar,RSS ~54MB)
- 人类客户端:founder 在 cmux 窗口 `codex resume --remote` 挂同一 thread——**这正是 Annie 要的「cmux 能看它跑」**,不是快照渲染,是真 TUI

直接复用(零改或参数化即可):
| 组件 | 作用 | 复用度 |
|------|------|--------|
| `daemon-ws.ts` (connectDaemonWs) | 连 daemon 的 unix socket WS | 直接用 |
| `WsTransport.ts` | WS 消息传输层 | 直接用 |
| `DaemonConnectionSupervisor.ts` | daemon 死亡重连 + generation fencing(防旧代残留双写) | 直接用 |
| `CodexLeadProcess.ts` | 进程外壳(turn 提交/事件流) | 直接用 |
| `TurnDemux.ts` | 人类 turn(founder TUI)与机器 turn 分流 | 直接用 |
| `tui-window.ts` (ensureTuiWindow/killTuiWindow) | cmux 窗口开/关/存活检查 | 参数化窗名(FLY-272 的 Linear identifier 命名) |

**新写**(runner 语义,不在先例里):
1. `codex-runner-tui-runtime`(或 CodexTmuxAdapter 的 daemon 模式):把现 exec-cycle 的「组 prompt → spawn codex exec → 等退出」换成「起/复用 daemon → WS 提交 goal-turn → 订阅事件流」。
2. goal 驱动块:dispatch 时提交一条含 `/goal <issue 目标 + pipeline 合同>` 的 turn;Lead wake/QA-fix 时提交后续 turn(替代现在的 mailbox→重启 exec 循环)。
3. 生命周期收口:issue 终态(complete 事件)→ 停 daemon + 关 cmux 窗(接现有 close-runner)。

## 2. runner 与 Lead 形态的差异(为什么不是照抄完事)

| 维度 | infra-bot Lead | codex runner (M4) |
|------|---------------|-------------------|
| 驱动源 | Discord 消息(RestPoll 入站) | dispatcher 起单 + mailbox wake + gate 答复 |
| 会话寿命 | 无限(常驻服务) | 一个 issue 的生命周期,终态即回收 |
| 自主推进 | 无(一问一答) | **原生 /goal**(实测:跨轮自动续跑 + evidence-based 完成判定) |
| 沙箱 | full-access(FLY-350)/confined | 维持现 M1 的 workspace-write + worktree writable roots(约束经 config.toml/thread params 下发,待验证项 V3) |
| 数量 | 每 Lead 1 个 | 并发 runner 数个 → 资源需管理(见 §3 成本) |

## 3. T-2 代价链重估(原否决理由逐条对账)

设计期给 T-2 记的代价 vs 现在:

1. **「per-runner daemon 是新增基础设施」** → 大头没了。daemon 拉起 = 一条 spawn(同 infra-bot launchd 形态,但 runner 由 adapter 管生命周期而非 launchd);传输/重连/fencing 全是现成模块。估算净新代码 ≈ 1 个 runtime 组装文件 + adapter 改造,不是原估的「一套新 daemon 层」。
2. **「进程级 429 轮换丢失」**:exec-cycle 里换账号 = 下一轮换 CODEX_HOME;常驻下 = supervisor 检测 daemon 退出/auth 失败 → 换 CODEX_HOME 重启 daemon → `codex resume <thread>` 续同一 thread(thread 落盘,跨 daemon 存活)。丢失面 = 正在跑的那一个 turn(/goal 会按 evidence 重续)。**代价从「机制缺失」降级为「单 turn 重试」**,且 DaemonConnectionSupervisor 的重连骨架就是干这个的。
3. **资源**:每 runner 常驻 ≈ 145MB(daemon 90 + sidecar 55,infra-bot 实测)。10 并发 ≈ 1.5GB —— 本机有 OOM 前科(7-10 事故),缓解:①runner 终态立即回收 daemon(不同于 Lead 的永驻);②dispatcher 并发上限现有机制不变。列为验收观察项。
4. **founder 可视**:先例已证 `codex resume --remote` 双客户端共享 thread,cmux 真 TUI。M3 的 CodexJsonlRenderer(pane 渲染)在 daemon 形态下降级为兜底(TUI 本体就是可视),保留不删(exec-cycle 回退路径还在用)。

## 4. 与已交付里程碑的衔接(什么保留、什么作废)

- **保留原样**:M1(判别/sandbox/send 路由)、M2(契约/AGENTS.md——§5 待验证项 V4 过后改「exit 是 pause point」等 exec-cycle 表述为常驻表述,文字改动)、M3(渲染,降级为兜底)、M5 §7.1/7.2/7.3(review 协议形态无关,gate --no-block + request-review 在常驻形态下由 goal-turn 内执行,等待答复 = thread 内等 mailbox/gate 响应,机制不变)。
- **作废**:plan §6 全部(6.1 completion signal 重写 / 6.2 parked 状态机 / 6.3 codex-session-reconciler / 6.4 auto-continue)——这四件就是在 exec-cycle 上模拟「常驻」,原生常驻后没有存在理由。M4 改动面 = adapter daemon 模式 + goal 驱动块 + 生命周期收口 + §6 计划替换文。

## 5. 529 验证前的待验证项(硬前置,验绿才铺全队)

- **V1(已在协议层证实,2026-07-12 补充)**:app-server 协议 v2 暴露**一等 Goal API**——RPC `thread/goal/set`(参数 `{threadId, objective, status, tokenBudget}`,status 枚举 `active|paused|blocked|usageLimited|budgetLimited|complete`)、`thread/goal/get`、`thread/goal/clear`,外加 `ThreadGoalUpdatedNotification`/`ThreadGoalClearedNotification` 服务端通知(实测自 codex-cli 0.144.1 `app-server generate-json-schema` 输出)。/goal 不是 TUI 层解析,是协议面:WS 机器客户端可直接 set objective+tokenBudget,完成/暂停/限流状态经通知流回——**这比预想更好:M4 连「模拟 /goal 输入」都不需要,直接调 RPC**。529 只剩行为验证(set 后 goal 是否真自动跨轮续跑、complete 通知是否可靠触发)。
- **V2**:daemon 崩溃/换号后 `codex resume <thread>` 的 goal 是否延续(goal 状态在 thread 里还是 TUI 进程里)。
- **V3**:runner 沙箱(workspace-write + worktree roots)在 app-server 形态下的下发方式(infra-bot 是 full-access/confined 两档,runner 档要单验)。
- **V4**:M2 契约文本在常驻形态下的改写(exit≠pause point 了)。
- **V5**:cmux 可视 = founder 在窗口里看到 goal 连续推进(Annie 验收项原话)。

## 5.0 验证结果(2026-07-12,单 runner 隔离,全 PASS)

隔离环境:独立 CODEX_HOME(复制 auth)+ 短路径 unix socket(SUN_LEN 限制,scratchpad 长路径不可用)+ 独立 workdir;codex-cli 0.144.1;探针脚本 = raw JSON-RPC over ws+unix(perMessageDeflate 关,daemon-ws 先例)。

- **V1 PASS(两轮,第二轮严格判定)**:`thread/goal/set {objective, status:active, tokenBudget:200k}` + 1 个 kick turn → daemon **自动续跑 3 个 turn**(3 个不同 turnId),5 个目标文件全部正确;goal 通知流实时回流(15 条,tokensUsed 逐条递增 7218→35159);**goal status 真实 active→complete 转换**(严格解析 `goal.status === "complete"`,objective 措辞已排除字符串误配)。第一轮的判定曾被 objective 文本里的 "complete" 字样误触——第二轮修正后无歧义。
- **V2 PASS**:SIGTERM 杀 daemon → 起全新 daemon 进程 → `thread/resume <threadId>` 成功,`thread/goal/get` 返回完整 goal(status=complete、tokensUsed=35159、objective 逐字)——**goal 随 thread 落盘,daemon 重启/换号路径成立**。
- **V3 PASS(修正测法后)**:`thread/start {sandbox:"workspace-write", approvalPolicy:"never", cwd}` → cwd 内写成功,**HOME 下逃逸写被 seatbelt 拒**(文件不存在 + agent 自报 blocked)。注意默认 `excludeSlashTmp:false`(/tmp 在 workspace-write 默认白名单——与现 exec-cycle M1 行为一致,非回归;第一轮 V3 把逃逸目标误选在 /tmp 里得了个假 FAIL)。runner 生产形态的 writableRoots 增补(linked worktree git metadata,M1 同款需求)经 per-runner config.toml 下发,M4 实现项。

## 5.1 顺手记录(Lead 指示,本单不做)

Goal status 枚举里的 **usageLimited / budgetLimited 是协议级配额信号**——Codex runner 撞限流时不再需要刮 pane 识别,协议通知直接给出。这是 FLY-1182(quota 检测)Codex 侧的天然接口,**1182-Codex 侧未来可吃这个信号**;本单(FLY-1188)不实现。

## 6. 给 Lead 的问题(如有)

无阻塞问题。若你对 §3-3 资源缓解(终态回收)或 §5-V1 的备选路线有偏好,我在 529 验证时按你的意见排优先级;否则按本文顺序执行:V1→V2→V3 单 runner 隔离验证 → M4 实现 → V5 验收。
