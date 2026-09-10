# FLY-2455 529 房启动恢复 — PR 正文草稿
Issue: FLY-2455 (https://linear.app/geoforge3d/issue/FLY-2455/529-房台架-test-deploysh-起不来-529-slot-lead卡在-qa-launchd-topology-校验)
日期: 2026-09-09
基于: root-cause.md, implementation.md

当前 main 上 slot Lead carrier 能启动，但 inbox MCP 把注入的 slot CommDB 路径重算为 HOME。部署在 slot 内等待 readiness lease，实际写者却在 HOME，120 秒后失败。本 PR 让 inbox 配置复用 launcher 已解析的 FLYWHEEL_COMM_DB，并补齐具体 bootstrap 失败诊断和受保护的 QA 正文证据。

**C4 not yet run。** 本 PR 为草稿，尚不声称真实起房、Lead 收件或干净拆房已恢复。Lead 已批准先取得同一冻结 HEAD 的代码审和 CI，再由宿主执行 C4；不派 QA、不 merge/deploy。

## 根因与修复

- 根因修复69e5f61d5：inbox stanza复用显式DB；原HOME默认、ROOT传播、resolver优先级保持原合同。
- 诊断C1/C2：失败后有界采样launchd/manifest/tmux，输出phase/reason/label/path；QA受信环境开启256KiB正文捕获、退出语义和generation关联；未处置证据保留锁并拒绝重认领。
- deadline补正914c5d3b8：直接child退出但继承管道仍开时，也受同一个2秒deadline约束；仅对自己启动的直接child执行既有清理。
- 清单修正5ac7a0e85：登记三处本单QA-only kill/probe调用，未放宽扫描器。

历史9-8 topology失败本轮没有复现，不能把当前readiness缺陷追认成历史唯一根因。详见[root-cause.md](engineering/doc/FLY-2455-slot-lead-bootstrap/root-cause.md)和[implementation.md](engineering/doc/FLY-2455-slot-lead-bootstrap/implementation.md)。原plan/root-cause审批字节未改。

增量设计有效/raw APPROVED：gate2a16bc80-68b9-44ba-bbab-e857901b7dbd，request3cb33a4b-bdeb-4128-bd81-878eec964634。

## C3 宿主证据和依赖

FLY-2454 PR#1137 merge为5cbd540f1bfdee28dd474f89ecb1523a4507473b；[隔离QA报告](https://fw-reports-a53de2.vercel.app/r/73b017d734f2bcab8190af32605af55b/)覆盖runner/清理隔离，不覆盖本轮发现的Lead inbox HOME consumer。

两轮均运行：`TMPDIR=/tmp/q7 bash scripts/test-deploy.sh 2 --extra-lead 3:Ops-Test`。driver为1e58241d99d156ea72069cf8f3ce8ec9f0207da0。

- baseline5cbd540f1：2026-09-10 01:25:31.163048Z→01:28:42.408563Z，deploy1，191.244秒；teardown0，5.345秒。HOME comm残留，整体FAIL。证据目录20260910T012501Z-c3-5cbd540f1bfd。
- diagnostic1e58241d9：01:30:53.225382Z→01:33:41.728284Z，deploy1，168.502秒；teardown0，2.999秒。同一HOME残留，整体FAIL。证据目录20260910T013024Z-c3-1e58241d99d1。

原始证据0600保存，索引hash、源码完整因果链、单变量A/B及FLY-2174 alerts/TMPDIR排除见root-cause.md。现场错过live child env投影，源码/A-B不冒充该证据。

## 验证

- 真实body/launcher生成CWD .mcp.json，受控Claude child用真实stanza和最终env启动真实inbox，外层核对slot DB、live lease/PID、零新增HOME residue、child/lease清理。RED17/1→GREEN18/18→单行mutation17/1→恢复18/18。Claude是替身，这不是实际Claude MCP或Discord端到端证据。
- 默认HOME和含空格override的真实配置生成器回归通过，package shell显式登记ci.yml；root枚举门不宣称覆盖全部package shell。
- 最后diagnostics9/9、verifier与mutants、C5其余shell、inventory5/5、CI枚举及删行mutation通过。宿主fly1389为23/23：工作树b339189a2加未提交根因改动，但该suite复制的deploy/teardown/lib输入与HEAD相同，launcher为stub；保留此来源限定。
- pnpm lint exit0（14 warnings）；pnpm -r build exit0。
- 指定packages分组第二轮exit0，1298.495秒；TeamLead918files/12372pass、claude-runner49files/1224pass、edge-worker111files/1318pass、comm152files/2172pass。core分组219/219，release-contract24/24。Vitest单worker forks，按计划仅排除真实Terminal GUI文件，现有skip数量保留在原回执。
- 首轮packages因漏登记三条kill inventory而exit1，已修正并重跑；不声称首轮通过。第二轮期间加入了root Python/Node deadline补正，独立root gates通过，不把该本地回执称为从头冻结HEAD验证。
- 本次main集成检查无冲突。正式代码审和exact-head CI14/14待本PR触发，旧回执不能替代最终HEAD。

## C4、限制与回滚

C4 not yet run。待宿主对冻结HEAD执行普通及alerts双Lead起房、slot /api/health 200且buildSha精确相等、每个Lead的label/PID/socket/live lease核对，随后按test-slots.json验证slot bot身份、POST/DELETE/GET/allowBots前置并取得唯一nonce的message ID和Lead实际消费证据，再验拆房及非slot对照、起止UTC和耗时。

若topology复发，继续诊断，不能收口；bot前置不足则报告“发送前置条件未满足”，不扩权。FLY-1948是否同源仍待C4；独立Discord断点向Lead报回该单并保留未满足验收项。

无schema migration。revert单行根因修复会恢复HOME重算/slot等待失败，应停止相应演练。不自动迁移/删除HOME数据，不回退FLY-2454，不放宽identity/隔离/证据锁。撤诊断前须由owner确认Lead/recorder已停止并安全处置原始正文。

版本基线doc/VERSION为v1.56.0。本单未修改发布版本。

Follow-up：
- Lead lane的DB/ROOT合同与一致性守卫交Lead决定后续，本次不扩写ROOT传播或resolver。
- FLY-1948收件关系及slot bot前置由C4给出实证。
