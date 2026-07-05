# Ship Checklist — FLY-182 Track A (PR #208, v1.31.0)

**Status**: 备好待执行(Annie 定 ship 时机)。Codex code review APPROVED + CI 绿。
**Scope**: mailbox/sidecar prune + unread-overflow marker + report-only dead-team GC。
**碰生产吗**: 是 —— **prune 要 Bridge rebuild+restart 才生效**(见下,纠正"部署很轻不动 Bridge"的说法);**GC 那部分才是不动 Bridge**。
**前置**: 系统稳(177 重跑完、cmux 缓过来),无 live Runner 正卡在投递。

---

## 0. 这个 PR 实际改了什么(决定部署动作)

| 改动 | 跑在哪个进程 | 激活方式 |
|------|------------|---------|
| `mailbox-prune.ts` + `ClaudeMailboxCodec.ts`(prune on write/markRead) | **Bridge 进程**(经 `MailboxLeadRuntime.deliver` → codec)+ `flywheel-comm` CLI(每次 spawn 新进程) | Bridge 需 **rebuild + restart**;CLI 下次 spawn 自动用新 dist(需 build) |
| `plugin.ts` `resolveMailboxWriteTimeoutMs` 接线 | Bridge 进程 | 同上(Bridge restart) |
| `scripts/mailbox-gc.mjs`(死 team GC) | 独立手动脚本 | 人手动跑,**不碰 Bridge/Lead** |

**结论**:
- **要激活 prune**(防 mailbox 再次无限涨)→ **必须 Bridge rebuild + restart**。
- **死 team GC** → 纯手动脚本,**不动任何常驻进程/配置**。
- Lead 进程**不用重启**(Lead 只读 inbox via stock poller;prune 在写入侧)。
- **急迫性低**:本次事故已止血(Peter inbox 清空,当前活 Lead inbox 都小)。prune 是**预防**未来增长 → Bridge restart 可挑稳的时机做,不必抢。

---

## 1. Merge + 上线 prune(Bridge 侧)

> ⚠️ FLY-176 部署正解 + 已知坑。**不要盲跑 `restart-services.sh`**(multi-PID kill bug,撞过 3 次)。

1. **Merge PR #208**:CI 绿 + Annie :cool 后 `gh pr merge 208 --squash`(或按项目 ship 流程)。
2. **主仓同步**:`cd ~/Dev/flywheel && git checkout main && git pull`(**绝不 push main**)。
3. **`pnpm -r build`**(**必须** —— FLY-176 Bug 1:不 rebuild dist 则运行的还是旧码,且 `flywheel-comm` CLI 用旧 dist)。
4. **重启 Bridge 激活 prune**(FLY-176 multi-PID kill bug workaround):
   ```bash
   pgrep -f run-bridge | xargs kill -9          # 逐清旧 Bridge(脚本的 kill 会漏多行 PID)
   launchctl kickstart -k com.flywheel.bridge   # 第一次可能 exit 37 throttle → 再 kickstart 一次
   ```
   - **Lead 不重启**(Track A 只动 Bridge 写入侧 + CLI)。
5. **验证 Bridge 起来了**:
   - `pgrep -f run-bridge` 有新 PID;boot log 无报错。
   - boot log 应能看到正常启动(无 prune 专属日志,prune 在写时静默生效)。
   - 可选:观察一次真实投递后,对应 Lead inbox 文件没异常膨胀(prune 在写时裁剪已读)。

**env 调参(可选,默认即安全)**:`FLYWHEEL_MAILBOX_READ_KEEP`(50)、`FLYWHEEL_MAILBOX_READ_RETENTION_MS`(24h)、`FLYWHEEL_MAILBOX_UNREAD_WARN`(200)、`FLYWHEEL_MAILBOX_SIDECAR_RETENTION_MS`(7d)、`FLYWHEEL_MAILBOX_SIDECAR_KEEP`(2000)、`FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS`(3000)。**不设全用默认**。

---

## 2. 死 team 目录 GC(独立,不动 Bridge/Lead/配置)

> ⚠️ **最高风险项** —— team-lead 今天误删过活 agent。脚本已 report-only 默认 + 全探测 fail-closed + 删前 tar 备份,但**仍由人复核驱动,绝不自动横扫**。**有 live Runner/Lead 时别 --apply 那个 team。**

1. **report-only 复核**:
   ```bash
   node scripts/mailbox-gc.mjs            # 默认 report-only,只打印 DEAD/UNKNOWN/ALIVE,不删
   ```
   - 人肉核对 DEAD 列表(实测会列 flywheel-sprint 854KB、fly-129 629KB 等老 sprint;活 team fly-177 / 3 个 Lead / QA slot 都判 ALIVE 受保护)。
2. **逐个删确认死的**(必须显式 `--team`,无批量):
   ```bash
   node scripts/mailbox-gc.mjs --apply --team <确认死的 team 名>
   # 自动:验 verdict==dead(全 fail-closed 探测) → tar 备份到 ~/.flywheel/backups/team-gc/<ts>/ → rm -rf
   ```
   - 任一探测失败(pgrep/tmux/config/mtime)→ 脚本 ABORT 不删(fail-closed)。
   - 非 direct child / 非法名(`..`/`-rf`)→ ABORT。
3. **不急**:死 team GC 纯清磁盘,随时可做,不影响运行。

---

## 3. 验收 / 回滚

**验收**:
- Bridge restart 后:活 Lead 投递正常(无 writeVerified timeout 雪崩),inbox 文件随投递自动裁剪、不再单调增长。
- GC:report 列表里活 team 全 ALIVE(已实测);--apply 只删人确认的。

**回滚**:
- prune:env `FLYWHEEL_MAILBOX_READ_KEEP` + `READ_RETENTION_MS` 设极大 → 等效禁用裁剪;或 revert PR + rebuild + restart Bridge。
- GC:脚本无常驻副作用;误删可从 `~/.flywheel/backups/team-gc/<ts>/<team>.tar.gz` 还原。

---

## 4. 与 Track B(PR #209)的关系

- **独立可分开 ship**。Track A 不依赖 B1/B2 配置。
- Track A 写的 `~/.flywheel/state/mailbox-overflow/` marker,**只有 Track B(PR #209)的 self-monitoring 会读它发 meta-alert**;Track A 单独上线时 marker 只是写在盘上无人消费(无害,等 Track B 上线接通)。
- 两 PR 都 ship 后,Bridge 一次 restart 即同时激活 A(prune)+ B(self-monitoring/告警可达性校验)。**若同期 ship,合并一次 Bridge restart 即可。**

---

## TL;DR 给执行人

```
# 激活 prune(Bridge 侧):
gh pr merge 208 --squash
cd ~/Dev/flywheel && git checkout main && git pull
pnpm -r build                                  # 必须
pgrep -f run-bridge | xargs kill -9            # FLY-176 workaround
launchctl kickstart -k com.flywheel.bridge     # exit37 throttle 就再来一次
# Lead 不用重启。

# 清死 team(独立，不动 Bridge）：
node scripts/mailbox-gc.mjs                     # 复核 DEAD 列表
node scripts/mailbox-gc.mjs --apply --team <name>   # 逐个，确认死的才删（自动备份）
```
