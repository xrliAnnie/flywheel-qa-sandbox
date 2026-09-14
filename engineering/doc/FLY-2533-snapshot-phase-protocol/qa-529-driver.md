# FLY-2533 Snapshot 阶段协议 — 529 实测操作
Issue: FLY-2533 (https://linear.app/geoforge3d/issue/FLY-2533/病根-非-work-kind-项目起-runner-不带-taskcategory-409-dag-entry-not)
日期: 2026-09-13
基于: plan.md

本文件是持有 QA TURN 的后继节点操作说明。实现节点只准备脚本和运行无副作用的 guard tests；没有部署 slot、启动 runner 或取得 B/C 实测证据。

## 输入与隔离预检

`node scripts/qa-fly-2533-phase-protocol.mjs prepare|run|observe arm.json` 使用现有 `test-deploy.sh` 普通真实 Claude slot 的 stdout JSON，**不使用 `--generalized`、`--stub-runner` 或 Codex Lead**。generalized deploy 会创建 registry，现有 generalized E2E 即便传 `--real` 仍有 stub-state 驱动步骤，不能用来替代本单对照。

QA 先按 `test-deploy.sh --help` 选择两个空闲隔离 slot，从 baseline `26ebc4931` 与候选 exact PR head 的独立 `/tmp` 代码 checkout 部署；保存完整 stdout JSON，各自保留原 slot delivery secret。两臂使用相同 sandbox 初始 Git HEAD、同一已授权测试 issue（内容应要求本脚本 TASK 的小型 add 函数任务）、相同完整 Claude model 与 effort。不能派真实产品 issue，不得向生产 channel 发消息。

每臂配置为 JSON（值必须来自实际 deploy/审核选择；示例不是执行参数）：

```json
{
  "arm": "baseline",
  "deployJson": "/tmp/flywheel-test-slot-1/deploy.json",
  "codeRepo": "/tmp/fly2533-baseline",
  "expectedSha": "<40-character baseline Git SHA beginning 26ebc4931>",
  "apiTokenPath": "/tmp/flywheel-test-slot-1/<private slot master token file>",
  "issueId": "<authorized sandbox fixture issue>",
  "modelAlias": "<supported Claude menu model alias>",
  "model": "<full effective claude-... model ID>",
  "effort": "<supported effort>"
}
```

普通 deploy 不自动在 stdout 暴露 `apiTokenPath`；QA 必须从受支持隔离启动配置确定实际 slot master credential 文件，不得拷生产 master token、把 token 放 argv 或写入证据。若普通 slot 没有受支持 master token 入口，停在此处报告基础设施未具备，不能把 generalized room 标记改成 ordinary 来绕过校验。

脚本读取本机 `~/.flywheel/test-slots.json` 校验 exact port/Lead/channel；拒绝生产项目、生产路径、路径逃逸、registry 和 stub。复用 `qa_launchd_lead_verify` 检查 launchd PID/manifest PID/private tmux main，并检查 slot inbox lease PID live、HTTP health buildSha 与代码 checkout HEAD 相同。DB 只读句柄在退出时关闭；prepare 的 seed 写入只经现有 slot helper。

## prepare / run / observe

1. 每臂运行 `prepare`：保存初始 HEAD，创建相同纯领域 implement/qa 手册和小任务文件、simple_code adoption、两个不同文件的 roster；调用既有 `qa-generalized.mjs seed-bindings` 与 `seed-project-flags`。它不创建 registry、不改 config schema、不替换已有不同内容。seed helper 会建立六个显式类别 binding，**不会建立 `*`**。
2. QA 将这几个已准备文件提交到测试 sandbox（包括 deploy 已生成的合法 config、adoption、roster），确认真实 runner 的 start ref 包含该 fixture。`run` 检查三个领域/task 文件已进入 HEAD；**runner start ref 可见性仍需 QA 从真实 session/worktree 检查**，不能仅凭 host 文件存在宣称可见。
3. 运行 `run`：POST 显式 `taskCategory: simple_code`，implement/qa 使用相同钉住的 model alias/effort overrides。保存 fresh UUID idempotency key 和服务器 run id。不覆写已有 start receipt，不手工调用 qa-result、不批准 ship、不自动 merge。
4. 读取权威 snapshot 验证 QA `dispatch.vendor=claude`、完整 model/effort；不从角色名推断。保存 snapshot 全文及协议/领域内容。等待真实 implement 进入 QA；最多一小时仍无 QA activation 则报未证实。
5. 从第一 QA activation 的 `bound_at` 固定十分钟窗口，每三十秒读取 slot DB。接入时已经错过超过一分钟、或恢复观察出现超过一分钟空白，拒绝宣称完整窗口。`observe` 可恢复已有 start receipt 的短暂停顿；长空白应重新进行独立 paired run。
6. accepted 证据连接 `workflow_submission_credential.claim_id` 与 `workflow_claims`，要求 consumed credential、family=qa_verdict、exact run/node/attempt/activation/execution、Claude issuer、serverSeq 和 subject digest；只收集窗口内消费的 claim。不读 credential hash/token。

证据写在 slot 内 `fly2533-baseline/` 或 `fly2533-candidate/`：prepared、start、snapshot、window、observations、result。`result` 包含 SHA、digest、固定 dispatch、模板、activation、claim/serverSeq、predicate、subject 与观察结果。工作流状态逐次保存在 observations。

`node scripts/qa-fly-2533-phase-protocol.mjs compare baseline/result.json candidate/result.json` 核对 fixture/model/effort/初始 HEAD/issue/模板/窗口相同且 run 不同。candidate 无 accepted PASS => FAIL；baseline 也提 claim => UNPROVEN_BASELINE_ALSO_CLAIMED；baseline 无 claim 仅写 `NO_CLAIM_IN_WINDOW`。compare 未通过退出 2，绝不把 baseline 成功改写为“注入前卡住”。

## C 故障注入和收尾：QA 独立操作

本驱动**未自动化 C 的协议文件移走/replay/恢复/零副作用断言**。QA 按 plan §9 在 candidate slot 的部署包目录操作，禁止删源码或生产文件冒充：

- 对实际 Bridge 包 `phase-protocols/qa.md` 保存字节/权限与路径证据，移到同一 slot 暂存目录；使用 finally/trap 保证恢复。
- 使用新 idempotency key 发起新运行，捕获响亮 qa 类型错误；开始前后通过只读隔离 StateStore 比较 run、reservation、session/running、effect 数量以及已有 shadow 未 supersede。没有启动后报错不能算 C。
- 在资源缺失时恢复一个已有 snapshot，保存原 content 与 snapshot_digest 未变化的权威证据。恢复文件后再次新运行正控。
- 关闭所有 DB 句柄；若复制 live DB 只能走 snapshot-control。收齐证据后按既有 `test-teardown.sh` 使用准确 slot 清理。

单元 guard green 不证明 B/C、fixture 向真实 worktree 传播或外部 Claude 行为。本脚本尚未经真实 slot 执行，以上入口/模型选择/runner start ref 必须在 QA TURN 验证并记录。
