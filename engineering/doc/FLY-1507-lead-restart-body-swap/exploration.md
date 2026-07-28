# FLY-1507 restart 换管家不换真身 — 探索

Issue: FLY-1507 (https://linear.app/geoforge3d/issue/FLY-1507/基建卡点-restart-换管家不换真身-孤儿-lead-本体被收养旧-modelopus-4-8-永不落地)
日期: 2026-07-27
基于: 无

## 一句话问题

`restart-services.sh` 重启 Lead 时只换掉 supervisor(claude-lead.sh 管家进程),不换 tmux 窗口里的 claude 本体;当本体已是孤儿(前代 supervisor 死时没带走它),新 supervisor 会永久 hold 旁观,验证器却把孤儿窗口判为"重启成功"——于是 FLY-1496 已根治的模型解析永远轮不到执行,老本体冻结的 `--model claude-opus-4-8[1m]` 永不落地。

## 实锤证据(2026-07-27 本机采集,代码 + 活体双向印证)

### 活体证据(17:00 前后 ps 快照)

冻结孤儿本体(出生 7/22-7/25,全部 ppid=5952 即 tmux server,supervisor 早死):

| Lead | 本体 PID | 出生 | 冻结的 --model |
|------|---------|------|----------------|
| joycon-lead | 98252 | 7/23 06:11 | `claude-opus-4-8[1m]` |
| ops-lead (geoforge3d) | 62473 | 7/25 00:00 | `claude-opus-4-8[1m]` |
| cos-lead (geoforge3d) | 1745 | 7/24 23:59 | `claude-opus-4-8[1m]` |
| product-lead (geoforge3d) | 36568 | 7/25 00:02 | `claude-opus-4-8[1m]` |
| flywheel-product-lead | 57594 | 7/24 23:58 | `claude-opus-4-8[1m]` |
| flywheel-cos-lead | 60964 | 7/24 23:56 | `claude-opus-4-8[1m]` |
| sub-lead | 46844 | 7/25 00:08 | `claude-opus-4-8[1m]` |
| tidal-echo-content-lead | 15465 | 7/25 00:10 | `claude-opus-4-8[1m]` |
| reflection-lead | 2622 | 7/22 09:52 | `sonnet`(旧拼写,pre-FLY-1496) |

同时这些 Lead 的 supervisor 全部是**今天 16:3x 新生**(ppid=1, launchd 管):新管家 + 旧真身组合坐实。对照组:本次重启真换过身的 Lead(claude-infra-bot 16:31 / flywheel-eng 16:32 / rafiki 16:37 / belle 16:39 / tidal-echo-cos 16:41)模型全对(sonnet-5 / fable-5)。

关键旁证:ops-lead 本体挂载的 rules-bundle 文件名 `geoforge3d-ops-lead.41933-lstart-...` 内嵌 supervisor PID **41933**(已死),而现任 supervisor 是 90497 —— 本体属于死掉的前代。

### supervisor 现场状态(卡在哪一层)

`/tmp/flywheel-lead-geoforge3d-ops-lead.log` 尾部:每 30 秒一条

```
[lead] 16:50:57 Lead identity HOLD (denied_holder_alive); retrying in 30s
```

新 supervisor 卡在 **FLY-1309 identity lease** 这一层(见下),连 tmux takeover 守卫都没走到。同时 `lead_dual_active` 告警在持续发但被 receipt 去重成背景噪音。

### tmux archive 现场

`~/.flywheel/pids/geoforge3d-ops-lead.claude.tmux` 内容 `5952 62473 Sat Jul 25 00:00:57 2026 @2223`:archive 指认孤儿本体(62473)就在窗口 @2223,server 5952(7/20 出生,跨越所有重启同一代)。`tmux list-windows` 确认 @2223 pane_pid=62473 pane_dead=0。

## 机制拆解(逐条验证 issue 的三个候选机制)

### 候选 1:停止路径只杀 supervisor — 证实

`scripts/restart-services.sh` `restart_lead()`(约 974-1003 行):从 pidfile 读 supervisor PID,`kill -TERM`,等 ≤60s。**从头到尾没有任何代码定位或终结 claude 本体**。本体之死完全依赖 supervisor 的 `cleanup()` trap(claude-lead.sh 2003-2061:C-c → 等 5s → kill-window)。两个漏洞:

- supervisor 早已死(pidfile 指向尸体)→ `kill -0` 失败 → 直接跳过,本体没人碰;
- 现任 supervisor 处于 hold(从未 launch,`LEAD_WINDOW_ID` 为空)→ cleanup 对窗口无操作 → 本体没人碰。

### 候选 2:"收养"路径 — 修正后证实(不是收养,是永久 hold 旁观)

审计修正 issue 假设:新 supervisor **并不接管**旧本体(不 attach、不管理),而是被三层相互独立的 fail-closed 守卫拦在 launch 之前、进入无限 hold 循环(30s 退避重试),同时孤儿继续服务:

1. **FLY-1309 identity lease**(`packages/flywheel-comm/src/lead-lease.ts:350-378`):`bind()` 在 launch 时把 lease holder 改写为 **pane 本体的 pid+lstart**(419-441 行)。孤儿活着 → 每次 `acquire` 返回 `denied_holder_alive` → hold。**这是现场实际卡住的层。**
2. **FLY-1285 tmux takeover 守卫**(claude-lead.sh `_prepare_lead_launch` 1439-1486):archive 里的本体活着且 `TMUX_RELAUNCH_PROVEN=0`(新 supervisor 初始态)→ hold `existing_archived_lead_alive`;无 archive 的活 pane → hold `unarchived_live_lead_window`。新 supervisor **没有任何路径**对活本体取得 takeover 授权(by design,防 split-brain)。
3. **identity 进程表 preflight**(claude-lead.sh 3183-3202 + `lib/lead-identity-preflight.sh`):进程表存在 `claude ... --agent <lead_id>` 精确匹配 → hold `lead_dual_active`。

三层守卫的共同锚点:**本体进程是否活着**。效果对 founder 而言等价于"收养"——旧本体带着冻结的启动参数继续当这个 Lead。

### 候选 3:验证器假阳性 — 证实

`launchd_lead_outcome_ready`(restart-services.sh 899-914)只验三件事:launchd 有新 PID、新 PID ≠ 旧 supervisor PID、窗口 `${project}-${lead}` 存在且 pane_dead=0。**不看 pane 里的本体是谁、什么时候出生、拿什么参数起的**。孤儿的窗口恰好满足全部条件 → `restarted via launchd (PID 77218, responsive session verified)` 假阳性。

### 为什么模型永不更新(与 FLY-1496 的关系)

FLY-1496 的热加载模型解析(projects.json → `resolveLeadModelLaunch`)只在 `_launch_claude`(claude-lead.sh 1530+)即**物理 launch 时**执行。hold 循环永远到不了 `_launch_claude` → 解析根治了,但没有 launch 就没有落地。FLY-1507 是 1496 的最后一公里。

### 孤儿从哪来(历史成因,修复不依赖它)

任何一次 supervisor 非优雅死亡都会制造孤儿并从此粘住(后代 supervisor 全部 hold):

- `launchctl kickstart -k` 对 KeepAlive(=true, ThrottleInterval 30s)间隙重生的 supervisor 直接 SIGKILL(无 cleanup);
- cleanup 里 `_tmux_target_matches_archive` 判定 generation indeterminate → "preserving archive" 主动不杀窗口;
- supervisor 崩溃 / OOM / 手工 kill -9。

修复的设计目标是**无论孤儿如何产生,重启一次即收敛**,不追历史个案。

## 解决方向(三案对比)

### 方案 A(推荐):stop 阶段真身清场 + newborn 验证(改 restart-services.sh + wrapper,零改 claude-lead.sh)

- **停止阶段新增 sweep**:TERM supervisor 等死之后,按 Lead 身份定位全部残留本体——(a) tmux 窗口名 `${project}-${lead}` 的所有 pane_pid;(b) archive 文件里的 pid(先验 pid+lstart 身份防 PID 复用);(c) 进程表 `claude --agent <lead_id>` 精确 token 匹配(复用 `lead_identity_command_matches` 逻辑,仅 claude backend)——温和递进终结(C-c → TERM → KILL),kill-window,清 archive。本体一死,三层守卫全部自然放行(lease `denied_holder_alive` 只在 holder 活着时拒绝——已读码证实),新 supervisor 在 30s 内正常 launch,FLY-1496 热解析自动生效。
- **验证器升级**:`launchd_lead_outcome_ready` 增加"**本体必须新生**"判据——窗口名匹配的窗口恰好 1 个、pane 本体 lstart 晚于本次 sweep 完成时刻;并提取 pane argv 的 `--model` 写入 restart 日志作为证据(与 manifest `.resolvedModel` 比对,claude backend)。旧本体存活 → 永不判成功(假阳性根除)。
- **wrapper 过渡锁**:sweep 拉长了 TERM→kickstart 的窗口,KeepAlive 间隙重生的 supervisor 可能抢先 launch 又被 kickstart -k SIGKILL 制造出**新孤儿**。`flywheel-lead-wrapper.sh` 增加对 `${PID_DIR}/${key}.restart-transition.lock` 的检查(锁在且新鲜 → exit 0 让路;带 TTL 防 restart 脚本崩溃把 Lead 永久锁死)。restart 脚本 TERM 前落锁、kickstart 前删锁。
- **换身不失忆**:SESSION_ID_FILE 不动,新本体 `--resume` 同一 session,记忆延续。

### 方案 B(拒绝):给 claude-lead.sh 发"替换意图"令牌,穿透三层守卫强制 takeover

需要同时改 FLY-1309 lease(强制夺取)、FLY-1285 archive 守卫(reap 授权)、identity preflight(旁路)三层 fail-closed 安全机制,每层都要防重放/过期/误用;爆炸半径大,且这三层的存在意义正是"永不误杀活本体"。拒绝理由:把安全机制改出洞 vs 在操作侧(重启=明确要换身)直接清场,后者语义干净得多。

### 方案 C(拒绝,但其验证器半边被 A 吸收):只修验证器

验证器诚实了,但重启永远失败、孤儿继续服务,不满足验收"全部 Lead 真身刷新"。检测无收敛。

## 范围纪律

- 不动 runner 收养逻辑(FLY-1399 by-design)。
- 不动 claude-lead.sh 的三层守卫与 hold 语义(supervisor 崩溃时旁观活本体仍是两次重启之间的正确行为)。
- 不动 Bridge / cmux / 模型解析(FLY-1496 已就位)。
- 改动集中于:`scripts/restart-services.sh`(sweep + 验证器)、`scripts/flywheel-lead-wrapper.sh`(过渡锁)、测试。

## 开放问题(带默认倾向,brainstorm gate 提请 Lead 确认)

1. **sweep 失败(本体杀不死)时是否仍 kickstart?** 倾向:仍 kickstart(supervisor hold = 今天的安全行为),但该 Lead 计为 failed、告警,绝不报成功。
2. **codex backend Lead(Mufasa TUI)**:窗口 sweep + newborn 验证同样适用;进程表 claude 匹配与 `--model` argv 证据按 backend 跳过。确认?
3. **model 证据比对(pane argv vs manifest resolvedModel)不一致时**:倾向 WARNING + 计 failed(同机同源数据,不一致=深层异常),不静默。
4. 落地后需 founder 再跑一次统一 `restart-services.sh` 收敛现存 9 个冻结本体(本单验收即此)。
