#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SHA = /^[a-f0-9]{40}$/;
const iso = (value) => new Date(value).toISOString();
function targetsValid(targets) {
	if (!Array.isArray(targets) || !targets.length || targets.length > 50)
		throw new Error("target_set_incomplete");
	const keys = new Set();
	for (const t of targets) {
		if (
			typeof t.repo_identity !== "string" ||
			!t.repo_identity ||
			t.repo_identity.length > 200 ||
			!/^[-\w.]+\/[-\w.]+$/.test(t.repo_slug) ||
			!Number.isSafeInteger(t.pr_number) ||
			t.pr_number < 1 ||
			!SHA.test(t.head_sha)
		)
			throw new Error("target_set_invalid");
		const key = JSON.stringify([t.repo_identity, t.pr_number]);
		if (keys.has(key)) throw new Error("target_set_ambiguous");
		keys.add(key);
	}
	return targets;
}
export function verifySnapshotPath(
	file,
	{
		home = homedir(),
		livePaths = [join(home, ".flywheel", "teamlead.db")],
		managedSnapshot,
	} = {},
) {
	const path = realpathSync(file),
		info = statSync(path);
	const liveRoot = join(realpathSync(home), ".flywheel");
	const inside = relative(liveRoot, path);
	const explicitManaged =
		managedSnapshot &&
		path === realpathSync(managedSnapshot) &&
		dirname(path) === join(liveRoot, "patrol-repairs") &&
		/^FLY-\d+__teamlead-global__[^/]+\.db$/.test(basename(path)) &&
		(info.mode & 0o222) === 0;
	if (
		(!inside || (!inside.startsWith("..") && !isAbsolute(inside))) &&
		!explicitManaged
	)
		throw new Error("live_database_refused");
	for (const live of livePaths) {
		let original;
		try {
			original = statSync(live);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		if (info.dev === original.dev && info.ino === original.ino)
			throw new Error("live_database_refused");
	}
	if (!info.isFile()) throw new Error("snapshot_not_regular");
	return path;
}
/** Restores target identity at the decision, never the current manifest pointer. */
export function resolveReplayBinding(db, outcome) {
	const at = iso(outcome.decided_at);
	const holder = db
		.prepare(
			"SELECT * FROM workflow_gate_holder WHERE question_id=? AND run_id=? AND julianday(created_at)<=julianday(?)",
		)
		.get(outcome.question_id, outcome.run_id, at);
	const run = db
		.prepare(
			"SELECT * FROM workflow_run WHERE run_id=? AND project_name='flywheel'",
		)
		.get(outcome.run_id);
	if (!holder || !run || holder.card_message_id !== outcome.card_message_id)
		throw new Error("card_binding_missing");
	const primary = db
		.prepare(
			"SELECT * FROM workflow_ship_target_binding WHERE approve_question_id=? AND run_id=?",
		)
		.get(outcome.question_id, outcome.run_id);
	if (!primary || primary.frozen_head_sha !== holder.head_sha)
		throw new Error("primary_binding_missing");
	const visible = db
		.prepare(`SELECT p.mechanical_json FROM ship_judgment_opinion p JOIN workflow_run_event e
 ON e.run_id=? AND e.kind='ship_judgment_visible' AND json_extract(e.payload,'$.opinion_id')=p.opinion_id AND json_extract(e.payload,'$.question_id')=p.question_id
 WHERE p.question_id=? AND julianday(p.created_at)<=julianday(?) AND julianday(json_extract(e.payload,'$.receipt_time'))<=julianday(?)
 AND julianday(COALESCE(json_extract(e.payload,'$.observed_at'),e.at))<=julianday(?)
 ORDER BY julianday(json_extract(e.payload,'$.receipt_time')),p.ordinal LIMIT 1`)
		.get(outcome.run_id, outcome.question_id, at, at, at);
	if (visible) {
		const binding = JSON.parse(visible.mechanical_json).binding;
		if (
			!binding ||
			binding.runId !== outcome.run_id ||
			binding.questionId !== outcome.question_id ||
			binding.cardMessageId !== outcome.card_message_id ||
			binding.projectName !== "flywheel" ||
			binding.issueId !== run.issue_id ||
			!Number.isSafeInteger(binding.manifestRevision) ||
			binding.manifestRevision < 0
		)
			throw new Error("opinion_binding_invalid");
		targetsValid(binding.targets);
		return { binding, primary, source: "visible_opinion", asOf: at };
	}
	const prs = db
		.prepare(
			"SELECT DISTINCT pr_number,probe_repo_slug FROM workflow_node_pr_binding WHERE run_id=? AND target_repo_identity=? AND head_sha=? AND julianday(bound_at)<=julianday(?)",
		)
		.all(
			outcome.run_id,
			primary.target_repo_identity,
			primary.frozen_head_sha,
			at,
		);
	if (
		prs.length !== 1 ||
		prs[0].probe_repo_slug.toLowerCase() !==
			primary.probe_repo_slug.toLowerCase()
	)
		throw new Error("primary_pr_ambiguous");
	const main = {
		repo_identity: primary.target_repo_identity,
		repo_slug: primary.probe_repo_slug.toLowerCase(),
		pr_number: prs[0].pr_number,
		head_sha: primary.frozen_head_sha,
	};
	const declared = db
		.prepare(
			`SELECT * FROM workflow_declared_pr WHERE run_id=? AND revision=(SELECT MAX(revision) FROM workflow_declared_pr WHERE run_id=? AND julianday(declared_at)<=julianday(?)) AND julianday(declared_at)<=julianday(?) ORDER BY repo_identity,pr_number`,
		)
		.all(outcome.run_id, outcome.run_id, at, at);
	const targets = declared.length
		? declared.map((row) => ({
				repo_identity: row.repo_identity,
				repo_slug: row.probe_repo_slug.toLowerCase(),
				pr_number: row.pr_number,
				head_sha: row.frozen_head_sha,
			}))
		: [main];
	targetsValid(targets);
	if (!targets.some((t) => JSON.stringify(t) === JSON.stringify(main)))
		throw new Error("primary_missing_from_manifest");
	return {
		source: "ship_binding",
		primary,
		asOf: at,
		binding: {
			projectName: "flywheel",
			runId: outcome.run_id,
			questionId: outcome.question_id,
			issueId: run.issue_id,
			cardMessageId: outcome.card_message_id,
			threadId: "offline-replay",
			manifestRevision: declared[0]?.revision ?? 0,
			targets,
		},
	};
}
/** This is explicitly hindsight evidence; it does not reconstruct the decision-time open-PR inventory. */
export function postDecisionMergeEvidence(db, resolved, target) {
	const { binding, primary } = resolved;
	if (
		target.repo_identity === primary.target_repo_identity &&
		target.repo_slug === primary.probe_repo_slug.toLowerCase() &&
		target.head_sha === primary.frozen_head_sha
	) {
		const land = db
			.prepare(
				"SELECT operation_id,merge_confirmed_at FROM land_operation WHERE run_id=? AND project_name='flywheel' AND pr_number=? AND approved_head=? AND merge_confirmed_at IS NOT NULL ORDER BY julianday(merge_confirmed_at) LIMIT 1",
			)
			.get(binding.runId, target.pr_number, target.head_sha);
		if (land)
			return {
				id: land.operation_id,
				kind: "land_operation",
				observedAt: iso(land.merge_confirmed_at),
				postDecision: true,
			};
	}
	const declared = db
		.prepare(
			"SELECT revision,merged_at FROM workflow_declared_pr WHERE run_id=? AND revision=? AND repo_identity=? AND probe_repo_slug=? AND pr_number=? AND frozen_head_sha=? AND state='merged' AND merged_at IS NOT NULL",
		)
		.get(
			binding.runId,
			binding.manifestRevision,
			target.repo_identity,
			target.repo_slug,
			target.pr_number,
			target.head_sha,
		);
	if (declared)
		return {
			id: `${binding.runId}:${declared.revision}:${target.repo_identity}:${target.pr_number}`,
			kind: "declared_pr",
			observedAt: iso(declared.merged_at),
			postDecision: true,
		};
	return undefined;
}

async function loadRuntime() {
	const modules = await Promise.all(
		[
			"evidence-authority",
			"evidence-ledger",
			"evidence-labels",
			"learning",
			"contract",
			"git-input",
			"qa-report-reference",
		].map(
			(name) =>
				import(
					new URL(
						`../packages/teamlead/dist/ship-judgment/${name}.js`,
						import.meta.url,
					)
				),
		),
	);
	return Object.assign({}, ...modules);
}
/** No authority writes or model calls. Every deterministic authority receives the original decision cutoff. */
export async function replayCards(db, options) {
	const runtime = options.runtime ?? (await loadRuntime());
	const {
		EvidenceAuthorityReader,
		ShipJudgmentLearning,
		buildEvidenceLedger,
		aggregateJudgment,
		canonicalDigest,
		decisionRelation,
		evidenceSummary,
	} = runtime;
	const cutoff = iso(options.asOf),
		from = iso(options.from ?? "0001-01-01T00:00:00.000Z"),
		to = iso(options.to ?? cutoff),
		issues = [...new Set(options.issues)];
	if (
		!issues.length ||
		issues.length > 50 ||
		issues.some((issue) => !/^FLY-\d+$/.test(issue))
	)
		throw new Error("issues_invalid");
	const slots = issues.map(() => "?").join(",");
	const outcomes = db
		.prepare(`SELECT o.* FROM ship_judgment_outcome o JOIN workflow_run r ON r.run_id=o.run_id
 WHERE r.project_name='flywheel' AND (r.issue_id IN (${slots}) OR EXISTS(SELECT 1 FROM workflow_run_issue_alias a WHERE a.run_id=r.run_id AND a.issue_alias IN (${slots})))
 AND julianday(o.decided_at)<=julianday(?) AND julianday(o.observed_at)<=julianday(?) AND julianday(o.decided_at)>=julianday(?) AND julianday(o.decided_at)<=julianday(?)
 ORDER BY julianday(o.decided_at),o.outcome_id LIMIT 10001`)
		.all(...issues, ...issues, cutoff, cutoff, from, to);
	if (outcomes.length > 10000) throw new Error("outcome_budget_exceeded");
	const authority = new EvidenceAuthorityReader(db),
		learning = new ShipJudgmentLearning(db);
	const rows = [],
		excluded = [];
	for (const outcome of outcomes) {
		const canonical = learning.canonical(outcome.outcome_id, cutoff);
		if (canonical.status !== "canonical") {
			excluded.push({
				outcomeId: outcome.outcome_id,
				reason: canonical.status,
			});
			continue;
		}
		const aliases = authority.aliases(outcome.run_id);
		const run = db
			.prepare("SELECT issue_id FROM workflow_run WHERE run_id=?")
			.get(outcome.run_id);
		const issue =
			issues.find((id) => id === run.issue_id || aliases.includes(id)) ??
			run.issue_id;
		const row = {
			issue,
			outcomeId: outcome.outcome_id,
			questionId: outcome.question_id,
			asOf: iso(outcome.decided_at),
			founderDecision: outcome.decision,
			overall: "undetermined",
			relation: "abstained",
			errors: [],
			postDecisionEvidence: [],
		};
		rows.push(row);
		let resolved;
		try {
			resolved = resolveReplayBinding(db, outcome);
		} catch (error) {
			row.errors.push(error.message);
			continue;
		}
		row.targetSource = resolved.source;
		row.targets = resolved.binding.targets;
		const materials = {
			computedAt: row.asOf,
			input: { status: "ready", reason: "evidence_complete" },
			targets: [],
			mechanical: null,
		};
		for (const target of resolved.binding.targets) {
			const material = {
				repoIdentity: target.repo_identity,
				prNumber: target.pr_number,
				headSha: target.head_sha,
				diffBaseSha: null,
				designApproval: authority.designApproval(
					resolved.binding.issueId,
					aliases,
					target.repo_identity,
					row.asOf,
				),
				codeReview: authority.codeReviewAtHead(
					resolved.binding.issueId,
					aliases,
					target.repo_identity,
					target.head_sha,
					row.asOf,
				),
				qaAuthority: authority.qaAuthority(
					outcome.run_id,
					target.repo_identity,
					target.head_sha,
					row.asOf,
				),
			};
			materials.targets.push(material);
			const report = runtime.selectQaReportReference(
				material.qaAuthority?.summary ?? "",
			);
			if (report && material.qaAuthority?.issuedAt) {
				material.qaReport = {
					id: report.token,
					observedAt: material.qaAuthority.issuedAt,
				};
			}

			let proof = postDecisionMergeEvidence(db, resolved, target);
			if (!options.repositories.has(target.repo_identity))
				row.errors.push("target_set_incomplete");
			else {
				try {
					const read = await options.readMaterial(
						target,
						material.designApproval,
						resolved,
					);
					material.diffBaseSha = read.diffBaseSha ?? null;
					if (read.diff) material.diff = read.diff;
					if (read.planBlob) material.planBlob = read.planBlob;
					if (read.provenance) material.provenance = read.provenance;
					if (read.provenance?.diffReadError)
						row.errors.push(read.provenance.diffReadError);
					if (!proof && read.mergeEvidence) proof = read.mergeEvidence;
				} catch {
					row.errors.push("git_material_unavailable");
				}
			}
			if (proof)
				row.postDecisionEvidence.push({
					repoIdentity: target.repo_identity,
					prNumber: target.pr_number,
					headSha: target.head_sha,
					...proof,
				});
		}
		const complete =
			row.postDecisionEvidence.length === resolved.binding.targets.length;
		materials.mechanical = {
			verdict: complete ? "pass" : "undetermined",
			reason: complete
				? "post_decision_merge_confirmed"
				: "post_decision_merge_unproven",
			digest: canonicalDigest(row.postDecisionEvidence),
			checkedAt:
				row.postDecisionEvidence
					.map((e) => e.observedAt)
					.sort()
					.at(-1) ?? row.asOf,
			scope: "事后合入记录对照；不还原决策时在飞文件交集",
			checkedRepos: resolved.binding.targets.length,
			openPrCount: null,
			overlaps: [],
		};
		if (row.errors.length)
			materials.input = { status: "unavailable", reason: row.errors[0] };
		try {
			row.evidence = buildEvidenceLedger(materials, resolved.binding);
			row.points = evidenceSummary(row.evidence);
			row.overall = aggregateJudgment(
				row.evidence.alignment.verdict,
				row.evidence.conflict.verdict,
				row.evidence.coverage.verdict,
			);
			if (row.errors.includes("target_set_incomplete"))
				row.overall = "undetermined";
			row.relation = decisionRelation(row.overall, outcome.decision);
			row.materialProvenance = materials.targets.map((m) => ({
				repoIdentity: m.repoIdentity,
				prNumber: m.prNumber,
				designRequest: m.designApproval?.requestId ?? null,
				codeRequest: m.codeReview?.requestId ?? null,
				qaClaim: m.qaAuthority?.claimId ?? null,
				qaReport: m.qaReport?.id ?? null,
				diffBaseSha: m.diffBaseSha,
				...(m.provenance ?? {}),
			}));
		} catch (error) {
			row.errors.push(
				error.message.includes("ledger_budget")
					? "evidence_budget_exceeded"
					: "evidence_invalid",
			);
		}
	}
	const missingIssues = issues.filter(
		(issue) => !rows.some((row) => row.issue === issue),
	);
	const assessed = rows.filter((row) => row.relation !== "abstained");
	const summary = {
		cards: rows.length,
		wouldApprove: rows.filter((row) => row.overall === "can").length,
		wrongApprovals: rows.filter(
			(row) => row.overall === "can" && row.founderDecision !== "approved",
		).length,
		abstained: rows.filter((row) => row.relation === "abstained").length,
		aligned: rows.filter((row) => row.relation === "aligned").length,
		assessed: assessed.length,
		consistency: assessed.length
			? rows.filter((row) => row.relation === "aligned").length /
				assessed.length
			: null,
	};
	return {
		schemaVersion: 1,
		asOf: cutoff,
		from,
		to,
		issues,
		scope:
			"offline deterministic replay; conflict uses explicitly post-decision merge evidence",
		authorityWrites: 0,
		modelCalls: 0,
		summary,
		missingIssues,
		rows,
		excluded,
	};
}

export function renderReplayHtml(report) {
	const htmlEscape = (value) =>
		String(value ?? "").replace(
			/[&<>"']/g,
			(c) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				})[c],
		);
	const labels = {
		can: "可自动批",
		cannot: "不可自动批",
		recommend_reject: "建议拒绝",
		undetermined: "缺证据",
	};
	const decisions = { approved: "批准", rework: "返工", canceled: "取消" };
	const relations = { aligned: "一致", divergent: "不一致", abstained: "弃权" };
	const rows = report.rows
		.map(
			(row) =>
				`<tr><th scope="row">${htmlEscape(row.issue)}</th><td>${(row.targets ?? []).map((t) => `${htmlEscape(t.repo_identity)} #${t.pr_number}<br><code>${htmlEscape(t.head_sha.slice(0, 8))}</code>`).join("<br>")}</td><td>${htmlEscape(row.points?.alignment ?? "缺目标集")}</td><td>${htmlEscape(row.points?.conflict ?? "未证")}<small>事后对照</small></td><td>${htmlEscape(row.points?.coverage ?? "缺目标集")}</td><td>${htmlEscape(labels[row.overall])}</td><td>${htmlEscape(decisions[row.founderDecision])}</td><td>${htmlEscape(relations[row.relation])}</td></tr><tr class="detail"><td colspan="8">决策 ${htmlEscape(row.asOf)} · 证据 ${htmlEscape((row.evidence?.evidence ?? []).map((e) => e.kind + ":" + e.id).join(" · "))}${row.errors.length ? " · " + htmlEscape(row.errors.join("、")) : ""}</td></tr>`,
		)
		.join("");
	const summary = report.summary;
	const unanimous =
		report.rows.length > 0 &&
		report.rows.every((row) => row.founderDecision === "approved");
	const feedback = `<section class="note" style="margin-top:24px"><h2>回放意见</h2><p>可写卡号和需要补充的证据。意见保存在当前浏览器；复制后发回，不代表批准。</p><label for="feedback">你的意见</label><textarea id="feedback" maxlength="12000" style="display:block;width:100%;min-height:100px;margin:10px 0;font:inherit"></textarea><button id="copy-feedback" type="button">复制意见</button><p id="feedback-status" role="status"></p></section><script nonce="__CSP_NONCE__">(()=>{const field=document.getElementById('feedback'),status=document.getElementById('feedback-status'),key='fly2560-feedback:'+location.pathname;try{field.value=localStorage.getItem(key)||'';}catch{}field.addEventListener('input',()=>{try{localStorage.setItem(key,field.value);status.textContent='已保存在当前浏览器';}catch{status.textContent='浏览器无法保存，请复制意见';}});document.getElementById('copy-feedback').addEventListener('click',async()=>{const value='FLY-2560 回放意见\\n'+field.value;try{await navigator.clipboard.writeText(value);status.textContent='已复制，请发回意见';}catch{field.focus();field.select();status.textContent='请复制选中的意见';}});})();</script>`;
	const sampleNote = unanimous
		? `<p>这 ${report.rows.length} 张卡的 founder 实际决定全部为批准；本样本没有拒绝案例，不能估计错批风险。</p>`
		: "";
	const c1 = report.c1Observation;
	const c1Section = c1
		? `<section class="note" style="margin-top:24px"><h2>FLY-2553：三项都有结论</h2><p><strong>① ${htmlEscape(c1.points.alignment)}　② ${htmlEscape(c1.points.conflict)}　③ ${htmlEscape(c1.points.coverage)}</strong></p><p>冻结 head ${htmlEscape(c1.target.head_sha.slice(0, 12))}；观察时间 ${htmlEscape(c1.observedAt)}。设计 / 代码评审与 QA 使用原决策时证据。历史精确头预检回执不存在；经 Lead 授权，② 新检查当时 main ${htmlEscape(c1.mainSha.slice(0, 12))} 与 ${c1.openPrSet.length} 个在飞 PR。此观察不计入上方 12 张回放。</p><p>合并检查：${htmlEscape(c1.merge.reason)}；文件交集：${htmlEscape(c1.intersection.overlaps.map((o) => `#${o.pr_number} ${o.path}`).join("；"))}。</p><details><summary>查看证据 ID</summary><p style="overflow-wrap:anywhere">${htmlEscape(c1.evidence.evidence.map((e) => `${e.kind}: ${e.id}`).join("；"))}</p></details></section>`
		: "";
	const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>自动批试判回放 · FLY-2560</title><style>
 :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17202c;background:#f4f6f9}*{box-sizing:border-box}body{margin:0;padding:36px 20px}main{max-width:1280px;margin:auto}h1{font-size:32px;letter-spacing:-.04em;margin:8px 0 14px}p{line-height:1.7;color:#526174}.eyebrow{font-size:13px;color:#526174}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:26px 0}.metric{background:white;border:1px solid #e2e7ed;border-radius:18px;padding:22px}.metric strong{display:block;font-size:34px;margin:8px 0}.note{border-left:4px solid #9bb4d8;background:#eaf0f8;padding:16px 20px;border-radius:8px}.table{overflow:auto;background:white;border:1px solid #e2e7ed;border-radius:18px;margin-top:24px}table{border-collapse:collapse;width:100%;min-width:960px;font-size:14px}th,td{padding:16px 12px;text-align:left;vertical-align:top;border-bottom:1px solid #e8edf3}thead{background:#f8fafc}small{display:block;font-size:11px;color:#67758a;margin-top:7px}.detail td{padding-top:0;color:#67758a;font-size:11px;overflow-wrap:anywhere}code{font-family:ui-monospace,monospace}footer{margin-top:24px;font-size:12px;color:#67758a;overflow-wrap:anywhere}@media(max-width:600px){body{padding:24px 14px}h1{font-size:26px}.metrics{grid-template-columns:repeat(2,1fr)}.metric{padding:16px}.metric strong{font-size:28px}}</style></head><body><main><div class="eyebrow">FLY-2560 · 决策时证据回放</div><h1>若开自动批，会批几张？</h1><p>① 设计、代码评审与 PR diff　② 合入记录对照　③ QA 判决。每项单独判断，缺什么就写什么。</p><section class="metrics"><div class="metric">会批<strong>${summary.wouldApprove}</strong>张</div><div class="metric">错批<strong>${summary.wrongApprovals}</strong>张</div><div class="metric">弃权<strong>${summary.abstained}</strong>张</div><div class="metric">一致率<strong>${summary.consistency === null ? "—" : (summary.consistency * 100).toFixed(1) + "%"}</strong>${summary.aligned}/${summary.assessed} 个非弃权结论</div></section><div class="note">①③ 只用 founder 决策时已存在的权威证据。② 使用明确标注的<strong>事后合入记录</strong>，不能证明决策当时的在飞 PR 文件交集。因此这是带事后证据的离线对照，不等同于自动批准的线上安全率。权限与 auto 开关没有改变。</div>${sampleNote}<div class="table"><table><thead><tr><th>卡</th><th>目标</th><th>① 设计 / PR</th><th>② 无冲突（事后）</th><th>③ QA</th><th>机器结论</th><th>Founder</th><th>关系</th></tr></thead><tbody>${rows}</tbody></table></div><footer>快照 SHA-256：${htmlEscape(report.snapshot?.sha256 ?? "fixture")}<br>回放截止：${htmlEscape(report.asOf)} · 排除 ${report.excluded.length} 条非 canonical 决定 · 无可纳入决定的 issue：${htmlEscape(report.missingIssues.join("、") || "无")}<br>无模型调用；无批准、合并或部署动作。</footer>${c1Section}${feedback}</main></body></html>`;
	if (Buffer.byteLength(html) > 512 * 1024)
		throw new Error("report_budget_exceeded");
	return html;
}

const exec = promisify(execFile);
async function command(bin, args, cwd) {
	const { stdout } = await exec(bin, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 1048576,
		timeout: 20000,
		killSignal: "SIGKILL",
	});
	return stdout.trim();
}
const git = (cwd, args) =>
	command("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], cwd);
function remoteSlug(remote) {
	const match =
		/^(?:https:\/\/github\.com\/|git@github\.com:)([-\w.]+\/[-\w.]+?)(?:\.git)?\/?$/.exec(
			remote,
		);
	if (!match) throw new Error("repository_remote_invalid");
	return match[1].toLowerCase();
}
export async function prepareReplayRepositories(entries, runtime = undefined) {
	const directory = await mkdtemp(join(tmpdir(), "fly-2560-replay-git-"));
	const repositories = new Map();
	try {
		for (const [identity, path] of entries) {
			if (repositories.has(identity))
				throw new Error("duplicate_repository_identity");
			const source = realpathSync(path),
				remote = await git(source, ["remote", "get-url", "origin"]),
				slug = remoteSlug(remote);
			const observedHead = await git(source, ["rev-parse", "HEAD"]);
			const gitDir = join(directory, String(repositories.size) + ".git");
			await git(source, [
				"clone",
				"--bare",
				"--shared",
				"--no-hardlinks",
				source,
				gitDir,
			]);
			const { FrozenGitReader } = runtime ?? (await loadRuntime());
			repositories.set(identity, {
				source,
				gitDir,
				repoSlug: slug,
				remote: `https://github.com/${slug}`,
				observedHead,
				reader: new FrozenGitReader(gitDir),
			});
		}
		return {
			repositories,
			dispose: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}
async function githubPr(target) {
	const raw = await command("gh", [
		"api",
		"--hostname",
		"github.com",
		`repos/${target.repo_slug}/pulls/${target.pr_number}`,
	]);
	const pr = JSON.parse(raw);
	if (
		pr.number !== target.pr_number ||
		pr.head?.sha !== target.head_sha ||
		pr.base?.repo?.full_name?.toLowerCase() !== target.repo_slug
	)
		throw new Error("github_frozen_head_mismatch");
	return {
		headSha: pr.head.sha,
		baseSha: pr.base.sha,
		mergeSha: pr.merge_commit_sha,
		mergedAt: pr.merged_at,
		observedAt: new Date().toISOString(),
		receiptSha256: createHash("sha256").update(raw).digest("hex"),
	};
}
export function createReplayMaterialReader(
	db,
	repositories,
	{ lookupPr = githubPr } = {},
) {
	const metadata = new Map();
	const read = async (target, design, resolved) => {
		const repo = repositories.get(target.repo_identity);
		if (!repo || repo.repoSlug !== target.repo_slug)
			throw new Error("repository_identity_mismatch");
		const reader = repo.reader,
			provenance = {};
		const result = { diffBaseSha: null, provenance };
		if (design?.status === "approved") {
			try {
				result.planBlob = await reader.readText(target.head_sha, design.path);
			} catch {
				provenance.planReadError = "plan_unavailable_at_head";
			}
		}
		let local, external;
		try {
			const inputs = db
				.prepare(
					"SELECT targets_json FROM ship_judgment_input WHERE question_id=? AND julianday(requested_at)<=julianday(?) ORDER BY semantic_ordinal DESC",
				)
				.all(resolved.binding.questionId, resolved.asOf);
			let diffBaseSha;
			for (const input of inputs) {
				const frozen = JSON.parse(input.targets_json).find(
					(t) =>
						t.repo_identity === target.repo_identity &&
						t.pr_number === target.pr_number &&
						t.head_sha === target.head_sha,
				);
				if (frozen && SHA.test(frozen.diff_base_sha)) {
					diffBaseSha = frozen.diff_base_sha;
					provenance.diffBaseSource = "frozen_input";
					break;
				}
			}
			local = postDecisionMergeEvidence(db, resolved, target);
			let mergeSha;
			if (local?.kind === "land_operation") {
				const step = db
					.prepare(
						"SELECT receipt_json FROM land_operation_step WHERE operation_id=? AND step='merge_confirmed'",
					)
					.get(local.id);
				if (step) {
					const receipt = JSON.parse(step.receipt_json);
					if (
						SHA.test(receipt.mergeSha) &&
						(!receipt.headSha || receipt.headSha === target.head_sha)
					)
						mergeSha = receipt.mergeSha;
				}
			}
			if (!local || (!diffBaseSha && !mergeSha)) {
				const key = JSON.stringify([
					target.repo_identity,
					target.pr_number,
					target.head_sha,
				]);
				if (!metadata.has(key))
					metadata.set(
						key,
						lookupPr(target).catch(() => undefined),
					);
				external = await metadata.get(key);
				if (external?.headSha !== target.head_sha) external = undefined;
				if (external?.mergedAt && SHA.test(external.mergeSha))
					mergeSha = external.mergeSha;
			}
			if (!diffBaseSha && mergeSha) {
				const parent = (
					await git(repo.source, [
						`--git-dir=${repo.gitDir}`,
						"show",
						"--no-patch",
						"--format=%P",
						mergeSha,
					])
				).split(" ")[0];
				if (!SHA.test(parent)) throw new Error("merge_parent_missing");
				diffBaseSha = await reader.mergeBase(parent, target.head_sha);
				provenance.diffBaseSource = "merge_receipt_first_parent_merge_base";
				provenance.mergeCommit = mergeSha;
				provenance.baseAnchorPostDecision = true;
			} else if (
				!diffBaseSha &&
				external &&
				!external.mergedAt &&
				SHA.test(external.baseSha)
			) {
				diffBaseSha = await reader.mergeBase(external.baseSha, target.head_sha);
				provenance.diffBaseSource = "github_target_base_merge_base";
				provenance.baseObservedAt = external.observedAt;
			}
			result.diffBaseSha = diffBaseSha ?? null;
			if (diffBaseSha)
				result.diff = await reader.diff(diffBaseSha, target.head_sha);
		} catch (error) {
			provenance.diffReadError =
				(error.code ?? error.cause?.code) ===
				"ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
					? "diff_budget_exceeded"
					: error.message === "merge_parent_missing"
						? "merge_parent_missing"
						: "git_diff_unavailable";
		}
		if (!result.diff && !provenance.diffReadError)
			provenance.diffReadError = "diff_base_unavailable";
		if (external) provenance.githubReceipt = { ...external };
		if (!local && external?.mergedAt)
			result.mergeEvidence = {
				id: external.receiptSha256,
				kind: "github_merged",
				observedAt: iso(external.mergedAt),
				postDecision: true,
			};
		return result;
	};
	return read;
}
async function sha256File(file) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}
export async function runCardReplay(args) {
	const values = {},
		entries = [];
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index],
			value = args[index + 1];
		if (
			![
				"--db",
				"--managed-snapshot",
				"--repo",
				"--issues",
				"--out",
				"--from",
				"--to",
			].includes(key) ||
			!value
		)
			throw new Error(
				"usage: --db snapshot.db --repo identity=checkout --issues FLY-2544,FLY-2549 --out new-directory",
			);
		if (key === "--repo") {
			const split = value.indexOf("=");
			if (split <= 0) throw new Error("repository_mapping_invalid");
			entries.push([value.slice(0, split), value.slice(split + 1)]);
		} else {
			if (values[key]) throw new Error("duplicate_argument");
			values[key] = value;
		}
	}
	if (
		(!values["--db"] && !values["--managed-snapshot"]) ||
		(values["--db"] && values["--managed-snapshot"]) ||
		!values["--issues"] ||
		!values["--out"] ||
		!entries.length
	)
		throw new Error("replay_arguments_missing");
	const livePaths = [
		join(homedir(), ".flywheel", "teamlead.db"),
		process.env.FLYWHEEL_STATE_DB_PATH,
		process.env.TEAMLEAD_DB_PATH,
		process.env.FLYWHEEL_TEAMLEAD_DB,
	].filter(Boolean);
	const path = verifySnapshotPath(
		values["--db"] ?? values["--managed-snapshot"],
		{ livePaths, managedSnapshot: values["--managed-snapshot"] },
	);
	const before = statSync(path),
		digest = await sha256File(path);
	const db = openReplaySnapshot(path);
	let prepared;
	try {
		const runtime = await loadRuntime();
		prepared = await prepareReplayRepositories(entries, runtime);
		const report = await replayCards(db, {
			issues: values["--issues"]
				.split(",")
				.map((id) => (/^\d+$/.test(id) ? `FLY-${id}` : id)),
			asOf: new Date().toISOString(),
			from: values["--from"],
			to: values["--to"],
			repositories: prepared.repositories,
			runtime,
			readMaterial: createReplayMaterialReader(db, prepared.repositories),
		});
		const after = statSync(path);
		if (
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			(await sha256File(path)) !== digest
		)
			throw new Error("snapshot_changed_during_replay");
		report.snapshot = {
			sha256: digest,
			size: before.size,
			observedAt: before.mtime.toISOString(),
		};
		report.repositories = [...prepared.repositories].map(
			([identity, repo]) => ({
				identity,
				remote: repo.remote,
				observedHead: repo.observedHead,
			}),
		);
		const output = resolve(values["--out"]);
		await mkdir(output, { recursive: true });
		await writeFile(
			join(output, "replay.json"),
			JSON.stringify(report, null, 2) + "\n",
			{ flag: "wx" },
		);
		await writeFile(join(output, "replay.html"), renderReplayHtml(report), {
			flag: "wx",
		});
		return report;
	} finally {
		db.close();
		await prepared?.dispose();
	}
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	runCardReplay(process.argv.slice(2))
		.then((report) => {
			process.stdout.write(
				JSON.stringify({
					ok: true,
					summary: report.summary,
					missingIssues: report.missingIssues,
					snapshot: report.snapshot,
				}) + "\n",
			);
		})
		.catch((error) => {
			process.stderr.write(
				JSON.stringify({
					ok: false,
					reason: String(error.message).slice(0, 512),
				}) + "\n",
			);
			process.exitCode = 1;
		});
}

/** Python SQLite supports immutable URI opens. No WAL/SHM creation, writes, or StateStore migrations. */
export function openReplaySnapshot(path) {
	if (!statSync(path).isFile()) throw new Error("snapshot_not_regular");
	if (existsSync(path + "-wal") && statSync(path + "-wal").size > 0)
		throw new Error("snapshot_has_uncheckpointed_wal");
	let closed = false,
		cacheBytes = 0;
	const cache = new Map();
	const python = `import sys,json,sqlite3,pathlib
path,sql,params,mode=sys.argv[1:]
connection=sqlite3.connect(pathlib.Path(path).resolve().as_uri()+"?mode=ro&immutable=1",uri=True)
connection.row_factory=sqlite3.Row
try:
 connection.execute("PRAGMA query_only=ON")
 cursor=connection.execute(sql,json.loads(params))
 rows=cursor.fetchall() if mode=="all" else ([row] if (row:=cursor.fetchone()) is not None else [])
 print(json.dumps([dict(row) for row in rows],ensure_ascii=False))
finally:
 connection.close()
`;
	const query = (sql, args, mode) => {
		if (closed) throw new Error("snapshot_closed");
		if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error("snapshot_readonly");
		const params =
			args.length === 1 && args[0] && typeof args[0] === "object"
				? args[0]
				: args;
		const encoded = JSON.stringify(params),
			key = JSON.stringify([sql, encoded, mode]);
		let raw = cache.get(key);
		if (raw === undefined) {
			raw = execFileSync("python3", ["-c", python, path, sql, encoded, mode], {
				encoding: "utf8",
				timeout: 20000,
				maxBuffer: 4194304,
			});
			const bytes = Buffer.byteLength(raw);
			if (cacheBytes + bytes <= 16777216) {
				cache.set(key, raw);
				cacheBytes += bytes;
			}
		}
		const result = JSON.parse(raw);
		return mode === "all" ? result : result[0];
	};
	return {
		prepare: (sql) => ({
			all: (...args) => query(sql, args, "all"),
			get: (...args) => query(sql, args, "get"),
		}),
		transaction:
			(callback) =>
			(...args) =>
				callback(...args),
		close: () => {
			closed = true;
			cache.clear();
		},
	};
}
