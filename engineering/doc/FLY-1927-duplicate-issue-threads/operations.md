# FLY-1927 正主根消息丢失 — 人工放弃手册
Issue: FLY-1927 (https://linear.app/geoforge3d/issue/FLY-1927/bugthread-新建-issue-会开出多个-thread至少一个不对18671925-实证-实际工作-thread-与登记正主脱节)
日期: 2026-08-20
基于: design-correction.md

---

只在 Bridge 返回 `canonical_root_gone`，且操作员已经分别确认 Discord thread 与父频道根消息都不存在时使用。正常 timeout、429、5xx、403 都不能放弃正主。

## 1. 只读核对

把三个占位符替换成报错里的精确值；先只读，确认恰好一行：

```bash
sqlite3 -readonly "$HOME/.flywheel/teamlead.db" \
  "SELECT thread_id, channel_id, issue_id, discord_missing_at FROM chat_threads WHERE issue_id='<ISSUE_ID>' AND channel_id='<CHANNEL_ID>' AND thread_id='<ROOT_MESSAGE_ID>';"
```

再用该 Lead 的 bot token 核对 Discord：

- `GET /channels/<ROOT_MESSAGE_ID>` 必须是 404；
- `GET /channels/<CHANNEL_ID>/messages/<ROOT_MESSAGE_ID>` 必须是 404。

任何 200、401、403、429、5xx 或 timeout 都停止操作，不把“不知道”当成“不存在”。

## 2. 精确 fenced 放弃

先备份数据库，再执行单行 CAS；`changes()` 必须等于 `1`：

```sql
BEGIN IMMEDIATE;
UPDATE chat_threads
   SET discord_missing_at = datetime('now')
 WHERE issue_id = '<ISSUE_ID>'
   AND channel_id = '<CHANNEL_ID>'
   AND thread_id = '<ROOT_MESSAGE_ID>'
   AND discord_missing_at IS NULL;
SELECT changes();
COMMIT;
```

若 `changes()` 是 `0`，说明正主已变化或已被处理；不要扩大条件、不要无 fence 删除。标记成功后，下一次 `/api/chat-threads/create` 或缺行的 `/api/chat-threads/send` 才能发新根消息并占新正主。
