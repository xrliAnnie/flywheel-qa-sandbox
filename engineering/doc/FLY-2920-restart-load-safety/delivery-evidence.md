# FLY-2920 交付检查 — 调研
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920/病根修复-4-重启和负载不再把系统自己打垮删卡顿自杀与-250ms-起体判败审查作业与孤儿身份只认领退休一次内存手刹不锁存6-张-59)
日期: 2026-09-26
基于: plan.md

## 本地交付检查

- 文档基线提交 `b91d646eb` 已推送 origin/flywheel-FLY-2920。
- 评审 gate `dbb3852e-bf19-42c4-9789-c88d83414d07`；request `55832709-c4d7-4916-ab7e-7e88c16d96f6`，accepted=true、skipped=false。有效裁决仍待回收，不视为通过。
- `review-flow.mmd` 与 `data-model.mmd` 各本地 mmdc 2 次，均失败。标准命令为 `mmdc -i <name>.mmd -o <name>.svg -w 1000 -b white --svgId FLY-2920-d<N>`。
- 原因：Chromium `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`，发生在浏览器启动、不是 Mermaid 内容渲染完成。未使用远程绘图服务。HTML 显示 `DIAGRAM PENDING LOCAL RENDER` 并保留转义后的源文本；不声称有 SVG。
- Node VM 控制器模拟检查通过：7 个 section 各有意见框；一个 nonce 占位 script；无 inline event handler、外部依赖或自写 CSP；localStorage 按 pathname 隔离并捕获异常；恢复保存值；字面恶意标签仅当文本；每个长文本 chunk≤1800 JS 字符、各首行精确为 `【页面意见汇总】FLY-2920`；emoji 不拆 surrogate；clipboard 成功、缺席 fallback、promise reject fallback 均通过。
- 初次 harness 等待跨 VM Promise 的 microtask 不充分造成假失败；改为等待一轮 setImmediate 后通过。未因此修改页面逻辑。
- diagram-design self_check 未通过：无 accessible SVG（上面的真实渲染失败）；该通用工具还要求 motion script/data-motion-root。任务强制意见脚本与 nonce，且此页静态，所以不为通过该工具添加无意义 motion 控制或伪造 SVG。
- 未做浏览器截图、真实布局或实际 CSP 下执行验收；只能将上述称为源码/控制器检查。未运行产品代码测试，未启动测试房、重启或部署服务。

## 续接证据（2026-09-26）

- 当前执行 `53313403-f4ae-43b1-83be-140eb624a1ea`，TURN epoch=5，run=`44d7b165-f570-4b98-9bb4-6e820193bef7`。保留历史执行身份，不复用旧凭据。
- 旧 gate 实际回收为 R1 `CHANGES_REQUESTED`；其 findings 已由 `7f4fac134` 的 plan 修订记录逐项处置。上节“待回收”仅描述原体当时状态。
- 新 gate `0479dcf9-4c98-4ef9-8bbb-8f2e9f36265f`、request `8d9a9612-1c5f-4e10-ba56-6d2c14ba3930`：accepted=true、skipped=false、duplicate=false。
- 重新送审的 plan blob=`47caa6a7dd0a86ddce13bec586e4a6a5af193716`，与保留头 `7f4fac134` 完全相同。仅同步 research 的 R1 校正说明、探索续接身份和 founder 页面；提交 `14b9eac06` 已推到 origin。
- founder 页面更正旧“未知即暂停”措辞：未知跳过这一压力检查，独立 load/free-bytes 护栏保留；补停等作者的退休/ready 唤醒、原预算到期处理及通知与派发分离。
- 重新运行原 `/tmp/fly2920-report-check.cjs` 对当前生成页的源码/Node VM 检查：7 节意见、按路径隔离、保存恢复、存储异常、字面恶意标签、1800 字符分段与三个 clipboard 分支全部通过。`git diff --check` 通过。未运行产品代码测试。
- 无新增可复用的角色判断需要写入记忆；本次延续既有的精确身份、有效裁决和托管校验要求。

## R2 与 R3 续接

- R2 有效 `reviewVerdict=CHANGES_REQUESTED`，完整结构化结果保存于 `review-r2.json`。阻断项为 `pressure-unknown-fail-open-at-restart`，不能将未知读数默认当作恢复。
- 提交 `c5d14937f` 修订 F1/F2：2P有界新鲜证据、单次失败保留可用baseline、启动有界等待、首次可算delta危险时保守交接、有效non-danger立即解除、过期未知明确降级不锁存。更正默认free-bytes关闭。其他R2建议逐项在plan末节处置，六单范围保持。
- R3 gate=`c9e0efe1-bfff-4c84-bce6-6e95b8eac574`，request=`7f8e4b43-079e-406e-954e-26857ce374ad`，accepted=true、skipped=false、duplicate=false；送审plan blob=`72f8b4bb002058a2f60e37c37c00ae2e1c14398d`。此处登记请求不表示评审通过。
- Lead 回复 `ab0ab586-3dac-41c9-ae12-1a5f5c75c45a` 明确保留 Mermaid 占位，交卷注明 pending，由 Lead 在沙箱外补画后发给 founder。已报告执行此指示（report `83f0da2a-ca76-4388-ac9b-21cf192a3145`）。
- Chrome DevTools `list_pages` 两次各300s超时；未据超时重启浏览器，也不声称真实布局/浏览器CSP执行通过。当前HTML再次通过7节意见控制器检查。托管HTTP、CSP与字节检查仍待有效APPROVED后发布时执行。

## R3 与 R4 续接

- R3 有效 `CHANGES_REQUESTED`，完整结果见 `review-r3.json`。唯一HIGH为 `pressure-freshness-window-vs-real-sensor-cadence`：实际swap采样挂在约10分钟的Lead reconcile，不是陈旧注释所写的30秒。
- 提交 `32f5ab744` 定义独立轻量30秒采样器、5秒读取上限、早于准入开放的组合根接线、90秒新鲜度和60秒warm-up；移出重型巡检的仅是swap采样。新增真实30秒timer的组合根验收，重型巡检挂起65秒仍须采到样本。founder页同步启动等待与未知降级边界。
- R4 gate=`cdb373cb-c3e9-41cc-b9fb-fd829094d0a5`、request=`f3c26ccf-9397-4a65-8fc3-a604f159f3ac`，accepted=true、skipped=false、duplicate=false；送审plan blob=`da53ca9012d3c9894d14df4f70e15ead060d55c6`。
- 本轮新增的一条可复用判断“传感器unknown不是恢复；删除锁存须明确证据有效期”已写成允许路径下的memory更新建议 `memories/extensions/ad_hoc/notes/2026-09-26T172700Z-bounded-pressure-evidence.md`。未直接修改共享角色索引；其只读预算检查为102行/19931字节。

## 待完成

有效评审 → 最终页状态刷新 → commit/push → publish-only → 托管 HTTP/CSP/source 校验 → Lead URL report → exact complete/park。
