# FLY-2998 干净房间执行流程 — 调研
Issue: FLY-2998 (https://linear.app/geoforge3d/issue/FLY-2998/qa-sbx-fly-2925-clean-room-synthetic-runner-lifecycle-task-2)
日期: 2026-09-28
基于: plan.md

## 设计产物核验
- pnpm lint：退出 0，检查 5214 文件，25 个现有警告；没有自动修改文件。
- git diff --check：通过。目标正文 qa-sandbox/fly2925-clean.md 不存在，设计未实施。
- HTML 静态检查：六张卡片均有评论框；单一 nonce 占位脚本；无外链资源、内联事件属性、innerHTML 或自设 CSP。
- Node vm 中执行实际内联脚本，使用隔离 DOM/存储替身：评论保存键包含页面路径，汇总保留标题及原始文本，4200 字长意见分成三片且每片 <=1800 字符并带正确首行；剪贴板成功、缺失、拒绝三条路径均通过；存储抛错仍可汇总复制。此证据不冒充真实浏览器运行。
- 两张 Mermaid 图分别本地 mmdc 渲染失败，随后各按 -w 1000 -b white --svgId FLY-2998-d1/d2 重试一次仍失败。错误为 Chromium MachPortRendezvousServer bootstrap_check_in Permission denied (1100)。按合同显示 DIAGRAM PENDING LOCAL RENDER，保留本地源码，无远程渲染。视觉核验未完成。
- request-review 代码审计：review-request-coordinator.ts 在 build prompt 首字节拼接完整 local-test-policy.md；内容与注入标记块一致。评审请求消息也显式带该完整前缀；不委派任何全包测试。

## 范围
仅本目录新增设计产物；没有更改产品源码、服务配置或合成正文。真实生命周期恢复及三段正文历史由后续授权阶段验收，不在此声称通过。

## 发布与评审回执
- 设计产物提交 9d95e3a47，已成功普通推送至 origin/project-slot-2-FLY-2998。
- review_design question：3dc93f15-78e7-4e16-8f74-4a70cef961d2；request-review accepted=true，requestId 0df18e62-dc79-49a7-abd0-b6b1aa159b2b；本次检查仍 pending，未宣称批准。
- publish-report --publish-only 成功返回测试房间地址 http://127.0.0.1:53874/fw-reports-7c9d8a/r/72cf801d5ac5b98e41e9eb08f0867f17/ 。这是 loopback 地址，不宣称公网可访问。GET 得到 HTTP 200，nonce 占位已替换，脚本 nonce 与 CSP 匹配，评论标记存在。
- DESIGN-HTML ready 已通过 ask --report 发送给 flywheel-test-2，回执 6564c28a-498a-4029-80c4-be7196be333b，包含托管地址、图形失败及浏览器未核验限制；未发频道消息。
- 下一步：下一回合先 turn / inbox，再 check 上述 review question；仅有效 APPROVED 后执行 phase_design_complete 与 park。

## 有效评审与最终交接审计
- reviewVerdict=APPROVED，reviewerVerdict=APPROVED；requestId 0df18e62-dc79-49a7-abd0-b6b1aa159b2b；问题 3dc93f15-78e7-4e16-8f74-4a70cef961d2。服务记录 status=done，完成并送达于 2026-09-28 09:04:34 UTC。
- 计划保持已评审字节不变，当前 Git blob：3cb8117b81d14115a4fc0ba3f86971ed3afe6764。
- 四项非阻断建议已通过 ask --report 转交 Lead 选择后续工作；下面保留原始建议，不将其冒充阻断或额外授权。

### implement-noncontent-writes-unscoped — MEDIUM
The plan does not list the other files the implement node is required to commit

The plan says the implement node only creates qa-sandbox/fly2925-clean.md. Its acceptance check (line 58) also compares everything from the implement start HEAD to the current HEAD and expects no other 'business file' changes. But the implement node has its own required writes. .flywheel/agents/nodes/implement.md:39 requires the PR to end with engineering/doc/milestones/FLY-2998.md as its literal last commit. `flywheel-comm progress` (packages/flywheel-comm/src/commands/progress.ts:206, `git commit --only -- progress.md`) commits engineering/doc/FLY-2998-clean-runner-lifecycle/progress.md after each batch of work. The term 'business file' is vague. An implementer following the plan literally could leave out the milestone commit and break the node contract, or include it and fail the plan's own range check. Suggested fix: list these required commits (progress ledger, milestone as last commit, plus any review evidence the injected flow demands) by exact path. State that, under the Lead's ruling on question 546b3cf4 (verified in the transcript), the 'change only this file' rule applies only to the three content commits. Change the range check to an allow-list of those paths instead of 'no other business files'.

### resume-unpushed-commit — MEDIUM
On restart, the plan never checks whether finished steps were actually pushed

The restart guard only reads local history (`git log --reverse -- qa-sandbox/fly2925-clean.md`) and then says to do only the unfinished work. Suppose the runner restarts after commit N but before push N. Local history marks step N as done, so step N+1's push sends both commits at once. That loses the separate push for each step, which the issue requires and which acceptance line 59 checks. research.md does mention checking the remote branch, but the plan's checklist leaves it out. Suggested fix: add a restart step that runs `git fetch origin`, then checks each content commit with `git merge-base --is-ancestor <sha> origin/project-slot-2-FLY-2998`, and pushes any unpushed finished step on its own (then re-verifies with ls-remote) before starting the next paragraph.

### push-evidence-durability — MEDIUM
The plan does not say where each push record is kept

Steps 1–3 say to record the successful push output, and acceptance requires checking three successful push records. That output only lives in the terminal, so it is lost on restart. The plan also forbids writing any other file, so there is nowhere in the repo to save it. As written, QA cannot confirm the step-by-step pushes. The repo already keeps a lasting record: `git reflog show refs/remotes/origin/project-slot-2-FLY-2998` shows one 'update by push' entry with a SHA for each push (confirmed on this branch: 9d95e3a47 and then d613dc1c5). Suggested fix: name that reflog, or the GitHub branch activity API, as the push evidence. Optionally also put the step SHA in the progress ledger's --next text.

### verification-doc-type-label — LOW
verification.md heading calls it a research doc

The title line reads '— 调研' (research), copied from research.md. It should name the document as a verification or evidence record. Cosmetic only.

交接检查：探索、调研、计划、进度和 HTML 均在授权目录；HTML 已先提交推送，再发布并报告。两图各失败两次后按合同保留占位及源码；评论脚本的替身验证与托管 nonce 检查通过，真实浏览器视觉未核验的限制已报告。设计未创建正文、未实施、未派发后继、未请求 ship、未合并。阶段完成命令尚待本提交推送后执行，不把本记录当完成回执。
