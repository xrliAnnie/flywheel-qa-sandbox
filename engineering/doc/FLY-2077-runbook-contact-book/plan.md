# FLY-2077 runbook + contact book 进仓 — 实施计划
Issue: FLY-2077 (https://linear.app/geoforge3d/issue/FLY-2077/2073册子-runbook-contact-book-进仓骨架-第一版底稿读者-infra-bot通用写法)
日期: 2026-08-27
基于: research.md

> 2026-08-27 重做版：founder 已确认 Lead 的删减方向。旧版的代码守卫、深度 Bridge 作业和自动抽验装置全部退出范围。

## 交付物

1. `doc/oncall/README.md`：总规、入册责任、五个最少栏位、无本机上下文抽验、新类别上线闸门。
2. `doc/oncall/contact-book.md`：一张「类别 → 找谁」表，按当前组织如实覆盖已知类别。
3. `doc/oncall/runbooks/_template.md`：五栏模板。
4. 三页薄底稿：`bridge_abnormal_exit.md`、`mailbox_dead_letter.md`、`cmux_cleanup.md`。
5. `admission-rehearsal.md`：用一条真实告警演练「新类别出现 → 册子落位」，只保存非敏感验收记录。

## 实施顺序

1. 删除旧版 CI、shell guard、会话 harness、生成页面和深度作业内容。
2. 将目录统一为 `doc/oncall/runbooks/`，重写 README、模板和三页底稿。
3. 把 contact book 压成一张简单表；多数类别直接指向 Tadashi。
4. 记录真实告警入册演练。
5. 验证 PR 只含 Markdown、所有页面五栏齐全、不含本机值或旧版 Bridge 机械对账内容。
6. 更新 PR，固定 exact head 请求评审；Implement 节点以 `needs_review` 路由交给 DAG 后续 QA。

## QA 判据

- `doc/oncall/` 的目录、README、contact book、模板、三页底稿齐全。
- 一条真实告警的入册演练有可复核记录。
- QA 抽一页，让不带本机上下文的 bot 只靠告警文本和册子走通。
- PR 零代码；不残留旧版 Bridge 机械对账内容。
