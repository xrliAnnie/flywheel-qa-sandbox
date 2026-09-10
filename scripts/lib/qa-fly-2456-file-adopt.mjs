import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateCyclePreState } from "./qa-fly-2456-manifest.mjs";
import { foldTmuxWindows } from "./qa-fly-2456-tmux-inventory.mjs";

const require = createRequire(
	new URL("../../packages/teamlead/package.json", import.meta.url),
);
const { parse } = require("yaml");
const conflict = (reason) => ({ action: "conflict", reason });
const adopted = (result) => ({ action: "adopt-existing", result });
function processes(value) {
	if (
		!Array.isArray(value) ||
		value.some(
			(p) =>
				!Number.isSafeInteger(p.pid) ||
				p.pid <= 0 ||
				!Number.isSafeInteger(p.ppid) ||
				p.ppid < 0 ||
				!Number.isFinite(Date.parse(p.lstart)),
		) ||
		new Set(value.map((p) => p.pid)).size !== value.length
	)
		throw new Error("process evidence invalid");
	return value;
}
function inspect(e, intent, config, observed) {
	const { detail } = intent;
	if (detail.kind === "park-publish") {
		if (
			detail.repository !== "xrliAnnie/flywheel-qa-sandbox" ||
			e.repository !== detail.repository ||
			typeof detail.branch !== "string" ||
			!/^[-\w/]+$/.test(detail.branch) ||
			detail.branch.includes("..") ||
			!/^[a-f0-9]{40}$/.test(detail.expectedHead) ||
			typeof e.remoteRefs !== "string"
		)
			return conflict("publish_identity_invalid");
		if (e.remoteRefs === "") return { action: "execute" };
		if (
			e.remoteRefs !== `${detail.expectedHead}\trefs/heads/${detail.branch}\n`
		)
			return conflict("publish_ref_conflict");
		return adopted({
			repository: detail.repository,
			branch: detail.branch,
			head: detail.expectedHead,
		});
	}

	if (["park-marker", "park-pr"].includes(detail.kind)) {
		if (
			!/^[\w.-]+\/[\w.-]+$/.test(detail.repository) ||
			e.repository !== detail.repository ||
			!/^[-\w/]+$/.test(detail.branch) ||
			detail.branch.includes("..")
		)
			throw new Error("park repository or branch invalid");
		if (detail.kind === "park-pr") {
			if (
				!isDeepStrictEqual(e.query, {
					repository: detail.repository,
					head: detail.branch,
					state: "open",
				})
			)
				throw new Error("PR query scope mismatch");
			if (
				typeof detail.title !== "string" ||
				!detail.title ||
				!Array.isArray(e.prs)
			)
				throw new Error("PR evidence invalid");
			if (e.prs.length === 0) return { action: "execute" };
			const p = e.prs[0];
			if (
				e.prs.length !== 1 ||
				p.state !== "OPEN" ||
				p.headRefName !== detail.branch ||
				p.title !== detail.title ||
				!Number.isSafeInteger(p.number) ||
				p.number <= 0 ||
				p.url !== `https://github.com/${detail.repository}/pull/${p.number}`
			)
				return conflict("PR identity conflict");
			return adopted({
				repository: detail.repository,
				branch: detail.branch,
				number: p.number,
				url: p.url,
			});
		}
		if (
			typeof detail.markerPath !== "string" ||
			isAbsolute(detail.markerPath) ||
			normalize(detail.markerPath) !== detail.markerPath ||
			detail.markerPath.startsWith("..") ||
			typeof detail.markerText !== "string" ||
			!detail.markerText ||
			typeof e.remoteRefs !== "string" ||
			(detail.expectedBaseBlobSha !== undefined &&
				!/^[a-f0-9]{40}$/.test(detail.expectedBaseBlobSha))
		)
			throw new Error("marker intent invalid");
		const refs = e.remoteRefs.trim()
			? e.remoteRefs
					.trimEnd()
					.split("\n")
					.map((line) => line.split(/\s+/))
			: [];
		if (refs.some((row) => row.length !== 2 || !/^[a-f0-9]{40}$/.test(row[0])))
			throw new Error("remote refs invalid");
		const matches = refs.filter(
			(row) => row[1] === `refs/heads/${detail.branch}`,
		);
		if (
			matches.length === 0 &&
			e.commit === null &&
			e.tree === null &&
			e.blob === null
		)
			return detail.expectedBaseBlobSha
				? conflict("marker baseline missing")
				: { action: "execute" };
		if (
			matches.length !== 1 ||
			e.commit?.sha !== matches[0][0] ||
			e.commit.tree?.sha !== e.tree?.sha ||
			e.tree?.truncated !== false ||
			e.treeRecursive !== true ||
			!Array.isArray(e.tree?.tree)
		)
			return conflict("marker commit tree conflict");
		const leaves = e.tree.tree.filter(
			(entry) => entry.path === detail.markerPath,
		);
		if (leaves.length === 0 && e.blob === null)
			return detail.expectedBaseBlobSha
				? conflict("marker baseline missing")
				: { action: "execute" };
		if (
			leaves.length !== 1 ||
			leaves[0].type !== "blob" ||
			leaves[0].sha !== e.blob?.sha ||
			e.blob?.encoding !== "base64" ||
			typeof e.blob.content !== "string"
		)
			return conflict("marker blob conflict");
		const content = Buffer.from(e.blob.content, "base64"),
			hash = createHash("sha1")
				.update(
					Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]),
				)
				.digest("hex");
		if (hash !== e.blob.sha) return conflict("marker content conflict");
		if (!content.toString("utf8").includes(detail.markerText))
			return hash === detail.expectedBaseBlobSha
				? { action: "execute" }
				: conflict("marker content conflict");
		return adopted({
			repository: detail.repository,
			branch: detail.branch,
			head: e.commit.sha,
			markerPath: detail.markerPath,
			blobSha: hash,
		});
	}
	if (detail.kind === "decoy") {
		if (
			typeof detail.tmuxSocket !== "string" ||
			!/^\/private\/tmp\/tmux-\d+\/default$/.test(detail.tmuxSocket) ||
			e.tmuxSocket !== detail.tmuxSocket
		)
			throw new Error("production tmux scope mismatch");
		if (typeof e.tmuxInventory !== "string" || !e.tmuxInventory.trim())
			throw new Error("tmux inventory missing");
		const rows = foldTmuxWindows(
			e.tmuxInventory
				.trimEnd()
				.split("\n")
				.map((line) => line.split("|")),
			{ executionMarker: true },
		);
		const matches = rows.filter((row) => row[3] === "fly2454-decoy");
		return matches.length === 0
			? { action: "execute" }
			: matches.length === 1
				? adopted({ windowIdentity: matches[0].slice(1).join("|") })
				: conflict("decoy ambiguous");
	}
	if (detail.kind === "teardown") {
		if (
			typeof detail.archiveRoot !== "string" ||
			!isAbsolute(detail.archiveRoot) ||
			normalize(detail.archiveRoot) !== detail.archiveRoot ||
			detail.archiveRoot === "/"
		)
			throw new Error("archive root invalid");
		if (e.slotExists === true && e.archive === null)
			return { action: "execute" };
		if (
			e.slotExists === false &&
			e.archive?.exists === true &&
			e.archive.isDirectory === true &&
			Number.isFinite(e.archive.birthtimeMs) &&
			e.archive.birthtimeMs > Date.parse(intent.createdAt) &&
			e.archive.birthtimeMs <= observed &&
			typeof e.archive.path === "string" &&
			normalize(e.archive.path) === e.archive.path &&
			e.archive.path.startsWith(`${detail.archiveRoot}/`)
		)
			return adopted({ slot: config.slot, archivePath: e.archive.path });
		return conflict("teardown evidence incomplete");
	}
	if (detail.kind === "room-info") {
		const identity = detail.identity;
		if (
			!["hide", "restore"].includes(detail.action) ||
			!identity ||
			!/^[a-f0-9]{64}$/.test(identity.sha256) ||
			!Number.isInteger(identity.mode) ||
			identity.mode < 0 ||
			identity.mode > 0o777 ||
			!Number.isSafeInteger(identity.inode) ||
			identity.inode <= 0 ||
			!Number.isFinite(identity.mtimeMs)
		)
			throw new Error("room info identity invalid");
		const done = detail.action === "hide" ? e.hiddenRoomInfo : e.roomInfo,
			other = detail.action === "hide" ? e.roomInfo : e.hiddenRoomInfo;
		if (other === null && isDeepStrictEqual(done, identity))
			return adopted({ action: detail.action, identity });
		if (done === null && isDeepStrictEqual(other, identity))
			return { action: "execute" };
		return conflict("room info names or identity conflict");
	}
	if (detail.kind === "adoption") {
		if (typeof e.adoptionYaml !== "string") throw new Error("adoption missing");
		const menus = parse(e.adoptionYaml)?.[`flywheel-test-${config.slot}`];
		if (
			!Array.isArray(menus) ||
			!menus.length ||
			menus.some((x) => typeof x !== "string") ||
			new Set(menus).size !== menus.length
		)
			throw new Error("adoption malformed");
		return menus.includes("simple_code")
			? adopted({ slot: config.slot, menu: "simple_code" })
			: { action: "execute" };
	}
	const rows = processes(e.processes);
	if (detail.kind === "deploy") {
		if (
			e.slotExists === false &&
			e.roomInfo === null &&
			e.health === null &&
			e.bridgePid === null
		)
			return { action: "execute" };
		if (
			e.slotExists !== true ||
			e.roomInfo?.schemaVersion !== 1 ||
			e.roomInfo.slot !== config.slot ||
			e.roomInfo.buildSha !== config.head ||
			e.roomInfo.runnerMode !== "real" ||
			e.health?.ok !== true ||
			e.health.buildMode !== "built" ||
			e.health.buildSha !== config.head ||
			e.health.artifactBuildSha !== config.head ||
			!rows.some((p) => p.pid === e.bridgePid)
		)
			return conflict("deploy_identity_conflict");
		return adopted({
			slot: config.slot,
			buildSha: config.head,
			bridgePid: e.bridgePid,
		});
	}
	if (detail.kind === "cycle") {
		const p = detail.preState;

		if (e.cycleFailed !== false || e.launchSpecSha256 !== p.launchSpecSha256)
			return conflict("cycle_failed_or_spec_conflict");
		const current = rows.find((row) => row.pid === e.bridgePid),
			old = rows.find((row) => row.pid === p.oldPid);
		if (!current) return conflict("bridge_not_alive");
		if (old)
			return old.lstart === p.oldLstart && e.bridgePid === p.oldPid
				? { action: "execute" }
				: conflict("old_pid_identity_conflict");
		if (
			e.bridgePid === p.oldPid ||
			Date.parse(current.lstart) <= Date.parse(intent.createdAt)
		)
			return conflict("cycle_identity_conflict");
		return adopted({
			oldPid: p.oldPid,
			newPid: e.bridgePid,
			launchSpecSha256: p.launchSpecSha256,
		});
	}
	return conflict("kind_unsupported");
}
export function inspectFileAdoption({
	manifest,
	step,
	evidencePath,
	now = Date.now(),
}) {
	try {
		const entry = manifest?.steps?.[step],
			intent = entry?.intent,
			config = manifest?.config;
		if (
			!intent?.detail ||
			!Number.isFinite(Date.parse(intent.createdAt)) ||
			![1, 4].includes(config?.slot) ||
			!/^[a-f0-9]{40}$/.test(config.head)
		)
			throw new Error("intent identity invalid");
		const bytes = readFileSync(evidencePath),
			meta = JSON.parse(readFileSync(`${evidencePath}.meta.json`, "utf8")),
			observed = Date.parse(meta.observedAt);
		if (
			!Number.isFinite(observed) ||
			observed <= Date.parse(intent.createdAt) ||
			observed > now ||
			now - observed > 600000 ||
			meta.sha256 !== createHash("sha256").update(bytes).digest("hex")
		)
			throw new Error("evidence freshness or hash invalid");
		const evidence = JSON.parse(bytes);
		if (
			!isDeepStrictEqual(evidence.scope, {
				slot: config.slot,
				checkout: config.checkout,
			}) ||
			typeof config.checkout !== "string" ||
			!config.checkout.startsWith("/")
		)
			throw new Error("captured scope mismatch");
		validateCyclePreState(manifest, intent.detail);
		const result = inspect(evidence, intent, config, observed);
		if (entry.receipt)
			return result.action === "adopt-existing" &&
				isDeepStrictEqual(entry.receipt.result, result.result)
				? { ...result, action: "replay" }
				: conflict("receipt_authority_conflict");
		return result;
	} catch (error) {
		return conflict(error.message);
	}
}
