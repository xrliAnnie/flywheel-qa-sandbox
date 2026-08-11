# FLY-1676 Sync Upstream 上膛 — founder 操作卡

Issue: FLY-1676 (https://linear.app/geoforge3d/issue/FLY-1676/chore-把-discord-plugin-fork-整个追平上游-rebase-我们的定制-修好自动同步-founder-裁定不)
日期: 2026-08-10
基于: plan.md

## Annie 只需做的一件事

为 `xrliAnnie/claude-plugins-official` 创建一个 **fine-grained PAT**,repository access 只选这一个仓,权限只开:

- Contents: Read and write
- Workflows: Read and write

然后在自己的可信终端交互式写入 Actions secret(不要把 token 粘进 Discord、issue、命令参数或截图):

```bash
gh secret set SYNC_PAT --repo xrliAnnie/claude-plugins-official
```

命令会等待 stdin,此时再粘贴 token。完成后只验证 secret 名存在,不要读值:

```bash
gh secret list --repo xrliAnnie/claude-plugins-official
```

看到 `SYNC_PAT` 即停止;把“已设好”告诉 Tadashi。不要自己 enable workflow 或 dispatch sync。

## Tadashi / land+QA 后续门控

0. **硬前置**:FLY-1679 / Flywheel PR #801 必须先 land,且 poller 已从「仅 inbox=true」修正为「任何 development channel 活跃」;用它的 `SKIP_DEV_CHANNELS_WORKAROUND=1` 杠杆分别证明 inbox=true 与 companion/external inbox=false 的 v2 冷启动都不靠外部代偿、零人工确认 development-channel 框。未满足不得 merge/cutover FLY-1676;
1. **merge→cutover 是同一个冻结窗口**:开始前冻结所有其他 Flywheel deploy/self-ship;FLY-1676 PR 合入后,`update-flywheel.sh` 会在 pull 前识别 pointer selector + legacy live checker 并 fail-stop,任何其他 marker 会重试后 blocked + severe。不要绕过,不得「先合了改天再切」;由持锁 cutover 的 `deploy_sha` 立即完成 checkout 前进,cutover 通过/完整反向恢复后才解冻;
2. **squash** land fork PR #19,workflow 仍保持 disabled;合入 commit subject 必须保留 `chore(discord): advance sync version` 前缀(当前 PR 标题已钉住),否则首次 catch-up 会多出第 21 个 patch,立即停;
3. **Discord `plugin.json` patch version 是舰队可用性的单点**:每次 fork main 前进必须由 workflow 在 byte guard 通过后 bump patch;同版本 non-FF 改写会让 CLI 报 already latest、registry 停在旧 SHA,随后所有 Lead checker/recheck fail-stop。禁止手推漏 bump 的 main,回滚锚点也必须携带与目标字节匹配的版本;
4. 完成 pre-catchup tag / 20 个定制 patch 盘点;
5. 在受控窗口 enable 后先跑 `test_alert=true`,确认真 Discord 回执且 main SHA 前后不变;
6. 再跑 `test_discord_guard=true`,确认 push 被挡 + 告警;
7. 最后才 dispatch 真 catch-up;任一步失败立即 disarm-and-drain。

## cutover 后解除冻结前的 channel 硬门

1. cutover 在 bootout/部署前必须先从 target SHA blob 证明 development-channel selector + FLY-1679 v2 poller 对所有 Lead 生效;pre-start 再从 deployed checkout 复核同一 contract 与 pointer installPath/标志。MCP 进程根只算字节来源,**不算 channel 已注册**;
2. 真 CLI A/B:新 development-channel selector 无 allowlist 拒绝;旧 `--channels plugin:discord@flywheel-plugins` 对照被拒;
3. 在 `SKIP_DEV_CHANNELS_WORKAROUND=1` 下冷启动一个真 Lead,零人工按键,确认记录只在框消失后出现;
4. 由另一 bot 在隔离房发一条消息,目标 Lead 真收到并回复;随后真调 `fetch_messages` 拉历史。任一步失败都按 plan §4.3-5 跑完整反向事务,不得凭 adapter 已启动判绿。

PAT 过期或权限漂移后,workflow 会红并走 Discord 告警;GitHub Actions email 通知 + 每周 run-history 巡检是 webhook 自身不可达时的 out-of-band 兜底。
