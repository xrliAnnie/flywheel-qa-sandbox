# FLY-913 部署护栏 — PreToolUse hook 硬拦手动重启 — 实施计划

Issue: FLY-913 (https://linear.app/geoforge3d/issue/FLY-913/infraguardrail-部署护栏-pretooluse-hook-硬拦手动-bridgelead-重启物理强制走-restart)
日期: 2026-07-06
基于: exploration.md, research.md

## 0. 一句话

新增全局 PreToolUse hook `flywheel-restart-guard.py`(镜像 discord-reply-enforcer 先例):任何 Claude session 里匹配「手动重启 flywheel 服务」的 Bash 命令被硬 deny,报错直接给出 restart-services.sh 正确命令;唯一出口是**强制响**的 bypass(审计日志 + Discord alert 缺一不可,fail-closed);正规 flow 与全机其余 Bash 零影响。

## 1. 判定算法(hook 核心)

```mermaid
flowchart TD
    A[stdin JSON] -->|"解析失败/tool_name≠Bash"| Z[exit 0 放行<br/>判定路径 fail-open]
    A --> B{扫 block patterns<br/>P1/P2/P3}
    B -->|全未命中| Z
    B -->|命中| C{命令以行首 env 赋值<br/>FLYWHEEL_RESTART_GUARD_BYPASS=理由<br/>开头?(锚定前缀,非 contains)}
    C -->|否| D[deny + 正确命令指引<br/>+ 尽力审计记 deny<br/>审计失败仍 deny]
    C -->|是| E{① 审计日志写入成功<br/>② lead-alert.sh 严格结果<br/>= sent / queued_transient}
    E -->|两者都成| F[放行 + 审计记 bypass<br/>Annie 在 alerts 频道立刻看见]
    E -->|任一失败| G[deny:bypass 记账失败<br/>bypass 路径 fail-closed]
```

**不变量(Codex R1 #5)**:一旦 block pattern 命中,唯二出路是「deny」或「记账双成的 bypass 放行」。deny 分支的审计日志是尽力而为——**审计写失败绝不把 deny 翻成放行**(fail-open 兜底只包判定/解析路径,不包已命中后的出口);bypass 分支则相反,审计成功是放行前置。单测覆盖:日志路径不可写时命中命令仍 deny。

**Block patterns**(case-insensitive):P1/P2 扫**原始命令串**、不做引号剥离(不给 `bash -c "…"` 开真绕过口;代价是引号内研究型误报,见 §5)。P3 因执行器 token 太通用(npx/node/tsx 大量出现在读代码的命令里),采用**分段+首 token** 判定:按 `;`/`&&`/`||`/`|` 切段,剥每段行首 env 赋值与 `cd …` 前缀后取首 token——首 token 为执行器(或 `nohup` 后随执行器)且该段含 `run-bridge` 才命中;首 token 为读取工具(grep/rg/sed/cat/head/tail 等)不命中。**shell -c 递归一层**:段首 token 为 `bash`/`sh`/`zsh` 且带 `-c`(含合并 flag 簇,如 `-lc`/`-lec`——任何含 `c` 的短选项簇都按 -c payload 处理,Codex R2 #2)时,取其 payload 字符串按全套 P1/P2/P3 再扫一遍(`bash -c "…"` 与 `bash -lc "…"` 直启 run-bridge 必拦)。

| # | 模式 | 语义 | 事故对应(research §4) |
|---|------|------|------------------------|
| P1 | `launchctl` 后紧跟(可隔 flag)变更类子命令 `kickstart\|bootout\|bootstrap\|kill\|stop\|unload\|load\|enable\|disable\|remove`,**且**同命令串含 `com.flywheel.` | 对 flywheel launchd 服务的变更操作 | 形态 1/2/6 |
| P2 | kill 族(`kill`/`pkill`/`killall`,含 `xargs … kill`)**且**同命令串含 flywheel 进程标识:`run-bridge`、`claude-lead.sh`、`flywheel-bridge-wrapper`、`flywheel-codex-lead-wrapper`、`com.flywheel` | 杀 flywheel 服务进程(含 FLY-239 的 pattern-sweep) | 形态 3/4/5 前半 |
| P3 | 分段首 token 为执行器(`nohup`/`npx`/`tsx`/`node`/`bun`,nohup 可前置)且该段含 `run-bridge`;shell -c payload 递归扫(判定规则见上) | 绕开 build/播报的裸手拉起 Bridge | 形态 5 后半 |

**关键性质(设计精化,比 gate 版更紧)**:正规 flow 的顶层命令(`bash scripts/restart-services.sh [--force|--dry-run]`、`update-flywheel.sh`、`launchctl print/list`、裸 `pgrep`、grep/sed 读源码)**根本不命中任何 block pattern**——launchctl 变更调用发生在脚本子进程里,PreToolUse 只见顶层命令。因此**不存在 allowlist 救回机制**:命中即 deny(或 bypass)。这消灭了整个「构造 allowlist 形态绕过」的攻击面,拼接(`restart-services.sh; launchctl kickstart …`)天然被拦。gate 时承诺的「严格 allowlist 全匹配」被此更强形态取代(allow 行为对合法 flow 不变、deny 面只增不减)。

**Deny 消息**(permissionDecisionReason,回灌给 agent):
- 为什么拦:手动重启漏 pnpm build / 漏 core 频道播报 / 无健康检查回滚(FLY-913 事故);
- 正确命令:重启/部署一律 `bash ~/Dev/flywheel/scripts/restart-services.sh`(`--force` 跳 idle-wait,`--dry-run` 预览);self-ship 走既有 ship flow;
- 若 restart-services.sh 本身故障:报告 Lead/founder,由人在裸终端处理;
- **不提 bypass env**。

**Bypass**:**锚定行首**的 env 赋值前缀 `^\s*FLYWHEEL_RESTART_GUARD_BYPASS=<非空理由,可带引号>\s+<命令>`(Codex R1 #4:必须是真 shell 前缀赋值,不是 contains——`echo FLYWHEEL_RESTART_GUARD_BYPASS=x; launchctl kickstart …` 与注释形态不进 bypass 路径,照常 deny)。放行前置(缺一即 deny):
1. 审计日志成功追加(JSON line);
2. `lead-alert.sh --kind restart_guard_bypass --severity severe --signature <per-invocation 唯一签名> --strict-delivery --title … --body <理由+命令>` 的**严格机器可读结果**为 `sent` / `queued_transient`(瞬时失败已落 alert-queue,drain 必达)之一。
   **Codex R1 #1(blocker)修正**:现状 lead-alert.sh 的 exit 2 同时覆盖「瞬时失败已入队」和「永久不达」(no-channel / no-token / 永久 4xx dead-letter,lead-alert.sh:306-313/339-345)——后者绝不能算「响了」。因此给 lead-alert.sh 新增 `--strict-delivery` 输出通道(stdout 一行机器可读结果:`sent|duplicate|queued_transient|dead_lettered|config_error`),hook **只认 `sent` 与 `queued_transient`**;其余(`dead_lettered`/`config_error`/`duplicate`/未知 lead/解析失败)一律 deny。不加该 flag 时 lead-alert.sh 行为逐字节不变。
   **Codex R2 #1(blocker)修正——`duplicate` 不算「响过」**:claims.db 的 claim 是在**投递尝试之前**写入的(lead-alert.sh:220-231 先 claim,频道/token/POST 结果在其后才发生)——claim 行存在不能证明 alert 曾送达或入队(claim 后 crash / dead-letter 都会留下 claim 行)。处置:hook 侧签名做 **per-invocation 全局唯一**(ts 纳秒 + pid + 随机数 + cmdhash),`duplicate` 在正常流程中不可达;真出现即视为异常 → deny。回归测试:第一次调用得 `dead_lettered` 后,同签名第二次调用必须 deny(不得变成 duplicate-allow)。
   身份解析:`--project` 取 env `PROJECT_NAME`/`FLYWHEEL_PROJECT_NAME`,fallback `flywheel`;`--lead` 取 env `FLYWHEEL_LEAD_ID`,fallback `flywheel-eng-lead`(基建 owner,保证 projects.json 可解析出 alert 频道)。

**审计日志**:`~/.flywheel/logs/restart-guard.log`,JSON lines(ts / session_id / cwd / decision=deny|bypass / 命令截断 2KB / bypass 理由)。普通放行不记。

## 2. 交付物(文件清单)

| # | 文件 | 动作 | 内容 |
|---|------|------|------|
| 1 | `scripts/hooks/flywheel-restart-guard.py` | 新增 | hook 本体,python3 stdlib only,§1 算法;测试 seam:env `FLYWHEEL_RESTART_GUARD_LOG`(日志路径覆盖)、`FLYWHEEL_RESTART_GUARD_ALERT_CMD`(alert 命令覆盖,单测不打真 Discord——同 reply-enforcer 的 TRANSPORT seam 模式) |
| 2 | `scripts/hooks/test-flywheel-restart-guard.py` | 新增 | 模式矩阵单测(§4) |
| 3 | `scripts/hooks/install-restart-guard.sh` | 新增 | 独立首装/卸载脚本:cp 到 `~/.flywheel/bin/flywheel-restart-guard.py` + jq merge 进 `~/.claude/settings.json` 的 `hooks.PreToolUse`(matcher "Bash");`--uninstall` 反向清理(删自己条目+文件)。jq merge 逐字沿用 reply-enforcer 防御(非空校验/mktemp+mv/坏 JSON 跳过,research §1) |
| 4 | `packages/teamlead/scripts/claude-lead.sh` | 修改 | 新增 `install_restart_guard_hook()`(调用/内联同一 merge 逻辑),Lead 每次启动收敛安装,同 reply-enforcer 位置并列;`FLYWHEEL_LEAD_DRY_RUN` 同款跳过 |
| 5 | `scripts/hooks/test-restart-guard-install.sh` | 新增 | install merge 矩阵(镜像 test-reply-enforcer-install.sh):幂等 / 删旧加新 / **保 sibling**(现网 PreToolUse 已有 strategic-compact + xhs 两组条目,必须原样保留)/ 坏 JSON 不写 |
| 6 | `scripts/lead-alert.sh` | 修改 | ① kind 白名单(line 72 case)新增 `restart_guard_bypass`;② 新增 `--strict-delivery` flag:stdout 输出一行机器可读结果 `sent\|duplicate\|queued_transient\|dead_lettered\|config_error`(区分「瞬时失败已入队」vs「永久不达」,§1 bypass 契约的地基);不带 flag 时行为逐字节不变(既有调用方零影响,配对 reverse-compat 断言) |
| 7 | `packages/teamlead/src/LeadAlertNotifier.ts` | 修改 | `AlertEventType` union 新增 `restart_guard_bypass`(Codex R1 #2:shell 侧 kind 与 TS shared type face 不许漂移,现有 tui_window_lost 同款约定;bypass 若走 queue,drain 侧要认得这个 eventType)。仅类型面 + kind 平价测试,无行为逻辑改动 |
| 8 | `doc/engineer/implementation/restart-guard.md` | 新增 | 运维页:bypass 用法(**唯一**成文处)+ 卸载 + 已知盲区 + 生效时机 |

不碰 Bridge 运行时行为、不需要 Bridge/Lead 重启(LeadAlertNotifier.ts 仅类型面扩枚举,与 hook 部署解耦——hook 经 shell 侧 lead-alert.sh 直发/入队,queue drain 对未知 eventType 的兜底行为在实现时核实并测试)。版本号:ship 时按当时空号取。

## 3. 部署(Tier-1,零服务重启 —— 别自相矛盾的那条)

1. **PR merge 前不碰生产**:hook 只以源码形态存在于分支。
2. **Ship(founder gate 过后)**:跑 `install-restart-guard.sh` 一次 = cp + settings merge,**不重启任何服务**。此后 claude-lead.sh 在每次 Lead 正常启动时收敛(防漂移),hook 文件后续更新 = 重新 cp(per-invocation 现读,真·零重启)。
3. **生效时机(诚实承诺,research §2)**:新 session 立即;已运行 session 依赖 Claude Code settings file-watcher(官方文档:hooks 编辑 normally picked up automatically)——真机 QA 验证实际行为;保守下限 = 老 session 最迟在其下次正常 flow 重启后生效。
4. **回滚**:`install-restart-guard.sh --uninstall`,秒级,零服务影响。

## 4. 测试计划

**单测(python,pattern 矩阵。目标:枚举矩阵内误报 0 + 事故形态漏报 0;矩阵外接受 §5 已归档的研究型误报类,不承诺全域误报 0 —— Codex R1 #3)**:
- 必拦(≥14):research §4 全部 6 种事故形态及变体(gui/uid 变体、-k flag、`launchctl kill SIGTERM`、`pgrep -f run-bridge | xargs kill -9`、`pkill -f claude-lead.sh`、nohup/npx/node 直启 run-bridge、`cd ~/Dev/flywheel && launchctl kickstart …` 前缀包裹、拼接 `bash scripts/restart-services.sh; launchctl bootout …`、**`bash -c "nohup npx tsx scripts/run-bridge.ts"` 与 sh/zsh 变体及合并 flag 簇 `bash -lc "…"`**(-c 递归扫,含 `-lc`)、**`echo FLYWHEEL_RESTART_GUARD_BYPASS=x; launchctl kickstart …com.flywheel…` 与注释形态**(伪 bypass 不进 bypass 路径,照常 deny));
- 必放(≥14):`bash scripts/restart-services.sh` / `--force` / `--dry-run` / `~/.flywheel/bin/` 副本路径 / env 前缀 `RESTART_MAX_WAIT=60 …` / `update-flywheel.sh` / `launchctl print gui/501/com.flywheel.bridge` / `launchctl list | grep flywheel` / 裸 `pgrep -f run-bridge`(无 kill)/ `grep -n launchctl scripts/restart-services.sh`(单独出现,无 com.flywheel 同串)/ `sed -n 1,50p scripts/run-bridge.ts` 与 **`rg "nohup npx tsx scripts/run-bridge.ts" scripts/restart-services.sh`**(读取形:段首 token 是读取工具,P3 分段判定不命中)/ 无关 kill(`pkill -f chrome`、`kill %1`)/ QA slot 场景(worktree 直跑进程操作,无 com.flywheel 标签);
- bypass 契约(经 `FLYWHEEL_RESTART_GUARD_ALERT_CMD` seam 注入假 lead-alert):严格结果 `sent`/`queued_transient` + 审计成功 → 放行 + 日志断言;**`dead_lettered` → deny;`config_error` → deny;`duplicate` → deny(Codex R2 #1:claim 先于投递,不证明响过);alert 输出不可解析 → deny**;审计日志写失败(只读路径)→ deny;**回归**:第一次 `dead_lettered` 后同签名重试不得变 duplicate-allow(仍 deny);签名唯一性断言(同一命令连发两次生成不同签名);
- deny-audit 不变量:命中 P1 且审计日志路径不可写 → **仍 deny**(Codex R1 #5);
- 鲁棒性:空 stdin / 非 JSON / 缺 tool_input / tool_name≠Bash → exit 0 静默放行(fail-open);
- deny 输出 schema 断言:`hookSpecificOutput.permissionDecision=deny` + reason 含正确命令、**不含** bypass env 名;
- lead-alert.sh 侧(bash):`--strict-delivery` 五种结果各一例(含 no-token→`config_error`、永久 4xx→`dead_lettered`、瞬时失败落 queue→`queued_transient`);**不带 flag 输出/exit code 逐字节与现状一致**(reverse-compat)。

**install merge 测试(bash)**:§2 交付物 5 所列矩阵。

**真机(implement 自测 + FLY-579 独立 QA session 复核)**:
1. 已装 hook 的 session 里敲 `launchctl kickstart -k gui/501/com.flywheel.bridge` → 被 deny 且报错给出 restart-services.sh(deny 本身即证明生产未被碰,测试无损);
2. `bash ~/Dev/flywheel/scripts/restart-services.sh --dry-run` → 放行、正常输出计划;
3. bypass 前缀 + 无害变更类命令 → 放行,`#flywheel-alerts` 频道**真实出现** severe alert(Claude-in-Chrome 确认)+ 审计日志落行;连发两次都响(签名唯一化验证);
4. file-watcher 验证:向运行中 session 现装 → 同 session 内敲手动重启命令,记录是否即时生效(结论写进 restart-guard.md);
5. 回滚验证:`--uninstall` 后同命令恢复放行,settings 里 sibling hooks 原样。

## 5. 已知盲区与接受理由(QA 对照表)

| 盲区 | 接受理由 |
|------|----------|
| 裸 `kill <pid>`(串内无 flywheel 标识) | 不可分类;非事故形态;拦会误伤大量正常操作 |
| 命令写进临时脚本再 `bash /tmp/x.sh` | 蓄意绕过,非反射性救火;审计 + 纪律问题(exploration 非目标) |
| P1/P2 引号内研究型误报(如 `grep "launchctl bootout" f && grep com.flywheel g` 同串,或 grep needle 同时含 kill 与 run-bridge)| 极罕见;deny 消息可读,agent 改用 Read/分开 grep;P1/P2 不做引号剥离是为了不给 `bash -c "…"` 开真绕过口(P3 已用分段+首 token 消掉执行器 token 的高频误报,-c payload 递归扫补上逃逸口) |
| 已运行 session 生效时机依赖 file-watcher | 真机验证 + 保守承诺(§3.3) |

## 6. Gate 与放权点

- **已过**:brainstorm gate(Tadashi 2026-07-06)——全局作用域 + 响-bypass 两点拍板;§1「无 allowlist 救回」为 gate 后强化精化(allow 面不变、deny 面更紧),在 design review 与 PR 描述中明示。
- **design review**:✅ **Codex design review APPROVED(3 轮,2026-07-06,xhigh)**。R1 抓 5 项(bypass alert 契约 exit-2 歧义 = blocker、TS alert-kind 类型面同步、P3 分段判定、bypass 前缀锚定、deny-audit 不变量);R2 抓 2 项(`duplicate` 因 claim 先于投递不可信 = blocker、`-lc` 合并 flag 簇);全部采纳并已折进本 plan。R3 附注(实现期保持):严格结果解析 boring + fail-closed(未知输出一律 deny)、签名用真 per-invocation 熵(纳秒+pid+随机)、不带 flag 的 lead-alert.sh 出口面 byte-compat 且有测试。
- **implement 阶段**:TDD(先写 §4 矩阵红测)→ 实现 → Codex code review → PR。
- **ship gate(founder)**:PR 呈给 Annie 时**必须原样带上选择题**——「响-bypass(现方案:env 出口保留,但每次强制审计+alert,你必然看见)vs 完全封死(零出口,特殊 cutover 只能你本人在裸终端跑)」。这是绑 agent 的松紧,由 Annie 终拍;若拍封死,实现侧只需删 bypass 分支(单测矩阵已隔离该路径,改动极小)。
- **部署动作本身**(install script 在生产机上跑)也在 ship gate 之后,按 §3 顺序。

## 7. Implement 阶段分块(progress.md chunk 对齐)

| chunk | 内容 | 验收 |
|-------|------|------|
| C1 | hook 本体 + 单测矩阵(TDD) | 矩阵全绿 |
| C2 | install 脚本 + claude-lead.sh 收敛 fn + merge 测试 | merge 矩阵全绿,现网 settings 模拟输入保 sibling |
| C3 | lead-alert.sh 新 kind + `--strict-delivery` 严格结果通道(reverse-compat 断言)+ LeadAlertNotifier.ts 类型面同步 + alert seam 接线 | bypass 契约单测全绿(五种结果 + dead_lettered/config_error 必 deny) |
| C4 | restart-guard.md 运维页 + 真机五步验证 | §4 真机清单逐条留证 |
| C5 | PR + Codex code review 循环 + 独立 QA | review APPROVED + QA PASS |
