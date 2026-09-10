#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { inspectAdoption } from "./lib/qa-fly-2456-adopt.mjs";
import { alertDirsAttribution } from "./lib/qa-fly-2456-alerts.mjs";
import { dryRun } from "./lib/qa-fly-2456-dry-run.mjs";
import { inspectFileAdoption } from "./lib/qa-fly-2456-file-adopt.mjs";
import { fleetDiff, fleetIdentity } from "./lib/qa-fly-2456-fleet.mjs";
import { launchCommitsDelta } from "./lib/qa-fly-2456-launch-delta.mjs";
import { livenessCommand } from "./lib/qa-fly-2456-liveness.mjs";
import {
	manifestInit,
	manifestIntent,
	manifestPreconditionBody,
	manifestReceipt,
} from "./lib/qa-fly-2456-manifest.mjs";
import { eventBounds, observeRound } from "./lib/qa-fly-2456-observe.mjs";
import { inspectParkAdoption } from "./lib/qa-fly-2456-park-adopt.mjs";
import { procAttribution } from "./lib/qa-fly-2456-proc.mjs";
import { prepareProcComparison } from "./lib/qa-fly-2456-proc-comparison.mjs";
import { inspectQaIdentity } from "./lib/qa-fly-2456-qa-identity.mjs";
import { composeReportPair } from "./lib/qa-fly-2456-report-pair.mjs";
import { roomInfoCheck } from "./lib/qa-fly-2456-room-info.mjs";
import { runnerWindows } from "./lib/qa-fly-2456-runner-windows.mjs";
import { commScan, prodStatestoreCheck } from "./lib/qa-fly-2456-scan.mjs";
import { previewStartSelection } from "./lib/qa-fly-2456-selection.mjs";
import { activationParse, campaignShape } from "./lib/qa-fly-2456-shape.mjs";
import { inspectTerminateAdoption } from "./lib/qa-fly-2456-terminate-adopt.mjs";
import { verdictRound } from "./lib/qa-fly-2456-verdict.mjs";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function observationInputs(values) {
	if (values.manifest || values.step) {
		if (values.bounds || values.bodies)
			throw new Error("choose manifest cycle or explicit bounds/bodies");
		const manifest = json(required(values, "manifest"));
		const cycle = manifest.steps?.[required(values, "step")]?.intent?.detail;
		if (cycle?.kind !== "cycle" || !cycle.preState?.bounds)
			throw new Error("cycle bounds missing");
		const bodies = Object.fromEntries(
			["B1", "B2", "B3"].map((label) => {
				const matches = Object.values(manifest.steps).filter(
					(entry) =>
						entry.intent?.detail?.kind === "start" &&
						entry.intent.detail.label === label &&
						entry.receipt,
				);
				if (matches.length !== 1)
					throw new Error("body start missing or ambiguous");
				const entry = matches[0],
					r = entry.receipt.result;
				if (
					entry.intent.detail.issueId !== manifest.config?.issues?.[label] ||
					r?.success !== true ||
					r.generalized !== true ||
					!["executionId", "workflowRunId", "workflowNodeId"].every(
						(k) => typeof r[k] === "string" && r[k],
					)
				)
					throw new Error("body receipt invalid");
				return [
					label,
					{
						executionId: r.executionId,
						runId: r.workflowRunId,
						nodeId: r.workflowNodeId,
					},
				];
			}),
		);
		return { bounds: cycle.preState.bounds, bodies };
	}
	return {
		bounds: json(required(values, "bounds")),
		bodies: json(required(values, "bodies")),
	};
}

function required(values, name) {
	if (typeof values[name] !== "string" || !values[name])
		throw new Error(`missing --${name}`);
	return values[name];
}
function pairs(values) {
	const result = {};
	for (const value of values ?? []) {
		const match = /^([^=]+)=(.+)$/.exec(value);
		if (!match || Object.hasOwn(result, match[1]))
			throw new Error("duplicate or invalid identity assignment");
		result[match[1]] = match[2];
	}
	return result;
}
try {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		strict: true,
		options: {
			manifest: { type: "string" },
			shape: { type: "string" },
			observe: { type: "string" },
			"zero-impact": { type: "string" },
			fixture: { type: "string" },
			round: { type: "string" },
			r1: { type: "string" },
			r2: { type: "string" },
			checkout: { type: "string" },
			request: { type: "string" },
			"host-repo": { type: "string" },
			"model-config": { type: "string" },
			head: { type: "string" },
			slot: { type: "string" },
			issue: { type: "string", multiple: true },
			step: { type: "string" },
			file: { type: "string" },
			db: { type: "string" },
			comm: { type: "string" },
			baseline: { type: "string" },
			raw: { type: "string" },
			"sensor-pid": { type: "string" },
			after: { type: "string" },
			before: { type: "string" },
			"slot-lead": { type: "string" },
			"slot-dir": { type: "string" },
			identity: { type: "string" },
			runs: { type: "string", multiple: true },
			exec: { type: "string", multiple: true },
			body: { type: "string", multiple: true },
			bounds: { type: "string" },
			bodies: { type: "string" },
			liveness: { type: "string" },
			lead: { type: "string" },
			"prod-statestore": { type: "string" },
			"tmux-inventory": { type: "string" },
			"prod-socket-root": { type: "string" },
			out: { type: "string" },
			"declared-sockets": { type: "string" },
			decoy: { type: "string" },
			sidecar: { type: "string" },
			"kill-ledger": { type: "string", multiple: true },
			window: { type: "string" },
			"before-identity": { type: "string" },
			"after-identity": { type: "string" },
			evidence: { type: "string" },
			runbook: { type: "string" },
			scanner: { type: "string" },
			receipt: { type: "string" },
			"runtime-module": { type: "string" },
			"state-dir": { type: "string" },
			"socket-root": { type: "string" },
			"marker-dir": { type: "string" },
			"node-executable": { type: "string" },
			mode: { type: "string" },
		},
	});
	let result;
	if (positionals[0] === "proc-prepare" && positionals.length === 1) {
		result = prepareProcComparison({
			rawPath: required(values, "raw"),
			sensorPid: Number(required(values, "sensor-pid")),
			outPath: required(values, "out"),
		});
	} else if (positionals[0] === "report-pair" && positionals.length === 1) {
		result = composeReportPair({
			r1Path: required(values, "r1"),
			r2Path: required(values, "r2"),
		});
	} else if (
		positionals[0] === "selection-preview" &&
		positionals.length === 1
	) {
		result = await previewStartSelection({
			dbPath: required(values, "db"),
			requestPath: required(values, "request"),
			checkout: required(values, "checkout"),
			hostRepo: required(values, "host-repo"),
			modelConfigPath: required(values, "model-config"),
		});
	} else if (positionals.length === 1 && positionals[0] === "verdict")
		result = verdictRound({
			round: required(values, "round"),
			manifestPath: required(values, "manifest"),
			shapePath: required(values, "shape"),
			observePath: required(values, "observe"),
			zeroImpactPath: required(values, "zero-impact"),
			fixturePath: required(values, "fixture"),
		});
	else if (positionals.length === 1 && positionals[0] === "bounds")
		result = eventBounds(required(values, "db"), values.runs);
	else if (positionals.length === 1 && positionals[0] === "activation-parse") {
		if (values.exec?.length !== 1)
			throw new Error("exactly one --exec required");
		result = activationParse(required(values, "db"), values.exec[0]);
	} else if (positionals.length === 1 && positionals[0] === "campaign-shape")
		result = campaignShape({
			dbPath: required(values, "db"),
			commPath: required(values, "comm"),
			livenessPath: required(values, "liveness"),
			bodies: pairs(values.body),
		});
	else if (positionals.length === 1 && positionals[0] === "observe")
		result = observeRound({
			dbPath: required(values, "db"),
			...observationInputs(values),
		});
	else if (positionals.length === 1 && positionals[0] === "comm-scan")
		result = commScan(required(values, "db"), {
			slot: required(values, "slot"),
			executions: values.exec,
			lead: values.lead,
		});
	else if (
		positionals.length === 1 &&
		positionals[0] === "prod-statestore-check"
	)
		result = prodStatestoreCheck(required(values, "db"), {
			executions: values.exec,
		});
	else if (positionals.length === 1 && positionals[0] === "fleet-identity") {
		result = fleetIdentity({
			dbPath: required(values, "prod-statestore"),
			tmuxInventoryPath: required(values, "tmux-inventory"),
			prodSocketRoot: required(values, "prod-socket-root"),
		});
		const out = required(values, "out");
		if (result.status === "pass")
			writeFileSync(out, JSON.stringify(result) + "\n", {
				flag: "wx",
				mode: 0o444,
			});
	} else if (positionals.length === 1 && positionals[0] === "fleet-diff")
		result = fleetDiff({
			beforePath: required(values, "before"),
			afterPath: required(values, "after"),
			mode: required(values, "mode"),
			declaredSockets: values["declared-sockets"]
				? json(values["declared-sockets"])
				: [],
			decoy: values.decoy,
			sidecarPath: values.sidecar,
			dbPath: values["prod-statestore"],
			killLedgerPaths: values["kill-ledger"],
			window: values.window ? json(values.window) : undefined,
		});
	else if (positionals.length === 1 && positionals[0] === "runner-windows")
		result = runnerWindows({
			beforePath: required(values, "before"),
			afterPath: required(values, "after"),
			beforeIdentityPath: values["before-identity"],
			afterIdentityPath: values["after-identity"],
			dbPath: values.db,
			window: values.window ? json(values.window) : undefined,
		});
	else if (
		positionals.length === 1 &&
		positionals[0] === "launch-commits-delta"
	)
		result = launchCommitsDelta({
			beforePath: required(values, "before"),
			afterPath: required(values, "after"),
			manifest: json(required(values, "manifest")),
			dbPath: values.db,
			cycleStep: values.step,
		});
	else if (positionals.length === 1 && positionals[0] === "dry-run")
		result = dryRun({
			runbookPath: required(values, "runbook"),
			scannerPath: required(values, "scanner"),
			receiptPath: required(values, "receipt"),
		});
	else if (positionals.length === 1 && positionals[0] === "liveness-command")
		result = {
			status: "pass",
			command: livenessCommand({
				runtimeModule: required(values, "runtime-module"),
				stateDir: required(values, "state-dir"),
				socketRoot: required(values, "socket-root"),
				markerDir: required(values, "marker-dir"),
				executions: values.exec,
				nodeExecutable: values["node-executable"],
			}),
		};
	else if (
		positionals[0] === "alert-dirs-attribution" &&
		positionals.length === 1
	) {
		result = alertDirsAttribution({
			beforePath: required(values, "before"),
			afterPath: required(values, "after"),
			slotLead: required(values, "slot-lead"),
		});
	} else if (
		positionals[0] === "proc-attribution" &&
		positionals.length === 1
	) {
		result = procAttribution({
			baselinePath: required(values, "baseline"),
			afterPath: required(values, "after"),
			slotDir: required(values, "slot-dir"),
			checkout: required(values, "checkout"),
			mode: values.mode,
		});
	} else if (positionals[0] === "room-info" && positionals.length === 2) {
		result = roomInfoCheck({
			slotDir: required(values, "slot-dir"),
			phase: positionals[1],
			identity: values.identity
				? JSON.parse(readFileSync(values.identity, "utf8"))
				: undefined,
		});
	} else {
		if (positionals.length !== 2 || positionals[0] !== "manifest")
			throw new Error("unsupported command");
		const path = required(values, "manifest");
		if (positionals[1] === "init")
			result = manifestInit(path, {
				round: required(values, "round"),
				checkout: required(values, "checkout"),
				head: required(values, "head"),
				slot: Number(required(values, "slot")),
				issues: pairs(values.issue),
			});
		else if (positionals[1] === "precondition-body")
			result = manifestPreconditionBody(
				path,
				values.issue?.length === 1 ? values.issue[0] : undefined,
			);
		else if (positionals[1] === "intent")
			result = manifestIntent(
				path,
				required(values, "step"),
				JSON.parse(readFileSync(required(values, "file"), "utf8")),
			);
		else if (positionals[1] === "receipt")
			result = manifestReceipt(
				path,
				required(values, "step"),
				json(required(values, "file")),
			);
		else if (positionals[1] === "adopt") {
			const step = required(values, "step");
			const manifest = json(path),
				kind = manifest.steps?.[step]?.intent?.detail?.kind;
			const input = {
				manifest,
				step,
				dbPath: values.db,
				commPath: values.comm,
			};
			if (kind === "qa-identity") result = inspectQaIdentity(input);
			else if (kind === "park-complete") result = inspectParkAdoption(input);
			else if (kind === "terminate") result = inspectTerminateAdoption(input);
			else if (
				[
					"deploy",
					"adoption",
					"cycle",
					"decoy",
					"teardown",
					"room-info",
					"park-marker",
					"park-pr",
				].includes(kind)
			)
				result = inspectFileAdoption({
					manifest,
					step,
					evidencePath: required(values, "evidence"),
				});
			else result = inspectAdoption(input);
			if (result.action === "adopt-existing")
				manifestReceipt(path, step, result.result);
			if (result.action === "conflict") process.exitCode = 1;
		} else throw new Error("unsupported manifest action");
	}
	if (result.status && result.status !== "pass") process.exitCode = 1;
	console.log(JSON.stringify(result));
} catch (error) {
	console.log(JSON.stringify({ status: "fail", reason: error.message }));
	process.exitCode = 1;
}
