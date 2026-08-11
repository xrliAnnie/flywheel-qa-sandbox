# FLY-1671 独立重启器手动触发入口 — 实施计划

Issue: FLY-1671 (https://linear.app/geoforge3d/issue/FLY-1671/fix-给既有的独立重启器comflywheelupdater-fly-270加一个手动触发入口)
日期: 2026-08-11
基于: research.md
版本: 暂定 v1.58.0(ship 取空号)
状态: codex-approved(design review 3 轮:R1 9 项 + R2 6 项全折入,R3 APPROVED;R3 两条非阻塞 guardrail 已并入 Change A/G)

## 0. 一句话

复用 FLY-270 既有的 self-ship 队列 + updater,新增一个薄入口脚本把「手动全量重启」入队(target = origin/main 当前 SHA),由站在被重启集合之外的 updater 执行 `restart-services.sh`;同时把「本体新建/接管」按 **carrier 感知的证据链**观测进重启播报(最低要求),修正既有播报的假断言,并把护栏 hook + 纪律文档一起改到位。

## 1. 设计不变量

- I1 发起者在集合外:updater(launchd 任务)不在 restart-services.sh 的重启对象里 ⇒ 无任何 Lead 需要豁免
- I2 有 due marker 必重启:`process_due_markers` 先无条件 deploy 再 ack(承重事实 A)
- I3 无新代码也重启:restart-services.sh 在 `DEPLOYED_SHA == CURRENT_HEAD` 时跳 build 继续全量重启(承重事实 C)
- I4 零 schema 变化:manual marker 就是普通 schema-v2 marker(targetSha = origin/main),`ssq_*` 全链原样
- I5 fail-close 全继承:委托 `self-ship-restart.sh`(updater 未 loaded / kickstart 失败 → rc 69,拒绝假报;kickstart 失败时已入队 marker **保留**,不静默丢弃)
- I6 FLY-1634 边界不破:body 新旧只做**观测**,永不参与 deploy 成功判定;观测超时/缺失一律记 `未知`
- I7 部署账本不被污染(R1#5):`deployment_events` 是「已上线 issue」的 source of truth(digest 按它数 shipped);手动重启 marker **不产生** deployment event

## 2. 生产 carrier 现实(R1#1 + R2#1 确立的约束)

本机 15 个生产重启候选 = **14 个 v2 carrier** + **1 个 Mufasa codex TUI wrapper**(`flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh`,不经 `claude-lead.sh`)。此前草案引用的 `LEAD_BODY_PROVENANCE` 三个写点(~1900/~1922/~2657)属于 **legacy 共享-tmux/adoption 路径**,v2 不经过。

**v2 进程拓扑(R2#1 实证)**:launchd job 进程 = `flywheel-lead-wrapper-v2.sh` 在 line 238 `exec env -i ... tmux -D -S <socket>` 变成的**前台 tmux server**;body(claude 子进程)跑在该 server 的 pane 里,链路 `--publish-and-start` → `lead-body.sh` → source `claude-lead.sh`(v2 spawn 点 ~3104)。⇒ body 侧的 `$$` 是 pane/body shell PID,**不是** `restart-services.sh` 验证的 launchd PID(前台 tmux server)—— carrier 身份必须由 wrapper 显式**传递**进 body,不能在 body 里自取。

body 证据按 carrier 分别定义:

| carrier | 证据产者 | v1 交付 |
| -- | -- | -- |
| v2(14 个) | claude-lead.sh 在 v2 子进程 spawn 成功后写 `launched` 证据 | ✅ 权威覆盖 |
| legacy(0 个在产,路径仍在) | 既有三个 `LEAD_BODY_PROVENANCE` 终定点写 `adopted|launched` | ✅ 保留 |
| Mufasa codex wrapper(1 个) | **无产者,显式接受 `unknown`**(诚实边界;QA 直测其本体新旧) | ⚠️ 记 `未知` |

## 3. 改动清单(7 项)

### Change A — body-evidence 可 source 库 `scripts/lib/lead-body-evidence.sh`(新文件,~60 行)

`claude-lead.sh` 是可执行 supervisor,不能安全 source 进单测(R1#1)⇒ writer/reader 放独立库:

- `lbe_record <project> <lead> <provenance> <bodyPid> <bodyStart> <carrierPid> <carrierStart>`:原子写(tmp+mv,0600)`~/.flywheel/state/lead-body-evidence/<project>-<lead>.json`,含 `ts`
- `lbe_read_matching <project> <lead> <carrierPid> <carrierStart>`:读证据并要求 **carrier tuple 精确匹配**才返回 provenance;不匹配/缺失/损坏 → 空(= 未知)。时间戳新鲜度**不作**身份判据(R1#2:同秒 stale 记录会误配)
- best-effort 铁律:写失败只 log,绝不影响 Lead 启动(调用侧 `|| true`);**库缺失/损坏时 source 与调用全部非致命**(guarded source,`set -e` 下绝不终止 claude-lead.sh → 观测退化为 unknown,R2#3)
- **打包闭包**(R2#3):新库必须进 `package-onboard.sh` 的 `PO_SCRIPT_FILES`、`scripts/package-onboard-files.allow`、packaged-path 审计与 `package-onboard-smoke.test.sh` —— 否则 packaged Lead 启动会因缺文件受影响

调用点接线:
1. **carrier 身份传递**(R2#1):wrapper-v2 在 exec 前把自身 `$$` + start identity 以不可变 env(`FLYWHEEL_LEAD_CARRIER_PID/START`)注入 SERVER_ENV 传给 body 链(wrapper 已把 server PID 发布进 manifest,env 传递取其更明确);body 侧 evidence 写的 carrier tuple **只用传递值,不自取 `$$`**。**R3 guardrail#1**:`lead-body.sh:16-24` 会 source 宿主 `.env` —— 必须在 source **之前**把传递值捕获进私有变量并校验(畸形 PID/start → unknown),之后只用捕获值;测试证明 `.env` 冲突项覆盖不了 handoff tuple
2. **v2**:`claude-lead.sh` v2 spawn 成功、`CLAUDE_CHILD_PID` 确立后写 `launched`(carrier tuple = 传递的 launchd/前台 tmux server 身份)。集成断言:**body shell PID ≠ carrier PID 且 evidence 仍精确匹配 `VERIFIED_LEAD_PID/START`**
3. **legacy**:三个 `LEAD_BODY_PROVENANCE` 终定点各接一笔(`adopted|launched`)
4. **Mufasa wrapper**:不接(v1 显式 unknown;后续单独立单补产者)

### Change B — restart-services.sh 波次留痕 + 观测聚合(~50 行)

- R1#3:成功 Lead 的 key + **verified carrier tuple**(v2 路径的 `VERIFIED_LEAD_PID` + start identity)目前不留档(sidecar 只记 failed/skipped)⇒ 波次里为每个成功候选追加一行到 run-local 观测文件(mktemp,与既有 `LEAD_RESTART_NAMES_FILE` 模式一致);**stdout 合同 `skipped:N failed:M total:K` 原样不动**
- 播报前聚合:逐成功 key 调 `lbe_read_matching`(tuple 精确匹配);允许一次**有界、只观测**的短等待(总额 ≤10s,覆盖「carrier 验证先于证据发布」的窗口,R1#2);超时/不匹配 → `unknown`,绝不影响 verdict;**绝不为找 body PID 改重启 verdict 逻辑**(R2#1 尾注)
- 计数 `body_new / body_adopted / body_unknown`,传给渲染器

### Change C — 播报修正:先拆假断言,再加「本体」行(restart-notify.sh ~25 行)

- R1#4:现行 clean 文案「新本体已起、model 一致」(restart-notify.sh:195)是**成功合同并未建立的断言** —— 改为诚实的 carrier 收敛措辞:`Lead: N/N supervisor 换代收敛(body 见『本体』行;未单独探测 Discord 可达性)`
- `rn_render_completion_message` 加 3 个位置参数(16-18),独立观测行:
  - 全新:`本体: 14 新建 / 1 未知`
  - 有接管:`⚠️ 本体: 13 新建 / 1 接管(未换) / 1 未知`
- 入参防御:**前提 `lead_result_state == known` 且 `lead_total > 0`**(R2#5:wave_not_run/unreadable/零候选时 `0/0/0` 会假过「和==成功数」检查 → 必须整行降级),再加三数非负整数且 **和 == 成功 Lead 数**;任一不满足 → `本体: 观测失败(未知)` —— 不渲染不可能算术
- 回归:新参数任意取值**不改变**顶层 ✅/⚠️ 判定(I6);补 wave_not_run / unreadable / 零候选三态用例

### Change D — 手动 marker 不进部署账本(update-flywheel.sh ~10 行)

- R1#5:`report_deployment` 对每个 satisfied marker 上报 `flywheel-comm report-deployed` → `deployment_events`(digest 数 shipped 的账本,dedup 仅按 mergeSha)。手动 marker 带 `manual-restart` 标签会伪造 shipped 条目/污染归因
- 修法:marker **既无 PR 也无 issue** → 跳过 `report_deployment`(log:`marker <name> has no PR/issue identity — restart-only marker, skipping deployment event; acking`),照常 ack。审计靠 updater log + founder 播报(reason=updater),不靠部署账本
- `request-restart.sh` **不提供 `--issue`**(v1 移除:任何标签都会被账本误读;真有 issue 驱动的重启也不该记成 shipped)

### Change E — 新入口 `scripts/request-restart.sh`(新文件,~70 行,chmod +x)

```bash
用法: request-restart.sh [--dry-run]
```

1. `git ls-remote origin refs/heads/main` 取远端 SHA —— **不 fetch、不动生产 checkout/ref**(R1#6:updater 视 checkout 为 single-writer)。解析必须命中**恰好一行** `<40hex>\trefs/heads/main`(R2#6:ls-remote 可能 exit 0 但零匹配);空/多行/畸形输出与命令失败一样走回退:WARNING + 本地 `origin/main` ref(`git rev-parse`,40-hex 校验;ff-only 历史保证可 ack)—— **绝不把畸形输出漏成子脚本 rc 64**
2. **调用**(非 exec)`self-ship-restart.sh --target-sha <sha> [--dry-run]`,透传退出码(R1#6)
3. 成功输出**区分两件事**:「已受理入队」(marker 路径)vs「重启完成」(不承诺时限 —— updater 空闲时 ≤60s rescan 接手;在锁内/部署中则排队之后处理;完成以 `/tmp/flywheel-updater.log` + founder 播报 reason=updater 为准)
4. dry-run 语义(R2#6 措辞):**不写 repo、不写队列、不写任何 Flywheel 状态**(网络传输/credential helper 的落盘不在脚本承诺范围)
5. 不加新权限闸(与 self-ship-restart.sh 同级);授权语义由 founder-only-authority 合同约束(触发前须 founder 拍板)

另:`default_deploy` 加 `--reason updater`(1 行)—— updater 发起的重启(self-ship / manual / calendar)播报统一 `reason=updater`,与 Lead 手跑区分;拒绝 per-marker reason(一次 deploy 可满足多 marker,无法唯一归因)

### Change G — Bootstrap Phase 0:复活生产 updater(R2#2,founder-gated 前置)

**实证现状(2026-08-11)**:`launchctl print gui/501/com.flywheel.updater` → rc 113(job **未 loaded**);已安装 plist 是 7 月 5 日的 918-byte 旧版,**没有 `QueueDirectories`**,与仓库版不一致。⇒ 不复活 updater,本单入口第一步就 fail-close(rc 69),self-ship marker 现在也在 rot —— 这是恢复 FLY-270 既有件,不是建新件,但**不能从验收路径里省略**:

1. **前证**:pending 队列为空,或逐 marker 给出去向交代(不许带着未知账 bootstrap);替换前 `plutil` 校验仓库版 plist + 核对 program/queue 合同(R3 guardrail#2)
2. 原子安装仓库版 plist(旧版备份用**唯一名** `.bak-pre-fly1671-<ts>`)→ bootstrap 前**再核一次** pending 队列 → `launchctl bootstrap gui/<uid>`
3. **后证**:job loaded;`QueueDirectories` 路径逐字 == `~/.flywheel/self-ship-pending.d`;ProgramArguments 指向主仓 `scripts/update-flywheel.sh`;**非破坏性 kickstart 被接受**(R3 guardrail#2)
4. 回滚口径:bootout → 还原备份 → bootstrap(只拷回 `.bak` 不等于还原 launchd 运行态)
5. 时机:founder 拍板的运维窗口执行(与代码 merge 解耦;可先于 merge)

### Change F — 护栏 hook + 纪律文档(R1#7)

1. `scripts/hooks/flywheel-restart-guard.py` `DENY_REASON`/`BYPASS_FAIL_REASON`:默认入口改为 `request-restart.sh`(founder 拍板后),`restart-services.sh` 直跑降级为**显式紧急路径**;**同步改其测试断言**
2. `doc/engineer/implementation/restart-guard.md`:同口径修正(line 50「唯一受控入口」措辞)
3. `doc/engineer/implementation/bridge-ship-discipline.md`:**明确取代**(不是追加)line 17-23 的旧手动 kill 流程 —— 与既有 guard 本就冲突,借本单一并纠正
4. Lead 侧流程:统一重启 = `request-restart.sh` + 告知 founder;紧急兜底保留(其发起 Lead 可能被接管,『本体』行会暴露)

## 4. 实施顺序(R1#9)

1. 先定合同:manual-marker 账本语义(Change D)+ carrier 证据合同(§2 表,含 R2#1 身份传递)—— 两者是其余改动的前提
2. RED:全部失败测试先行(见 §5)
3. Change A(证据库 + 打包闭包)+ Change B(tuple 留痕/聚合)
4. Change C(拆假断言 + 观测行)
5. Change E(入口 + reason)
6. Change F(guard/docs)+ CI 接线(§5)
7. Change G(updater 复活)与代码线解耦,founder 拍板的运维窗口独立执行(可先行);验收 §6 以它为前置

> 顺序含义:不先把「报告必须诚实」做实,就不该先发一个「报告明知是盲的」入口。

## 5. TDD(先测后码)+ CI 接线

| 测试 | 文件 | 断言 |
| -- | -- | -- |
| 证据库 | 新 `scripts/__tests__/lead-body-evidence.test.sh` | 原子写/0600/形状;tuple 不匹配 → 空;同秒 stale 记录不误配(R1#2 回归);写失败不影响调用方 rc;**库缺失时 guarded source 非致命**(R2#3) |
| v2 接线 | 扩 lead 相关 harness | carrier tuple 经 env 传递;**集成断言 body shell PID ≠ carrier PID 且 evidence 精确匹配 `VERIFIED_LEAD_PID/START`**(R2#1);legacy 三点各落 `adopted|launched`;**Mufasa/未知 carrier → unknown**(R1#8 carrier 矩阵) |
| 打包闭包 | 扩 `package-onboard-smoke.test.sh` + 路径审计 | 新库进 `PO_SCRIPT_FILES`/allowlist;packaged 树上 guarded source 不炸(R2#3) |
| 波次留痕 | 扩 restart harness | 成功 key+tuple 入观测文件;stdout 合同逐字不变 |
| 播报 | 扩 `restart-services-notify.test.sh` | 假断言文案已移除;三态渲染;**和≠成功数 → 整行降级**;**wave_not_run / unreadable / 零候选 → 整行降级**(R2#5);新参数不影响顶层判定(I6 回归) |
| 账本 | 扩 `self-ship-queue.test.sh`/updater 用例 | 无 PR/issue marker → **零 report-deployed 调用** + 照常 ack + 指定 log 行(R1#5) |
| 入口 happy path | 新 `scripts/__tests__/request-restart.test.sh` | marker 落盘、targetSha == 桩 ls-remote SHA、kickstart 被调(注入 `SELF_SHIP_LAUNCHCTL`) |
| ls-remote 失败/畸形 | 同上 | 命令失败、零匹配、多行、畸形行**四种**都走回退(R2#6),WARNING + 本地 origin/main ref |
| updater 未 loaded | 同上 | rc 69、pending dir 零残留 |
| **kickstart 失败** | 同上 | rc 69 **且已入队 marker 仍在 pending dir**(R1#6 补漏) |
| dry-run | 同上 | 真正零写盘(含无 fetch)、打印计划 |
| reason | 新聚焦断言 | `default_deploy` 命令行**含** `--reason updater`(现 `restart-self-detach.test.sh:85-89` 前缀正则证明不了存在性,R1#8) |
| guard hook | 扩既有 guard 测试 | 新 DENY 文案指向 request-restart.sh;紧急路径仍放行 restart-services.sh |

CI:`.github/workflows/ci.yml` **显式枚举** shell 测试(不会自动发现)⇒ 新增的 3 个 `.test.sh` 逐一接进 Script Tests job + CI structure sentinel(若约定保留)(R1#8)。全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 全部 shell 测试。

## 6. 验收(真机,post-merge,founder-gated ship 窗)

0. **前置 = Change G 完成**(R2#2):生产 updater 已按仓库版 plist 重装 + bootstrap,后证三条全过。旧口径「无需重装/重启任何服务」**作废** —— 舰队服务确实不用动,但 updater job 本身必须先复活
1. merge + 主仓 `git pull`(此后 updater 每次触发跑的即新脚本)
2. **before 基线**:独立 QA 先记录 15 个 Lead 本体启动时间(不由部署者自报 —— FLY-220 教训)
3. founder 拍板后,从 Lead pane 跑 `scripts/request-restart.sh`
4. `/tmp/flywheel-updater.log` 出现 marker 接手 + deploy;founder 播报 `reason=updater`
5. **15/15 生产 Lead 本体启动时间全部晚于 enqueue 时刻(含原发起 Lead flywheel-eng-lead)** —— issue 验收原文,QA 直测(播报行不是唯一 oracle)
6. 播报含 `本体: 14 新建 / 1 未知`(Mufasa 无产者,QA 直测其新旧)+ Lead 行新措辞
7. marker 已 ack 清除
8. **账本断言分两层**(R2#4:第一次重启恰好收敛 FLY-1671 自身 merge,`record_deployed_range` 合法产生 fallback 行,不能一刀断零):
   a. 任何时刻:**无 `manual-restart` 合成行、无 marker 驱动的 report 调用**(Change D 反证)
   b. 证明 `origin/main == HEAD == deployed-sha` 后,先取账本基线,再跑**第二次纯手动重启**(无新代码)→ `deployment_events` **零新增行**;合法收敛提交的上报保持原样

## 7. 风险与回退

| 风险 | 缓解/回退 |
| -- | -- |
| deploy deterministic 失败 | 既有退避 5 次 → block + severe_alert 直达 founder;不 hot-loop |
| 证据发布晚于 carrier 验证 | 有界只观测等待(≤10s)→ 超时记未知;验收靠 QA 直测 |
| 播报文本变化惊扰测试 | 全部先扩测试再改码;渲染失败有既有 fallback + meta_alert |
| guard hook 文案改动 | 与测试同 PR 原子更新;bypass 语义不动 |
| updater 复活撞上在途 marker | Change G 前证:队列空或逐 marker 交代去向 |
| packaged 树缺证据库 | 打包闭包 + guarded source 双保险(R2#3) |
| 回退 | 7 项改动无 schema/状态迁移;A/B/C 一组(观测链)、D/E/F 各自独立、G 是运维操作(.bak 可回滚),可分组 revert |

## 8. 诚实边界(这个设计不做什么)

- 不提供「重启但保持旧代码」:手动重启 = 收敛部署 origin/main + 全量重启(收敛语义)
- 不改 adoption/收养判据(FLY-1659/1663 边界):发起者分叉靠移出集合消失
- **Mufasa(codex wrapper)v1 无 body 证据产者**:播报记 `未知`,新旧由 QA 直测;补产者另立单
- 不做 per-marker reason / 不给手动重启造 deployment event(账本语义保护,I7)
- 不动 Runner self-ship 流程(spin.md / orchestrator.md 原样)
- 紧急兜底保留:Lead 直跑 restart-services.sh 仍可用,发起者可能被接管 —— 播报『本体』行会如实暴露
- 本设计节点不实施:实施/QA/ship 由 DAG 后继节点承接
