# FLY-2467 全包门可靠性 — 审查记录
Issue: FLY-2467 (https://linear.app/geoforge3d/issue/FLY-2467)
日期: 2026-09-14
基于: plan.md

## Lead 批准的设计增量
Comm question 0cdf2750-3b8f-401e-8d2f-1aee1ab745ec 的裁定批准：保留四片，耗时高的文件独立串行、其余最多两个fork，完整发现集合每文件恰好一次且隔离不变；通过既有 pnpm patchedDependencies 对钉定 Vitest 3.2.4 仅延长 worker RPC 60s→120s，保留错误、禁止修改断言超时/跳过。需可执行超时负对照及补丁存在性守卫；升级丢补丁必须明确失败。pinned plan.md 不变。
验收进一步明确：新头连续三轮四片全绿、每片<400s、零onTaskUpdate。最终代码与里程碑同推后注册新review。

## 旧头审查及修复
Gate 79db8f01-a217-4fbd-b162-634a2224528f：CHANGES_REQUESTED，reviewedHeadSha=6c13c452591f49b96de3a8b17580ab63ffa74644（相对93205dec7仅progress变化）。HIGH findingKey=ci-teamlead-two-forks-on-two-cpu-runner：两核CI全量2fork导致真实inventory超时和RPC错误，证据是run34809960905。
本次移除全量2fork，CI入口顺序执行serial项目（1fork）及parallel项目（2fork）。>=2500ms历史成本文件包括inventory；不同CLI进程确保Vitest3全局pool配置不覆盖串行上限，每文件仍是默认isolated fork。另加批准的worker RPC补丁。当前本地24项聚焦、inventory2项、lint/build、CI结构/枚举通过；稳定性修复是否足够，仍由新头review及三轮精确CI裁定，旧头红不豁免。
非阻断advisories保留并报告Lead：临时收据保留期；exit0无收据防御；首次RPC重试后恢复的摘要可见性；runtime skip fail-closed。均不扩入本次已锁定范围。

## 第四轮阻断修复
Gate 3e2aa116-0930-42e3-8582-f43acdd196da 对 3cb6a0a6 为 CHANGES_REQUESTED：projects-label-breaks-fly2453-mutation-gate。Vitest项目标签使变异门原有FAIL字面匹配失败；提取判定函数并仅规范化serial/parallel标签，保留writer与unit双失败要求。新增回归先红后绿，包括无标签、CI标签、TTY标签、ANSI及缺失失败负对照。真实变异门结果继续记录PR正文。
同头CI的ci-matrix-coverage守卫无法识别新分片helper，已将精确helper命令映射至它执行的teamlead包，再由pnpm解析：修前exit1，修后23/23包覆盖、无重叠。其余新审查建议为非阻断项，不扩大本轮范围。新头仍需新审查及三轮精确CI，原头失败不得计入验收。
