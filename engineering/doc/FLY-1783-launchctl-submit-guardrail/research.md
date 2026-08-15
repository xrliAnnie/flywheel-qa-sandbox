# FLY-1783 launchctl submit 旁路补拦 — 调研

Issue: FLY-1783 (https://linear.app/geoforge3d/issue/FLY-1783/infraguardrail-补拦-launchctl-submit-旁路-detached-重启只许走-request-restartsh)
日期: 2026-08-15
基于: exploration.md

本文只记**已验证的事实**(带出处),以及由事实推出的设计约束。所有「本机实测」均为 2026-08-15 只读探针,零 mutation。

## 1. 护栏(FLY-913)事实清单

| 事实 | 出处 |
|------|------|
| P1 mutating 子命令表 = `kickstart\|bootout\|bootstrap\|kill\|stop\|unload\|load\|enable\|disable\|remove`,无 `submit` | `scripts/hooks/flywheel-restart-guard.py:73-76` |
| P1 第二条件只认 `com.flywheel.` label 串(`FLYWHEEL_LABEL_RE`) | 同上 `:77` |
| P2 进程标识表无 `restart-services`(`pkill -f restart-services` 今天放行) | 同上 `:80-84` |
| 扫描是**裸命令串**(P1/P2 不剥引号,`bash -c "…"` 无逃逸;一层 `-c` 递归) | 同上 docstring `:19-31` + `scan_block` |
| hit 后唯一出口 = deny 或记账完备的 bypass(audit 行 + strict alert 双前置 fail-closed) | 同上 `:33-43` |
| 部署 = Tier-1:`install-restart-guard.sh` cp 到 `~/.flywheel/bin/` + jq-merge `~/.claude/settings.json`;每次 Lead start converge;hook 逐次调用现读文件 → **merge 后跑一次 installer(或等任一 Lead 重启)即生效,零服务重启** | `scripts/hooks/install-restart-guard.sh:1-27`、`packages/teamlead/scripts/claude-lead.sh:1139-1162,1355` |
| 作用面 = `~/.claude/settings.json` 是 user 级 → 本机**所有** Claude Code 会话(Lead + Runner + 裸 claude)都被 hook 覆盖 | install-restart-guard.sh `SETTINGS_FILE` |
| 测试:`scripts/hooks/test-flywheel-restart-guard.py`(matrix 断言)+ `test-restart-guard-install.sh`,已接 CI | `.github/workflows/ci.yml:518-519` |
| **Codex Lead 无 PreToolUse hook**(Claude Code 机制)→ 对 Codex 的唯一约束层 = 注入的 rules 合同 | FLY-350 既定形态(contract-only) |

### 1.1 正则核对(逐字)

事故命令 `launchctl submit -l com.flywheel.restart-bus-manual -o … -e … -- /bin/bash …/restart-services.sh --force`:

- `P1_RE = \blaunchctl\b(?:\s+-\S+)*\s+(?:<mutating>)\b` — `launchctl` 后紧跟 `submit`(零个前置 flag),只要 mutating 表加 `submit` 即命中;
- label 含 `com.flywheel.` → 现第二条件也命中。**事故命令距被拦只差 mutating 表里一个词。**

label 规避形(`-l com.foo.x -- bash …/restart-services.sh`):P1_RE 命中,但 `com.flywheel.` 不命中 → 需要第二条件扩成 `label ∨ restart-脚本标识` 才能拦。

## 2. restart-services.sh 事实清单

| 事实 | 出处 |
|------|------|
| self-detach = `set -m` + `FLYWHEEL_RESTART_FOREGROUND=1 nohup "$0" … & disown`;**无 setsid、无 launchctl submit、无任何 fallback 链**;spawn 后不验活(child 秒死静默) | `scripts/restart-services.sh:1230-1242` |
| detach 日志路径硬编码 `/tmp/flywheel-restart-detached-<ts>.log` | 同上 `:1234` |
| 脚本自身无 `exec "$0"` 自替换(pull 后不换字节,与记忆「self-deploy 跑旧脚本字节」一致) | grep 实证(零命中) |
| 已有 lead-alert.sh 告警位点(FLY-1081:`--project flywheel --lead deploy` 形态)+ `notify_routine`,函数定义在 self-detach 块之前 → 新检查可复用 | 同上 `:357-427` |
| 入口顺序:函数定义 → 参数解析(`:1195`)→ `validate_restart_contract` → self-detach 块(`:1232`)→ lock/build/mutation | 结构通读 |

## 3. launchd 信号实测(检测层的判据 — 逐条在被测环境验证)

| # | 假设 | 实测结果 | 结论 |
|---|------|----------|------|
| S1 | launchd 直生进程 ppid==1 | `ps -o ppid= -p <com.flywheel.bridge 的 PID 70431>` → `1` | ✅ **ppid==1 是可用信号** |
| S2 | launchd 直生进程带 `XPC_SERVICE_NAME` env | `ps eww -o command= -p 70431` 输出中**无** XPC_SERVICE_NAME | ❌ 未观测到 → **弃用**该信号(判据信号必须存在于被测那一版) |
| S3 | `launchctl submit` 能否给 job 设 env | usage 实测:`submit -l <label> [-p <program>] [-o] [-e] -- <command>` — **无任何 env 选项** | ✅ submit job 无法直接携带 `FLYWHEEL_RESTART_FOREGROUND=1`;唯一注入方式是 `bash -c 'FOO=1 …'` 载荷 — 该载荷串含 restart-services,会被扩展后的 P1 拦 |
| S4 | 正路(updater)链的 ppid 形态 | `update-flywheel.sh:95` = `FLYWHEEL_RESTART_FOREGROUND=1 "${SCRIPT_DIR}/restart-services.sh" --reason updater`(**子进程调用,非 exec**)→ restart-services 的 ppid = updater 的 bash ≠ 1,且 FOREGROUND=1 | ✅ 正路对 ppid 检测**双重豁免** |
| S5 | updater plist 形态 | `scripts/com.flywheel.updater.plist`:QueueDirectories 触发,ProgramArguments = `/bin/bash update-flywheel.sh` | ✅ 与 S4 合起来:整条链只有 update-flywheel.sh 本身 ppid==1,restart-services 永远不是 |
| S6 | self-detach child 的 ppid 形态 | child 带 FOREGROUND=1;parent 秒退后 child 被 reparent 到 pid 1 | ⚠️ **检测必须只作用于 entry mode(FOREGROUND≠1)**,否则每次正常 detach 都可能撞 reparent 竞态误拒 |

**推论(检测规则)**:`FLYWHEEL_RESTART_FOREGROUND != 1 且 PPID == 1` ⇔「restart-services 被 launchd 直接当 job 拉起」。这个形态没有任何合法出现方式:
- 正路 updater:S4 双重豁免;
- request-restart.sh:根本不调 restart-services(只入队 marker);
- Lead pane / 裸终端直跑(紧急兜底):ppid = 交互 shell ≠ 1;
- self-detach child:FOREGROUND=1。

## 4. 告警去重(拒绝循环不能变成告警风暴)

被 submit 的 job 拒跑后 launchd 仍会每 ~10s 重拉(拒绝循环无害但持续)。拒绝路径若每次都告警 = 新的刷屏事故。事实:

- `lead-alert.sh` eventId = `sha1(project|lead|kind|signature)`,**signature 缺省 = 当天日期(UTC YYYYMMDD)**,claims.db 跨进程去重 → 用缺省 signature 天然「每天最多一条」(`scripts/lead-alert.sh:9-12,416-422`);
- `--kind` 是**白名单枚举**(`:22,187`)→ 新 kind `restart_guard_launchd_refusal` 需要加进枚举,否则 lead-alert 直接报 unknown kind 拒发。

## 5. 测试基建事实

- `scripts/test-restart-services.sh`(hermetic harness,已有先例):fake HOME + fake repo + PATH shims(`$HOME/.local/bin` 置前,launchctl/pnpm shim 记录 calls 到 calls 文件)→ 新增「零 submit 调用」「拒跑」「detach 验活」测试直接沿用此形态;
- `scripts/hooks/test-flywheel-restart-guard.py`:matrix 风格(must-block / must-pass 两列),模块可直接 import 做单元断言,也有 end-to-end stdin JSON runner;
- CI 已跑两者(`ci.yml:518-519`)+ `test-restart-services.sh` 在 script-tests job;
- ppid 不可在 bash 内伪造(`$PPID` 只读)→ 需要 env 测试 seam(见 plan);真 launchd E2E(真 submit + 观察拒绝循环 + remove)属于 merge 后独立 QA,agent 自己发 submit 会被新护栏拦 → 该步由 bypass 记账形态或 founder 亲手执行。

## 6. 误报面分析(护栏扩展的代价)

裸命令串扫描不剥引号 → 以下 research 形态会被误拦(deny 后 agent 换写法即可,FLY-913 plan §5 已接受该类):

- `grep -n "launchctl submit" scripts/restart-services.sh`(P1_RE 命中引号内串 + 新第二条件命中文件名);
- 同理今天已存在:`grep "launchctl kickstart" … com.flywheel …` 也会被现版误拦 — **不是新引入的类**,是既有 accepted tradeoff 的等量延伸。

必须**不**误拦的(加入 must-pass matrix):
- `launchctl list` / `launchctl print gui/501/com.flywheel.bridge`(读-only 子命令,P1_RE 不匹配);
- `launchctl submit -l com.test.envprobe -- /usr/bin/env`(submit 但无 flywheel 标识 — 与 flywheel 无关的 job 不归本护栏管);
- `bash scripts/request-restart.sh`(正路,无 launchctl、无 kill、无 executor+run-bridge);
- updater 内部链(hook 只看得见 agent 的 Bash 边界,updater 是 launchd 子进程,本来就不经过 hook)。

## 7. Lead rules 落点事实

- `founder-only-authority.md`(481 行,R1 merge/ship、R2 runner lifecycle、R3 infra self-heal carve-out)对 cos + dept 普适装载(`claude-lead.sh:2599-2607`),companion/external 例外(它们不碰基建,无需 restart 红线);
- Codex Lead 经 FLY-350 role-aware rule-bundle 同样注入该文件 → **在此文件加 R4 一节 = 两 vendor 全覆盖、零 shell 接线**;
- 现有 R 节风格:行为红线 + why + 唯一正路指引 — R4 照抄该结构。

## 8. 残余风险(设计必须诚实列出)

| 残余 | 为什么不在本单修 | 兜底 |
|------|------------------|------|
| 两步 plist 旁路(Write 一个含 restart-services 的 plist → `launchctl load <无关路径>`) | PreToolUse(Bash) 看不见 Write 内容;拦所有 load/bootstrap 会误伤 QA slot/fleet 安装 | 第②层 ppid 自卫:load 起来的 job 拒跑;R4 红线 |
| 人在裸终端手敲 submit | hook 不覆盖人类 shell | 同上 ppid 自卫 + 事故 runbook |
| `bash -c 'FLYWHEEL_RESTART_FOREGROUND=1 …restart-services…'` 包进 submit | — | 载荷串含 restart-services → 扩展后 P1 拦(agent);人类形态同上行 |
| Codex Lead 发 submit | Codex 无 PreToolUse | R4 合同(FLY-350 既定 contract-only 信任)+ ppid 自卫 |
| storm gate 自锁(根因②) | 明确另单 | 不变 |
