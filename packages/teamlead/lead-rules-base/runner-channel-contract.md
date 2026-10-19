## Runner 通道契约(FLY-3083,所有带 Runner 的 Lead 通用)

1. 给 Runner 发消息**只有一条路**:`flywheel-comm send --from <你的 lead id> --to <runner 队名 runner-xxxxxxxx 或 execId> -- <正文>`;答 gate 用 `flywheel-comm respond`(命令在收件箱信封里,照抄)。
2. 禁止的旁路(不留 CommDB 账、没有编号、丢了没人知道):`SendMessage to:"runner-*"`、`SendMessage to:"*"`(广播)、直接写收件箱文件、`codex queue --remote` / `codex resume` 直接 steer Codex Runner。Claude Lead 的前两种会被 `flywheel-runner-msg-guard` hook 当场拦下(拦下理由里带可直接运行的 send 命令);其余靠本契约。
3. `send --json` 的 `transport_write`:`ok` = 已写进 Runner 传输层,**不是**消费确认(消费证据 = Runner 的回执 / 终端里的 `[lead-instruction <id>]`);`skipped` + `backend_commdb` = 回滚模式,正常;`skipped` + `no_transport` = 该 Runner 后端无传输(antigravity/kimi,走 pr_handoff),正常;`skipped` + `no_session_lead` 或 `error`(看 `wake_error`)= 通道故障 → 按第 5 条报 `transport_error`;修好后只在确认未送达时重发同一内容。
4. `ok` 但 10 分钟无回执,**且** Bridge 对该 Runner 报 idle/stuck(或终端 capture 无变化)= **疑似**停滞,是调查触发器、不是确诊:收集 instruction id、CommDB 该行 `created_at`/`delivered_at`、最后一次终端 capture、idle 事件时间,按第 5 条报 `suspected_stall`,措辞写「疑似」;不重启 Runner。Bridge `/health` 只证明 Bridge 活着,证明不了投递正常。
5. 任何故障分支都**不换旁路**。上报照抄(`<anchor_instruction_id>` = 本次故障 episode 的**第一条**受影响 instruction id,同一 episode 的重试沿用;恢复后再出现用新锚点):
   ```bash
   bash "${FLYWHEEL_LEAD_ALERT_SCRIPT:?FLYWHEEL_LEAD_ALERT_SCRIPT 未注入(Lead 启动缺陷)— 改在 issue thread 明文报告}" \
     --lead "$FLYWHEEL_LEAD_ID" --project "${FLYWHEEL_PROJECT_NAME:-$PROJECT_NAME}" \
     --kind mailbox_channel_fault --severity severe --strict-delivery \
     --signature "mailbox:<execution_id>:<subkind>:<anchor_instruction_id>" \
     --title "Mailbox channel fault (<subkind>) runner <runner 队名> issue <FLY-xxx>" \
     --body "subkind=<subkind>\nanchor_instruction_id=<episode 首条 id>\ninstruction_id=<本次 id>\nexecution_id=<execution_id>\nsent_at=<send 时间>\nevidence=<一行证据>"
   ```
   看最后一行结果:`sent` / `queued_transient` = 已升级;`duplicate` = 该 signature 已被 claim、**投递状态未知**——手头没有这个 episode 此前的 `sent`/`queued_transient` 结果或 issue-thread 上报凭据时,在 issue thread 明文报告并写明「告警投递状态未知」;`dead_lettered` / `config_error` / 其他 = **未升级**,必须在 issue thread 明文向 founder 报告通道故障。
