# FLY-1942 通信层防线三件套 — 验证与交付状态
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: implementation.md

此文件记录 draft 创建时的本地证据；冻结 HEAD 后的 review、CI 与补跑结果通过 PR 描述和 flywheel-comm 交付回执关联。

- `pnpm lint`：首轮3个本次修改的测试格式错误，修正后通过，15条warning。
- `pnpm -r build`：两轮均退出0（第二轮包含TTL配置归类）。
- `pnpm test:packages:run`：R1配置治理2个遗漏断言失败，修正后14项green；R2旧E2E夹具4个失败及dependency1个timeout，夹具改为已注册UUID，两个文件46项green，dependency代码未改；R3已运行包断言通过，但Claude Runner50文件/1257项通过后出现Vitest onTaskUpdate RPC timeout，退出1。**本地完整包门非绿**。
- Lead `c5af927d-42af-4f52-bafc-a42fe69627e2` 允许保留上述RED并进入draft/review；下游四包各用 `VITEST_MAX_FORKS=1 pnpm --filter <pkg> exec vitest run` 补一次、保留退出码；必须exact-head CI绿且review通过后才能needs_review。
- 四包补跑：edge-worker、teamlead、voice-bridge、voice-codex，创建draft时仍在进行；日志索引 `/tmp/fly1942-serial-results.json`。此前默认并发补跑已中断，TeamLead exit130，不能充当此指定补跑。
- 最终6个shell/guard套件均exit0：generic launcher31、TUI-home64、Mufasa23、own-chat5、restart scanner313、installer11。索引 `/tmp/fly1942-final-shell.json`。
- Fork `4a34773`：244 Bun tests/674 assertions通过，server bundle通过；隔离rollback除版本0.0.9外与基线完全一致。见c7证据。

所有本次引入的行为均有记录的RED→GREEN；细分证据在implementation.md和c3/c4/c5/c6/c7文件。没有生产snapshot复制、生产重启、插件安装、Discord发送或QA回放证据。生产条件性验收按冻结plan交给后续节点。

## 指定补跑与修复回执

四个指定补跑均已完成并留exit：edge-worker=0、TeamLead=1、voice-bridge=0、voice-codex=0。TeamLead981文件：978通过/3失败，13118断言通过/47失败/7跳过；失败全部为三份旧mailbox夹具的recipient_malformed。与CI两个TeamLead分片的44+3失败完全一致。三份夹具只改为已注册UUID并把StateStore读取指向临时缺失路径，53项回归全部通过；生产代码无变更。CI ScriptTests2遗漏的TTL通用QA环境清理变量已补，原脚本回归全部通过。完整包门RPC红回执及旧HEAD补跑红回执保持不变，修复由新HEAD CI与正式review验证。

Fork R1 HIGH修复在988a5a4，244tests/677assertions与bundle、隔离rollback通过；后续R2待注册。Root正式R1待fork通过后串行注册。


主仓 R1 后仅修复 blocking restart-guard-ir-fail-open：guard 全套334/0、新增21回归、installer11/0、runbook62块零命中/dry-run pass。旧冻结034aedfa5的14项CI全绿仅代表旧HEAD；新HEAD将重新跑CI与root R2。此前本地完整包门RPC RED回执不变；本次Python限定修复不重复无关包测试，按Lead批准以新HEAD CI与正式评审作为交付门。


主仓 R2 后恢复治理裁定的可执行范围 regex 后备层：guard365/0、installer11/0、runbook62零命中/dry-run pass、lint0；CI暴露的新增测试清单同步后 kill-path inventory5/0。此次范围为Python guard、测试、QA-only inventory夹具与证据。需要主仓R3及新HEAD CI通过；本地全量RPC RED仍保留。


Lead授权有界R4只修tmux集合/操作数：9反例基线deny/修前allow/修后deny；完整guard387/0、installer11/0、inventory5/0、runbook62零命中、lint0。新冻结HEAD需有界R4 APPROVED和exact-head CI绿；此前本地全量RPC RED不改写。
