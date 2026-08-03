# FLY-1602 重启换代失败即孤儿 lease catch-22 — 探索

Issue: FLY-1602 (https://linear.app/geoforge3d/issue/FLY-1602/基建a-重启换代-lead-失败即孤儿-lease-catch-22-每次-restart-挂掉只能人工捞回)
日期: 2026-08-02
基于: 无(本 issue 首篇;交叉引用 FLY-1507 / FLY-1470 / FLY-1501 已归档设计)

## 0. 一句话

supervisor(claude-lead.sh 监管进程)死掉而 body(tmux 里的 claude 本体)活着时,系统没有任何自愈路径:lease 拒绝一切继任者、storm gate 拒绝一切重启、告警诱导救援者继续杀 supervisor——本设计给继任 supervisor 一条**证据齐全才放行的收养(adopt)路径**,并让 restart-services 与 storm gate 握手,使「supervisor 死亡」从永久事故降级为秒级可恢复事件。

## 1. 实证(不是复述 issue,是本设计节点当场取到的新证据)

### 1.1 写设计文档的此刻,eng-lead 就是孤儿(2026-08-02 10:18 现场)

```
ps: claude --agent flywheel-eng-lead … --resume 02bdc96d… (PID 99749, 09:56 起, tmux pane s049)
ps: 【没有任何】claude-lead.sh flywheel-eng-lead 进程
~/.flywheel/pids/: flywheel-flywheel-eng-lead.pid 不存在(只剩 .claude.tmux archive)
storm gate 台账: episode 112(issue 写时 94,还在涨), state=held_alert_attempted
wrapper 日志: 10:00:04 起每 30s 一条 "Restart-storm gate held or refused … not touching PID state."
```

### 1.2 supervisor 日志还原的完整振荡(/tmp/flywheel-lead-flywheel-flywheel-eng-lead.log)

以 03:17 一轮为例(03:02 restart 波之后、且当时 restart-services 正在处理别的 Lead):

```
03:17:18 wrapper 放行(storm episode 恰好 resume)→ supervisor 57826 启动
03:17:28 [restart #1] Resuming session 02bdc96d…
03:17:30 Claude launched in tmux window: flywheel:@118   ← body 新生 + lease bind 到 body
03:17:52 Shutdown signal received...                     ← body 出生仅 22 秒,supervisor 被 SIGTERM
         (之后【零】cleanup 日志——C-c→等 5s→kill-window 的优雅拆除被硬杀截断)
03:17:58 wrapper 重生 supervisor 78527(SIGTERM 后 1–6s 内重生 = kickstart -k 特征,不是 bootout)
03:18:03 Lead identity HOLD (denied_holder_alive)        ← 孤儿 body 持有 lease,继任被拒
03:18:07 → 03:18:52 HOLD 退避 3/6/12/24/30s
03:19:14 Shutdown signal received...                     ← 又被杀(距启动 72s)
…(78527→17418→55502 逐个重复,每只 supervisor 存活恰 ~72s)
之后 storm gate 触发 → wrapper 每 30s 自我拒绝,最长连续拒绝超过 3 小时(昨日 11:08→14:30 实录)
```

同款循环在 02:00、09:58、昨日 10:45–11:04 各来一遍;每次终结都靠 Cass 人工 ps 确认真死后 resume。

### 1.3 「newborn/body/model verification 失败」的根因(scope 第 2 条,已答)

03:02 restart 波里,eng-lead 的 bootout / quiescence / body sweep / bootstrap 全部成功;但 bootstrap 之后、
30×2s 验证窗口(03:13:48–03:15:48)期间,wrapper 日志是:

```
03:14:48 / 03:15:17 / 03:15:47 / 03:16:17  Restart-storm gate held or refused …
```

**FLY-1501 storm gate 在验证窗口内扣住了 wrapper——supervisor 根本没被允许启动**,newborn 验证在探测一个
结构上不可能出现的新生 body,30 次全空后报了一个语义完全错误的错("newborn/body/model verification failed")。
不是负载超时、不是 model 不匹配、不是验证逻辑误判孤儿——是**同一台机器上的两套保护机制互不知情**:
restart-services(合法换代)不知道 gate 在扣;gate 不知道这次启动是合法换代波。

### 1.4 谁在杀 supervisor(72s 周期 SIGTERM 的来源)

- SIGTERM 后 1–6 秒 wrapper 即重生 → job 未被 bootout(bootout 会卸载 job,KeepAlive 无从重生)→ 形态 = `launchctl kickstart -k`(原地强杀重启)。
- 昨夜事故的移交文档(~/.flywheel/handoff-bridge-storm-20260802.md)明文记录救援方案 (c):**「护栏 bypass + 逐个 launchctl kickstart 10 个自旋 Lead」**——救援动作本身就是 kickstart。
- 代码侧现存 kickstart 旁路:`scripts/flywheel-daemon.sh restart` = `kickstart -k`(:967)。FLY-1507 已判定 kickstart -k 是「孤儿制造机」并把它从 restart-services 退场,但这个旁路工具与人工 runbook 还在。
- Bridge 代码级 ARC(FLY-1082)只 kickstart infra-bot job,不碰 Lead job——排除。
- **设计立场:确切按键者是谁不再关键。** 结构性事实是:supervisor 之死(kickstart / 崩溃 / OOM / 误杀,任何原因)一旦落在「body 已 bind lease」窗口内,系统就永久卡死。修法不是抓凶手,是让 supervisor 之死变得无害。

## 2. 完整因果链(五层,每层单独看都"正确")

```
L0 触发: 舰队级事故(FLY-1598 自旋 + Bridge 死循环)→ 救援者反复 kickstart -k Lead job + 5 波 restart-services
L1 孤儿制造: SIGTERM/SIGKILL 落在 body 存活期 → cleanup 的优雅拆除(C-c + ≤5s 等待 + kill-window,>6s)
             被 launchd 强杀截断 → body 在 tmux server 进程树里存活(与 launchd job 树无关)
L2 锁死: bind 之后 lease holder = body 的 pid+lstart(lead-lease.ts bind: SET holder_pid=panePid)
         → body 活着 = denied_holder_alive → 继任 supervisor 永久 HOLD(3→30s 退避,无收养路径)
         → FLY-1285 takeover 守卫同样对活本体零授权(FLY-1507 exploration 已核验"永久 hold 旁观")
L3 杀救援者: HOLD 每轮发 lead_dual_active(severe)告警 → 救援者(人/agent)读作"Lead 卡死" → 再 kickstart
         → 杀掉的恰是唯一在正确等待的进程 → 回到 L1
L4 锁大门: L1-L3 的 churn 触发 FLY-1501 storm gate → wrapper 连 supervisor 都拒绝启动(实录连续 >3h)
         → 此时 restart-services 的合法换代也被无声否决(§1.3),报错语义错误 → 误导下一轮救援
```

三真相源(issue 所述)在此链里各说各话:PID 文件量「supervisor 存活」(退出即自删,claude-lead.sh:2069)、
lease 量「身份占用」(holder=body)、进程表量「进程存活」。每源都对,但没有任何一层看得到全局。

## 3. 设计空间

### 3.1 Scope 1+3:孤儿 body 的出路 —— 三个候选

**候选 A(选定):继任 supervisor 证据齐全才放行的收养(adopt-first, replace-fallback)**

新 supervisor 在 lease 前置检查处把 `denied_holder_alive` 细分:

```
真双活 = 该 Lead 的 supervisor 进程存在(见下,双重独立证明)→ 维持今天的 HOLD/deny(防 split-brain,零放松)
孤儿   = ①lease 已 bind(bound_at 非空)且 body tuple(pid+lstart)存活
         ②lease 记录的 supervisor tuple 已死(需 schema 增列,bind 不再抹掉 supervisor 身份)
         ③进程表 argv census 找不到本 Lead 的任何 claude-lead.sh(FLY-1507 quiescence ③ 同款测量)
         ④body 的 argv 身份证明通过(lead_identity_command_matches,FLY-1309 精确 token 匹配)
         → 四条全过 → CAS 原子收养:generation++、supervisor tuple=自己、holder(body)不动
         → 跳过 launch,直接以既有 window 进入监护循环(重建 archive,body 一个字节不动)
任何一条测不到(传感器失败)→ fail-closed 回今天的 HOLD——绝不因不确定而放行
```

收养后:告警从 lead_dual_active(severe 风暴)变成一条 `lead_body_adopted`(info,审计用);
body 下次自然退出时,supervisor 用**热解析的新参数**(FLY-1496)重启——旧参数冻结问题自动过期。

**候选 B(拒绝):继任 supervisor 强制清杀孤儿 body 再新生(replace-only)**

- 反对 1:body 往往正在干活(此刻的 eng-lead body 就在正常当 Lead——本 issue 的 dispatch 都是它发的);
  杀活人换新生对 founder 体验是「重启一次断一次」,与 Annie 的直令背道而驰。
- 反对 2:supervisor 侧独立发起的清杀,与可能并行的 restart-services sweep 形成两个终结者,
  FLY-1507 刚刚把「谁有权杀 body」收敛为单一 sweep 权威,不能再裂开。
- 保留其变体作 fallback:body 身份证明不齐(detect 级)或 tuple 复验失败 → 不收养也不杀,维持 HOLD(诚实失败)。

**候选 C(拒绝):lease 加 TTL/心跳,过期自动放行**

时间基准的判活恰是 FLY-1470 三真相源打架的老病根:负载高时心跳迟到 = 误判死亡 = 双活;
TTL 保守又回到「几小时才恢复」。放弃时间轴,坚持 pid+lstart tuple + argv 证明的事实轴。

### 3.2 Scope 2:restart-services ↔ storm gate 握手

- restart_lead 在 bootstrap 前对 `lead.<project>-<lead_id>` 执行 gate resume(带 actor 标注)——
  合法换代波本来就是 gate 想保护的「受控重启」,不该被自己的历史 churn 扣住。
- 验证循环把「gate 当前 held」识别为独立失败态,报 `lead-restart-gate-held`(而非语义错误的
  newborn/body/model failed)——报错诚实是下一轮救援不跑偏的前提。
- gate 的防自旋语义零改动:收养把 churn 的输入(HOLD 风暴 + kickstart 循环)从源头拿掉,gate 此后罕有触发。

### 3.3 Scope 1 的另一半:换代失败时的干净收尾

FLY-1507 已保证 sweep 与验证的 fail-closed;本设计补的是失败后的**系统姿态**:
验证失败 → job 保持 loaded(KeepAlive 继续尝试)→ 下一只 supervisor 走收养/新生分类 → 自愈。
即:换代失败从「终态」降级为「暂态」,人工介入从「必须」降级为「可选」。

### 3.4 旁路收编

- `flywheel-daemon.sh restart`(:967)从 kickstart -k 改为 bootout→bootstrap(与 FLY-1507 结构性竞态封闭对齐);
- runbook/移交模板不再给出「逐个 kickstart Lead」的救援建议;
- 但注意:**即使有人仍然 kickstart,收养路径让它自愈**——这才是主防线,旁路收编只是降噪。

## 4. 与相邻 issue 的边界

| Issue | 关系 |
|---|---|
| FLY-1507(Done) | 同族不同症:1507 = restart 流程内「换身必换真身」(sweep+N0-N4 验证),刻意零改 claude-lead.sh、把孤儿态留作「诚实失败永久 HOLD」。本单接住它留下的失败分支:流程外 supervisor 之死 + 流程失败后的自愈。收养复用它的证明等级(full/detect)与 tuple 复验纪律。 |
| FLY-1470 | 三真相源同源问题。本设计的答案是「不选权威源,取多源命题合取」——每源只回答自己量的命题,收养需要四条独立证据同时成立,任何传感器失败即 fail-closed。 |
| FLY-1501 | storm gate 本体不动;补「合法重启波 resume 握手」+「held 态的诚实上报」。 |
| FLY-1285/1309 | 双活防护零放松:真双活(supervisor census 命中)仍然 deny/HOLD;收养 CAS 保证多只候选 supervisor 只有一只成为监护人。 |
| FLY-1598/1601 | 昨夜风暴的另两条腿(Lead 自旋、Bridge tick 崩溃),已各自修复;本单只管「风暴期间暴露出的换代脆弱性」。 |

## 5. 开放问题(带到 research/plan)

1. lease schema 增列(supervisor_pid/supervisor_start)的迁移与旧行兼容:旧行无 supervisor 记录时,
   census(③)+body 证明(④)是否足以放行收养?→ research 里定:**不足以——旧行一律走今天的 HOLD**,
   新列只对增列后的 bind 生效(保守起步,一个 restart 波后全舰队自然换到新行)。
2. 收养后 supervisor 如何重建监护现场(LEAD_WINDOW_ID / archive / session-id 文件一致性)→ research 核对
   claude-lead.sh 监护循环对这些状态的最小需求集。
3. 收养与 restart-services sweep 并发时序(sweep 正要杀 body,收养同时发生)→ tuple 复验 + lease generation
   CAS 的先后序,research 里推演。
4. `lead_dual_active` 告警在收养生效后的语义收窄(只剩真双活)是否影响既有 watchdog/工单消费方。
