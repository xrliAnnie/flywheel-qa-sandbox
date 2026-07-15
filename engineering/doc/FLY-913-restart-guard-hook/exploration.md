# FLY-913 部署护栏 — PreToolUse hook 硬拦手动重启 — 探索

Issue: FLY-913 (https://linear.app/geoforge3d/issue/FLY-913/infraguardrail-部署护栏-pretooluse-hook-硬拦手动-bridgelead-重启物理强制走-restart)
日期: 2026-07-06
基于: 无

## 1. 问题定义

**事故(2026-07-06)**:Tadashi(flywheel-eng-lead)一天内手动 `launchctl kickstart` 重启 Bridge/leads 至少 4 次,绕过 restart-services / updater flow,后果:

1. **漏 pnpm build** — 第一次重启跑的是旧代码(kickstart 只重启进程,不 build);
2. **漏 core 频道播报** — Annie 的部署审计记录断链(restart-services.sh 内置 Discord notify);
3. **无失败回滚 / 无健康检查** — restart-services.sh 有 port-release fail-closed、健康探针、deployed-sha 记录,手动路径全没有。

更关键的是行为层面:**几小时前刚口头承诺「以后走 flow、记死了」,然后又犯**。Annie 的结论(原话):「你说什么记死了都放屁的…必须得记到一些真正可以去强迫你这样做的地方才行。」

**根因**:口头承诺 + agent memory 都不强制行为——救火压力下 agent 会忽略它们。唯一有效的是**结构护栏**:让「手动重启」这个动作在物理上执行不了。

## 2. 目标与非目标

**目标**:
- 任何 Claude session(Lead / Runner / 任意 agent)里,匹配「手动重启 flywheel 服务」模式的 Bash 命令被**硬拦**(deny),报错直接给出正确命令,agent 无脑改用。
- 正规路径(restart-services.sh、updater/self-ship)完全不受影响。
- 所有被拦与 bypass 都留审计痕;bypass 必须「响」(Annie 立刻看见)。

**非目标**:
- 不追求对「蓄意绕过」的密码学级防御。PreToolUse 层的护栏挡的是**反射性/救火性**的手动重启(本次事故的形态);一个蓄意写脚本、base64 编码来绕的 agent 是纪律问题,靠审计痕 + Annie 追责,不靠这层 hook。
- 不改 restart-services.sh / updater 本身的行为。
- 不拦人类在裸终端(非 Claude session)的操作——hook 只存在于 Claude Code session 内,裸终端天然是人类逃生口。

## 3. 方案空间

### 3.1 拦截点选哪层?

| 选项 | 说明 | 判定 |
|------|------|------|
| **A. PreToolUse hook(选定)** | Claude Code 原生 hook,在 Bash 工具执行前拿到完整命令串,输出 permissionDecision=deny 即物理拦截,reason 回灌给 agent | ✅ 唯一在「命令执行前」有强制力的层;有 discord-reply-enforcer 成熟先例(部署/接线/测试模式全可复用) |
| B. settings.json permissions deny 规则 | `Bash(launchctl kickstart *)` 类静态规则 | ❌ 匹配语义太粗(前缀匹配,`cd x && launchctl…` 逃逸),deny 无法自定义报错指引正确命令,且规则散在 permissions 里难测试 |
| C. 提示词/rules 层再加重申 | 在 lead-rules-base 加铁律 | ❌ 就是「记死了」的失败形态本身,已被本次事故证伪 |
| D. 系统层(launchd ACL / sudo 策略) | 让 launchctl 本身拒绝 | ❌ 同一 macOS 用户下无法区分「agent 敲的」和「restart-services.sh 子进程敲的」,会把正规 flow 一起杀死 |

### 3.2 作用域:仅 Lead 还是全局?

**全局(所有 Claude session)** — Tadashi 已拍(brainstorm gate 2026-07-06)。理由:Runner 同样不该手动重启生产服务;hook 只匹配「flywheel 服务重启」那几类命令,非-flywheel session 根本不敲这些,天然零影响。全局 = 装进 `~/.claude/settings.json`(机器级),与 reply-enforcer 同位。

### 3.3 Bypass 出口:留还是封死?

三个选项:

1. **完全封死** — 特殊 cutover(如 Mufasa flip 那类 founder 在场的 bootout/bootstrap)只能人在裸终端跑。最强,但把「founder 授权 + agent 执行」的合法形态也堵死。
2. **留 + 静默** — env 前缀放行,只写本地日志。❌ 暗门:agent 救火压力下会自我豁免,Annie 看不见 = 护栏名存实亡。
3. **留 + 强制响(选定)** — env 前缀 `FLYWHEEL_RESTART_GUARD_BYPASS=<理由>` 可放行,但每次 bypass **必须 ① 写审计日志 ② 给 Annie 发 Discord alert**,两者是放行的前置条件(做不到就 deny);deny 报错里**不宣传**这个出口。

Tadashi 拍了选项 3,并给出关键论证:「每次用都惊动 Annie = 我物理上没法**偷偷**绕——这正是 Annie 要的『不能只靠我自觉』:我一绕她就看见,比完全封死更实用又不留暗门。」

> **⚠️ 交 Annie 拍的点(ship gate 必须明示)**:「留响-bypass(选项 3)vs 完全封死(选项 1)」本质是**绑 agent 的松紧**,不该由被绑的 agent 自己定。Tadashi 已明确:这条在 ship gate 交 Annie 终拍;plan 与 PR 描述都要原样带上这个选择题。

### 3.4 拦截 vs 放行的边界

**拦(deny)**:
1. `launchctl` **变更类**子命令(kickstart / bootout / bootstrap / kill / stop / unload / load / enable / disable / remove)且命令中出现 `com.flywheel.` 标签;
2. kill 族(kill / pkill / killall / `xargs kill`)且命令中出现 flywheel 进程标识(`run-bridge`、`claude-lead.sh`、`flywheel-bridge-wrapper`、`com.flywheel` 等)——即 FLY-239 教训里危险的 pattern-sweep 杀法;
3. 手动直启 bridge:`npx tsx scripts/run-bridge`(含 nohup 包裹)——绕开 build/播报的「裸手拉起」。

**放(allow)**:
- `restart-services.sh` / `update-flywheel.sh` 的**严格全命令匹配**(见下);
- `launchctl` 只读子命令(print / list / blame / dumpstate 等诊断);
- 其余一切 Bash 命令(不含上述模式)零影响。

**防拼接绕过**:判定顺序是「先扫 block pattern;命中后,仅当整条命令严格匹配 allowlist 形态才放行」。`bash scripts/restart-services.sh; launchctl kickstart …` 这类拼接因整条不匹配 allowlist 形态而被拦。allowlist 绝不做子串包含判定。

### 3.5 已知盲区(诚实列出)

- 裸 `kill 12345`(纯 PID、命令串无 flywheel 标识)无法分类 → 放行。接受:这不是本次事故形态,且拦它会误伤大量正常操作。
- agent 把重启命令写进临时脚本再执行 → hook 只见 `bash /tmp/x.sh`,拦不住。接受:这是蓄意绕过,属纪律 + 审计问题(见非目标)。
- hooks 配置是 **session 启动时快照**:新 PreToolUse 条目对「已在跑」的 session 要等其下次(正常 flow 的)重启才生效;对之后所有新 session 立即生效。hook **文件本体**更新则真·零重启(每次调用现读)。

## 4. 决策摘要(brainstorm gate 已确认,2026-07-06)

| 决策点 | 结论 |
|--------|------|
| 拦截层 | PreToolUse hook(Bash matcher),镜像 discord-reply-enforcer 先例 |
| 作用域 | 全局 `~/.claude/settings.json`,所有 Claude session |
| Bypass | 留,但强制响:审计日志 + Discord alert 是放行前置(fail-closed);报错不宣传;「响-bypass vs 封死」ship gate 交 Annie 终拍 |
| 失败语义 | hook 内部错误 fail-open(绝不 wedge 全部 Bash);bypass 记账路径 fail-closed |
| 部署 | source 在 scripts/hooks/,cp 到 ~/.flywheel/bin;接线 = claude-lead.sh jq-merge + 独立首装脚本 |

下游:→ research.md(代码库事实 + 机制细节)→ plan.md(实施计划)。
