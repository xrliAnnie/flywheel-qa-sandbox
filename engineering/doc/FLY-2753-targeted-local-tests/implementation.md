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

## 重新派发的实现复核（2026-09-20）

执行 `72841877-9325-48d7-b508-3ceb1ed9b635`，run `7ceaee87-c0cd-4340-8a7d-00d5e5f76701`，implement TURN epoch 2。起点 `d300efb9c`，已有 PR #206；本轮通过 CLI 再核验设计 gate `ef0bcbf7-4147-4dd8-af81-72bacb824a27`，有效 `reviewVerdict=APPROVED`。批准计划要求保留既有实现，不重复制造 RED，也不继承旧头代码评审/CI。审计确认四份 prompt 已符合 §1，故本轮只更新证据与交接文档，没有新增行为变更。

实际入口五文件均通过版本化和非空存在性检查，config 路由一致。三份本机验证条款逐字相同，大小分别为 6282、5263、3327 bytes，均在注入预算内；旧全量门、PACKAGE_GATE_RECEIPT、递归 build 和 FULL REPO 标题零命中。四份 prompt 的 diff 仅涉及验证文字/描述与 helper 示例，没有变更审批、身份、E2E、路由或部署。

本轮新鲜证据：shell 合同实际验证四文件并拒绝七个负例；`bash -n` 通过；HTML 静态/实际 inline JS 的 Node VM 验证 14 项通过（不证明真实浏览器渲染）；`pnpm lint` exit 0，1899 文件、14 个既有警告；`git diff --check origin/main...HEAD` 通过。所有新增 shell 测试清单只有该合同。按完整路径、文件名、父目录执行 57 次 `git grep -lF` 消费者搜索；107 个命中的逐文件保留/排除理由见 test-selection.md。无 TypeScript 或编译资产变化，build/typecheck/related 为 N/A。

指定 sentinel 已从仓库根目录实际执行一次：`pnpm exec node -e "console.log('FLY2753-SENTINEL-1789952384')"`，exit 0，原样输出：

```text
FLY2753-SENTINEL-1789952384
```

生产 nodes 三文件与同步器再次核实不存在；没有运行缺失的同步器并把失败算通过。目标问题 `7889b4bc-48fa-48ae-99eb-e10bae2e7981` 仍 pending；已向本轮 Lead 报告，receipt `24fef0f1-5e8d-4988-8a78-f2d0c3cb36fe`。原题生产验收仍必须在对应授权目标完成，本阶段不能关闭 issue。

设计 R2 的五个非阻塞 advisories 沿用获批计划的披露处置：合同尚未接 CI、注入技能默认仍有 root test、缺脚本指引仍需人工核实、生产 TAP 守卫对嵌套测试会误红、失败 TAP 诊断可能被清理。未为处理建议扩大修改范围。最终本轮代码评审、CI 状态与完成回执以 PR 和 Lead 报告为准。先更新进度、以 milestone 为最后提交，再 push 和申请新头评审；不得将旧 PR 正文中的 `6b987d1b1` APPROVED 当成本轮审批。
