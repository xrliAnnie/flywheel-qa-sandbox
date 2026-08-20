# 独立交叉设计评审 — FLY-1330 plan.md (Round 3, 终核)

Date: 2026-08-19
Reviewer: independent Claude (cross-family stand-in,同 R1/R2 评审者,逐条复核 commit c96f3fe89)
Status: **APPROVED**

评审对象: `engineering/doc/FLY-1330-log-janitor/plan.md` @ c96f3fe89(238 行)

## Summary

R2 的 3 条残余(R-1/R-2/R-3)与 6 条 NIT 全部忠实折入,逐条核对无一走样;全文一致性重扫(含 flock 全文 re-grep、TL;DR/§3/§8/§10/§13/§15 交叉对照)未发现新的矛盾或安全缺口。三轮累计 14+3+6=23 条 findings 全部收口,方案在安全边界(fail-closed 全链)、诚实边界(codex-homes 29G 点名+移交)、安装完整性(converge roster + 两端 dry-run 机器门)与仓库惯例(shell 层、TDD、CI enumeration、简单性偏好)上均达标。**APPROVED**。

## What's Good (keep)

R2 残余的逐条核验(对照 c96f3fe89 实文):

- **R-1 ✓ flock 旧文清净**:§3:74 依赖清单改为「jq / sqlite3 / lsof(均为本机既有/系统自带)+ `mkdir` 原子锁(零依赖;macOS 无 `flock` 命令,见 §5)」;§3 mermaid :64 节点改「mkdir 原子单实例锁」;§13:217 改「mkdir 原子锁单实例」。全文 re-grep 复核:剩余 `flock` 出现仅两类——§5:130 的否定语境(解释为什么不用,含 python3-fcntl 先例引用)与 §15 的评审历史记录。文档内部不再自相矛盾。
- **R-2 ✓ lsof 退出码规则收口到位**:§4.2 防线 2 现为「退出码只用来鉴别执行是否正常:仅 ∈ {0,1,123}(lsof/xargs 的有/无匹配正常语义)时才信任 `-F n` 输出;126/127/被信号杀等其他退出 → 整个模块本 tick 跳过」,并点名了唯一危险场景(park-alive 且超期未写的 fd-held rollout 只有这道防线挡得住,mtime/re-stat 都拦不住)——把「跑挂了」误读成「无人持有」的 fail-open 缝已关死。123 的纳入说明 xargs 退出码改写语义也被考虑了。§10-3 补上了反向 case:fake-lsof 强制 exit 127 + 空输出 → 断言整模块 skip 而非删除(此条用 seam 合法——测的是 janitor 对失败码的处置);「exit 1 + 空输出 = 无持有者照常删」的两义性正向 case 保留;hold/release 两态强制真实 lsof 的防假绿要求未动。
- **R-3 ✓ 首删端机器门补齐**:§5:131 新增 `--apply` 运行时门(启动时要求审计中存在既往 dry-run summary,否则拒跑,`--force` 逃生),与 §6:138 的安装门(`first-apply-ok` marker)合成两端约束——「先试跑」在**首删**与**装定时**两端都不再依赖人序。这正是 issue「dry-run mode first」硬边界的完整机器化。
- **6 条 NIT 全落**:N-1 TL;DR 要点 1 已同步 releases 新规(严格老于 current + 新于/24h 内不碰);N-2 §3:76 睡眠语义改「唤醒合并补跑、关机才顺延」,与 §6 一致;N-3 §10 断言组 5 文字同步(「current 目标与『老于 current 中最新』保留;新于 current 与 mtime<24h 不碰」);N-4 §5 锁补「锁目录在而 pid 文件缺失/不可读 → 视为持锁中直接退出不清锁(fail-closed)」——mkdir 与 pid 写入之间的窗口关掉了;N-5 §13:218 新增 TOCTOU 残余窗口条目,措辞诚实(「记入已知残余而非假装消除」,并给出工程概率论证);N-6 §8 KEEP_RELEASES 说明改为与 §4.1 新规完全一致的语义(「current + 老于 current 中最新的 N-1 个;新于 current 的不计入也不碰」)。
- **§15 记录完整**:R1 摘要中 F4 表述已同步 R2 收口版(避免文档内两个版本的规则并存);R2 记录行含 verdict、残余清单、NIT 清单与全文路径。三轮评审的归属链(含 Codex 缺席原因与 Tadashi 轮级裁定)可追溯。

R1/R2 已确认的其余 12+0 条折入(F2 codex-homes 诚实边界、F3 releases 并发规则、F5 防线 3 降级、F6-F9、F10 settings.json 挪 install、F12-F14)本轮抽查未见回退。

## Findings

无阻塞或必须修的残余。三条**非阻塞 advisory**(实现阶段顺手覆盖即可,不需要再改 plan、不需要 R4):

- **A-1 [advisory]** §10 断言组 3b 未显式列 N-4 的新 case(锁目录在而 pid 文件缺失 → 按持锁退出、不清锁)。§5 规范已写明,TDD 红先行时应自然覆盖;实现时记得给它一条断言,别只测「held→退出」「stale→清锁重试」两态。
- **A-2 [advisory]** §5:131 的 R-3 运行时门(`--apply` 无既往 dry-run summary → 拒跑;`--force` 越过)未出现在 §10 断言组 8(组 8 只列了 install 端的 marker 门)。同上,实现时补一条断言。
- **A-3 [advisory]** §5:132 dry-run 语义里「连 settings.json 固化也跳过」一句已成遗迹(F10 后该动作在 install 脚本,不在每日 tick)——语句仍为真(dry-run 确实不做它),无矛盾,不必改;仅提醒实现者不要据此以为 tick 里有这个动作。

## Verdict

**APPROVED** — R2 全部残余与 NIT 忠实折入,全文一致性干净,无新 findings;3 条 advisory 转实现阶段(A-1/A-2 为测试断言补位,A-3 为阅读提示),不阻塞。plan 可按 §11 顺序进入实现(RED 先行);按仓库惯例,plan 状态可标 review-approved 并在 PR 阶段进入 code review 循环。
