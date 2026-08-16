# FLY-1782 · Annie 四个反问的取证

**更新于**: 2026-08-15 · **格式**: 结论 + 证据位置(文件:行)· 查不到写查不到

---

## ② 五道门的实际生效值(全部「没人设过 = 跑默认」)

| 门 | 实际值 |
|---|---|
| `codex_hard_gate_killswitch` | **开** |
| `merge_approval_gate_killswitch` | **开** |
| `qa_done_gate_killswitch` | **开** |
| `ship_ci_guard` | **开** |
| `design_html_gate` | **开** |

证据:`snapshot.json` 的 `configured`(五条 `set:false` ⇒ 跑 registry 默认)。

---

## ③ QA 门:**部分成立**

**她成立的部分**:
1. **DAG 确实能直接加 QA 节点,而且已经这么做了。** 生产库五个在用模板:
   - `tpl_code` = design → implement → **qa** → gate → land
   - `tpl_prd` / `tpl_design` / `tpl_prototype` / `tpl_generic_menu` = generic → gate → land(**没有 qa 节点**)
   证据:`~/.flywheel/teamlead.db` 的 `workflow_template` ⋈ `workflow_template_revision`(当前发布修订的 manifest.nodes)。
   ⇒ **「不是每种节点都需要 QA」在生产里已经是事实,不是设想。**
2. **门本身已经是逐节点读 DAG 的,不是一刀切。** `evaluateQaShipGate` 里有分支:
   `session_role==="qa" && chat_thread_role==="qa"` ⇒ 走 `resolveEnrolledQaClaim`,
   读的是 **DAG 自己的** `workflow_execution_binding` / `workflow_run_node`。
   证据:`packages/flywheel-comm/src/ship-eligibility.ts:296-309`(分支)· `:150-195`(claims 读法)。

**她不成立的部分**:
- 门**不等于**「要求每个 run 都有 QA 记录」,它是**执行 DAG 那个节点的裁决的地方** ——
  节点产出 claim,**门是「ship 时必须校验这个 claim」的那一步**。删掉门,带 qa 节点的 DAG 仍可能在节点没过时 ship。
  证据:同文件 `:267` `evaluateQaShipGate` 是 ship 资格的判定入口。
- 非 DAG(legacy)run 只有这条路:回落到 `auto_qa_record` + `qa_required` 快照。
  证据:`ship-eligibility.ts:311-320`。

⇒ **一句话:她说的「用节点代替全局门」在结构上已经实现了一半 —— 节点是真的、门也确实读节点;但门是"校验"那一步,不是"要求"那一步,拿掉它等于取消校验。**

---

## ④ CI 门:**查到的是「不重复,各管一段」**

`probeShipCiGreen` 有**两个**调用点,不是一个:
- `packages/flywheel-comm/src/commands/gate.ts:92` —— **开门(approve)时**
- `packages/flywheel-comm/src/commands/verify-approval.ts:729` —— **验批准时**

⇒ 它管的是 **approve / verify 这两步**,而 `:cool` 管的是 **merge 那一步**。
⚠️ **「:cool 本身查不查 CI」我没查完**(它在 `bridge/land-retry-policy.ts` / `gate-poller.ts` 一侧)——
**这一半查不到就是查不到,不补白。** 要判「是否重复」需要先看完 :cool 那侧,我在 85% 停手了。

---

## ⑤ design_html_gate 的 =0 应急口有没有被用过:**查不到被用过的记录**

- 生产 `~/.flywheel/.env` 里 `FLYWHEEL_DESIGN_HTML_GATE` **0 命中**(从没设过)
- `~/.flywheel/audit.db` 的 `fleet_admin_audit` 里相关翻转记录 **0 条**

⚠️ **限度**:这两处只能证明「**没有经 .env 和 fleet 控制台留下痕迹**」。
它也可以被单次命令的进程级 env 使用而不留痕 —— **那种用法我查不到**。
⇒ 正确说法:**在可查的两个面上没有被用过的记录**,不是「一次都没用过」。
(与 `comm_bypass_bridge` 那条同款口径。)

---

## ⑦ doc_flow

**六项目分布(3 开 3 关)**:
- **开**:`joycon-typeless` · `flywheel` · `tidal-echo`(三条都是**显式**开)
- **关**:`geoforge3d` · `personal-assistant` · `growth`(默认)

证据:`snapshot.json` 的 `doc_flow.configured.byProject`。

**开了之后 runner 实际会写什么 / 三档区别**:⚠️ **没查完**,我在 85% 停手了。
已知的一半:注入点在 `packages/edge-worker/src/Blueprint.ts:2062`(`this.docFlowConfig?.enabled === true` 才注入),
档位来自 `ctx.docTier ?? "full"`(`Blueprint.ts:2073`)。
**具体文件名 / 内容 / full 与 plan_only 与 none 的差别,要读 DOC-FLOW 注入的那段模板文本才能给准 —— 没读,不猜。**
