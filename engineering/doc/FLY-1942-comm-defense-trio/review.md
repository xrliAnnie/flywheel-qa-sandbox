# FLY-1942 通信层防线三件套 — 审查记录
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: validation.md

## Fork R1

Gate b0c743f6-ce50-435e-8845-ec855cd8838e，request2ceae247-844e-490b-8328-cbc643247f0b，reviewed head4a34773e3bbc3807bd7b9d7e7b22b1637b9d49b4。有效reviewVerdict与raw reviewerVerdict均CHANGES_REQUESTED。

HIGH findingKey `fork-marker-reply-guard-removed`：server.ts的[reply-guard]字面量被重构删除，两个Flywheel受管plugin checker以grep识别fork，会导致更新后完整性检查与Lead启动失败。确认属实；恢复unavailable/unauthorized的一行stderr诊断，并验证marker存在与真实wrapper输出。初始RED为marker缺失；修复后17 focused/78断言与完整244tests/677断言通过，bundle通过。修复commit988a5a4；两commit一起在detached临时worktree回滚后，除plugin.json=0.0.9外与e122f46无差异，diff --exit-code=0。

非阻塞advisories：`guard-outage-latency-5x`（MEDIUM）与`probe-outcome-http-on-ok-200`（LOW）不改，前者是冻结计划的4秒/一次重试合同，后者留Lead后续裁定；`guard-stderr-observability-lost`（MEDIUM）被上述HIGH所需诊断行同时覆盖，不单独扩展审计机制。全部原文位于本地review-state目录fork-review-r1.json，已通过ask --report转交Lead。

## 主仓

首个gate7730e76e在fork gate创建时被supersede，request注册409，未形成root审查轮次。按Lead要求串行：fork评审通过后再开root gate/request。Root已修正指定补跑发现的三份旧收件人ID夹具，以及CI发现的TTL变量通用QA环境清理接线；不更改无关测试/运行时代码。三份夹具53项全绿，test-deploy-generalized.test.sh全绿。

## rescue边界

codex:rescue通过companion task --fresh只读调用，初始化时sandbox_apply Operation not permitted，未产生审查结果。Lead裁定1f23d830-9e62-4bbd-9b50-a74dfb1d0cd1：rescue仅辅助，不重试、不用裸codex exec绕过；Bridge注册的cross-family reviews与两仓exact-head CI才是交付门。


## Fork R2 与主仓 R1

Fork gate `c4327407-6f36-445c-82f2-7876d89283d5`、request `ff806721-b492-4fc9-bb6d-69cb0a592eef` 在 `988a5a4fa1682b05e9153ebe795cce37a47529c0` 返回 APPROVED（raw 同为 APPROVED），该 HEAD test CI 通过。非阻塞建议：固定重试延迟、HTTP200 错误体诊断、其他旧 marker 覆盖；已上报，不扩展实现。

Root gate `092ec193-8e3f-452e-9afd-87898273eaef`、request `819f2fec-ae2e-4e76-be38-18472cae7bd8` 在 `034aedfa52032b76f40e557dd7877fc384f21f5f` 返回 CHANGES_REQUESTED。该 HEAD 的 14 项 CI（含 CI OK）全部通过；评审与 CI 是独立门。工作流返回 round=2 是共用检查点计数，此为主仓首次成功注册的审查。

唯一 HIGH `restart-guard-ir-fail-open`：compound shell 的 do/then/括号遮蔽命令 head，带空白的 pgrep substitution 目标丢失，赋值引用目标遗漏，未闭合引号触发 parser 异常后静默放行。按 blocking 修复并重新评审。评审提及探索阶段排除 restart guard；当前冻结 v5 plan 的 M4a/C4 已明确纳入该项，以冻结计划为准，不回退该功能。

非阻塞建议已通过 ask --report 交 Lead：`respond-terminal-breaks-fly161-ec1`、`reengage-guidance-now-false`、`roundtable-parent-fallback-drops-launchers`、`dead-letter-sender-route-cursor-replay`、`registry-infinite-ttl-unparseable-deadline`、`send-json-error-is-not-json`、`duplicate-gateway-start-helper`。本轮只修 HIGH，不修改这些行为。

R1 HIGH 修复已完成 RED→GREEN，21 新增回归、全套 guard 334/0、installer 11/0、runbook 62 块零命中，详见 c4-evidence.md。新 HEAD 需重新通过主仓评审和 CI；fork 988a5a4 的通过回执继续有效。


## 主仓 R2 与后备层裁定

Gate `39f175b1-ac48-4026-bac5-33d0adf7c3c8`、request `30a4156d-09c6-464e-8348-756b9bcccb4b` 在 `6e08792f47ad36404c702e6438b8b39416fe449f` 返回 CHANGES_REQUESTED。评审确认 R1 所列机制均已修复、334/0 和 13 个文档消息形态无新误报；新增 HIGH `restart-guard-ir-coverage-gap` 指出执行载体、case/function/trap 与合并标点仍有覆盖遗漏。LOW `restart-guard-dead-regex-helpers` 随需恢复第二层的 HIGH 一并处理，不额外删除代码。

Lead 指令 `[lead-instruction a8fc72dc-de89-46ed-b0b8-634c27d4b273]` 要求恢复 regex 后备层；后续明确裁定问题 `27252ba2-023a-4fbe-9251-145ef76b6615` 取代最初全原文 union：regex 检查 IR command stages 与已知可执行载体 payload，格式正确的引用字符串参数和 quoted heredoc 保持负向放行；畸形引号、未引用 heredoc、展开正文与无法分类片段按可执行处理。十四类遗漏与冻结 MUST_PASS 同套验证；一次推送后主仓 R3 为轮次上限，再打回需原文报告 Lead，不开 R4。

6e08792f4 的 heavy CI 失败为新增 guard 测试两条 kill -9 字面量未同步既有机械 inventory。仅以原扫描器补齐 QA-only 夹具条目，保留分类与断言，不修改无关运行时；本轮新增 grouped-pipeline 用例也由相同扫描器归档。

R2 HIGH 修复完成：365/0 guard、31 新增载体/语法控制、installer11/0、runbook62零命中、lint0、kill-path inventory5/0。后备层恢复遵守27252ba2的可执行范围；未使用 `_non_read_segments` LOW 继续留档。下一冻结HEAD进入root R3与新CI。


## 主仓 R3 与有界 R4 授权

Gate `33e05dac-9497-4a1d-97c8-6853a17c790a`、request `2a69e2a4-dc57-4fe2-a4d2-0588a6ad1434` 在 `75cfaf5056457189936208e6f00c6b15cf79b0c0` 返回 CHANGES_REQUESTED。评审确认 regex 第二层、合并标点与此前反例已恢复，365 guard/11 installer/5 inventory 通过，4000 随机输入无异常；唯一 HIGH 仍为 `restart-guard-ir-coverage-gap`，限定 tmux 已建模载体漏掉 new-window/new-session/split-window/respawn-pane/respawn-window/if-shell/popup 及别名。

已按上限将原文交 Lead，未擅开 R4。Lead 回复 `f9863a46-4813-4d78-9050-395c6f228e24` 授权一次有界 R4 确认轮：仅扩充指定 tmux 集合与参数提取，九个反例做 merge-base deny/修前 allow/修后 deny 证据，一次推送。R4 非 APPROVED 或无法运行须报告，不开 R5。at/docker/expect/screen/heredoc-ssh 残余作为明确非阻塞范围留档，不修。

新增 MEDIUM `restart-guard-expansion-in-quoted-text-overblocks` 对应27252ba2的保守展开规则；不修改。LOW regex helpers已被评审确认解决，只有一行 `_non_read_segments` 未使用，评审明确无需动作。其他旧 advisories 保留。

有界R4补丁验证完成：9反例三方对照、T16新增22/0、全guard387/0、installer11/0、inventory5/0、runbook62零命中、lint0。仅tmux集合/参数与测试、证据，其他carrier与advisory未改。将一次推送并注册Lead授权的有界R4确认。
