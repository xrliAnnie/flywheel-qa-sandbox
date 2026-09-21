# FLY-2753 本机定向验证 — 实施记录
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: plan.md

## 授权与范围

实现执行 `5b282e65-facd-4f73-bc17-430904c0c74f`，TURN 为 implement / epoch 2。设计 R2 gate `220b6002-630e-4d22-ab37-ad91506160e5` 已通过 CLI 再核验：有效 verdict APPROVED。本阶段沿用批准计划的 sandbox 范围，分支 `project-slot-1-FLY-2753`，仓库 `xrliAnnie/flywheel-qa-sandbox`。

已逐文件通过 `git cat-file -e HEAD:<file>` 与工作树存在检查，核对 `.flywheel/config.yaml` 实际路由：engineer、qa、general 指向本次修改的三份 executor。第四份修改是 QA parallel prompt 的包内测试示例和 pre-ship helper 推荐。

生产题目中的 `.flywheel/agents/nodes/{implement,qa,engineer}.md` 与 `scripts/sync-phase-protocols.mjs` 在本授权仓均不存在。此仓没有 canonical/projection 同步机制，本次没有运行或冒称 `sync-phase-protocols --check` 通过；生产源验收仍未覆盖。设计阶段目标问题 `70231531-d5e3-4be0-ba98-0b1eb23397ad` 在实现时仍 pending；依批准计划继续当前目标。已向 Lead 报告该边界，receipt `8e68001d-57c7-4d89-bd4a-f33172408cc6`。

## 实现

三份生效角色使用相同验证文字：本机 lint、受影响包 build/typecheck、所属包和直接消费者相关测试、新增 shell 测试；完整包套件证据只接受 exact-head CI 全部所需 jobs。明确禁止用 root test、全仓递归命令或 pre-ship helper 间接跑本机全量。零匹配、缺脚本、零收集及未执行不能当作通过；CI 任一当前 head 红灯必须处理，QA 必须 FAIL 并交作者修正。

只改验证条款和对应描述。产品 E2E、隔离、身份、配置路由、报告、评审和部署条款均保留。CI YAML 和根包命令保留原状。

设计 advisories 的处置：

- `contract-test-underasserts-4th-file-and-fail`：合同检查完整 QA 红灯职责句、helper 禁用句和包内显式测试示例；临时副本复用同一检查函数，负例确实命中对应断言。
- `dependents-filter-overbroad`：直接消费者按真实包名显式选取，避免把 `...<pkg>` 错说成 direct-only；受影响包自身的 typecheck 也明确要求。
- `injected-skill-testcommand-still-full-suite`：评估了项目 `skills.test_command`。它是单一固定字符串，不能表达随改动选择的测试集合；设为空会把检查变成无操作，固定某个包或本单 shell 测试又会漏掉其他任务。按批准计划不修改生成技能、跨项目模板或项目配置；角色条款明确覆盖更宽的技能默认命令。残留默认文本风险交 Lead 决定后续配置方案。

## 定向验证证据

| 检查 | 实际结果 |
|---|---|
| 新增 shell 合同 RED | 修改角色前 exit 1：engineer 缺少 `Local targeted verification` |
| 同一合同 GREEN | 3 份角色与 helper 共 4 文件通过；7 个临时副本负例全部拒绝 |
| 负例范围 | 恢复全量门、删除零测试守卫、删除直接消费者选择、删除 QA 红灯职责、删除 helper 禁令、删除包内测试示例、删除生效角色文件 |
| `bash -n scripts/__tests__/fly2753-targeted-verification-contract.test.sh` | 通过 |
| `pnpm lint` | exit 0，检查 1897 文件；14 个原有警告 |
| 三份角色旧门 grep | 旧全量命令、PACKAGE_GATE_RECEIPT、全仓 build 和 FULL REPO 标题零命中；不将搜索错误当零命中 |
| 三份规则一致性/大小 | 规则文字相同；每份 prompt 小于 40000 bytes 注入上限 |
| `git diff --check` | 通过 |
| 设计 HTML 脚本验证 | 14 项通过；不宣称真实浏览器渲染通过 |

首次 lint 发现本 issue 设计阶段两份 review JSON 的格式错误。只用 Biome 格式化该两份记录；解析后与 HEAD 的 JSON 深比较相等，裁决内容未变。没有顺手修正其他警告。

选择边界：没有改 TypeScript、接口、导出、依赖或构建配置。唯一包内文件是 `flywheel-qa-framework` 的 Markdown prompt；package.json 的 build/typecheck 为 `tsc` / `tsc --noEmit`，不编译这份 Markdown。故本次包构建与类型检查为 N/A；不是选空包返回 0。新 shell 合同直接读取全部改动的 prompt。

在相关测试目录中按完整角色文件名搜索并人工检查了引用：ConfigLoader/AgentDispatcher 测试只使用路径字符串验证 YAML/路由，没有读取本次验证条款，且路由/路径未变，故不选；package-onboard-smoke 的 `agents/qa-executor.md` 指向另一个 shipped prompt，不是本次文件，故不选。未启动本机全量套件或 pre-ship helper。

## 后续交接

实现提交 `e40bc8810` 已推送。代码审查 gate `936dd20f-81c1-4207-833c-4b5d7b60a34d`、request `d4b07d6e-e4a9-4889-95ca-b3d0d756bed8` 已登记；截至本记录仍待裁决。进度提交也会改变审查绑定的 HEAD，因此先完成文档与独立 milestone 最后提交，再保持 HEAD 不变，取得对应有效审查后打开 PR。最终裁决与 PR 通过注入的报告/完成回执交接，不为补写回执再次改变受审提交。QA 在最终 head 核对现有 CI 的完整任务集合（Build & Test、FLY-1062 payload distribution 及其他所需 checks），记录 head、run URL 和每个 job 的结果。CI 尚无完整证据时不得宣称全量通过。本 implement 不自行请求 full CI、不派发 QA、不合并或部署。
