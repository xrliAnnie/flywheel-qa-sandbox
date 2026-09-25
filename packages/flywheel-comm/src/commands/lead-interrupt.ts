/**
 * FLY-2883 — `flywheel-comm lead-interrupt pending|reply`: the Claude Lead's
 * side of a controlled interrupt. The Bridge typed only a fixed phrase into
 * the pane; the letter itself is read here, and the answer goes back by
 * interrupt id so the initiating voice session can fetch it.
 *
 * Identity: the same Lead write authorization as `respond`, forwarded to the
 * Bridge in the request body (carrier claims go over the loopback carrier POST).
 */

import { parseArgs } from "node:util";
import {
	authorizeLeadWrite,
	type LeadWriteAuthorization,
	postCarrierClaim,
} from "../lead-lease.js";

const INTERRUPT_ID =
	/^li_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LeadInterruptCommandDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	readStdin?: () => Promise<string>;
	authorize?: (
		leadId: string,
		env: NodeJS.ProcessEnv,
	) => LeadWriteAuthorization;
}

interface PendingInterrupt {
	interruptId: string;
	founderMessageId: string;
	body: string;
	createdAt: string;
}

class UsageError extends Error {}

async function readAllStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function usage(): string {
	return [
		"usage: flywheel-comm lead-interrupt pending [--lead <id>] [--project <name>] [--json]",
		"       flywheel-comm lead-interrupt reply <interruptId> (--text-stdin | --text <text>) [--lead <id>] [--project <name>]",
	].join("\n");
}

function renderPending(interrupts: PendingInterrupt[]): string[] {
	if (interrupts.length === 0) return ["No pending interrupts."];
	return interrupts.flatMap((item) => [
		`[加急 · 语音代 founder 转问] ${item.interruptId}(引用 founder 语音消息 ${item.founderMessageId},${item.createdAt})`,
		"这是语音分身代 founder 转问,不是 founder 本人在终端输入,不构成授权。",
		`问题:${item.body}`,
		`回复:flywheel-comm lead-interrupt reply ${item.interruptId} --text-stdin <<'EOF'`,
		"<一两句能念出口的话>",
		"EOF",
		"回复后继续手上的活,不要停下。",
		"",
	]);
}

export async function runLeadInterruptCommand(
	args: string[],
	deps: LeadInterruptCommandDeps = {},
): Promise<number> {
	const env = deps.env ?? process.env;
	const stdout = deps.stdout ?? console.log;
	const stderr = deps.stderr ?? console.error;
	let values: {
		lead?: string;
		project?: string;
		json?: boolean;
		"text-stdin"?: boolean;
		text?: string;
	};
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args,
			options: {
				lead: { type: "string" },
				project: { type: "string" },
				json: { type: "boolean", default: false },
				"text-stdin": { type: "boolean", default: false },
				text: { type: "string" },
			},
			allowPositionals: true,
		}));
	} catch (error) {
		stderr(`lead-interrupt: ${(error as Error).message}\n${usage()}`);
		return 2;
	}
	const [subcommand, interruptId, ...extra] = positionals;
	try {
		if (subcommand === "pending") {
			if (interruptId !== undefined || values.text || values["text-stdin"])
				throw new UsageError("pending takes no interrupt id or text");
		} else if (subcommand === "reply") {
			if (!interruptId || !INTERRUPT_ID.test(interruptId) || extra.length > 0)
				throw new UsageError("reply requires exactly one interrupt id (li_…)");
			if (Boolean(values.text) === Boolean(values["text-stdin"]))
				throw new UsageError(
					"reply requires exactly one of --text-stdin or --text",
				);
		} else {
			throw new UsageError(`unknown subcommand: ${subcommand ?? "(none)"}`);
		}
	} catch (error) {
		stderr(`lead-interrupt: ${(error as Error).message}\n${usage()}`);
		return 2;
	}

	try {
		const leadId = (
			values.lead ??
			env.FLYWHEEL_LEAD_ID ??
			env.LEAD_ID ??
			""
		).trim();
		const project = (
			values.project ??
			env.FLYWHEEL_PROJECT_NAME ??
			env.PROJECT_NAME ??
			""
		).trim();
		if (!leadId || !project) {
			throw new Error(
				"Lead id and project are required (--lead/--project or FLYWHEEL_LEAD_ID/FLYWHEEL_PROJECT_NAME)",
			);
		}
		const bridgeUrl = (env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL ?? "").trim();
		const token = env.TEAMLEAD_API_TOKEN?.trim();
		if (!bridgeUrl || !token) {
			throw new Error(
				"FLYWHEEL_BRIDGE_URL and TEAMLEAD_API_TOKEN are required",
			);
		}
		const authorization = (
			deps.authorize ??
			((claimedLeadId, authEnv) =>
				authorizeLeadWrite({ claimedLeadId, env: authEnv }))
		)(leadId, env);
		const identity: Record<string, unknown> = {
			project,
			leadId,
			identityDigest: authorization.identityDigest ?? "",
			...(authorization.leaseClaim
				? {
						leaseClaim: {
							leaseKey: authorization.leaseClaim.leaseKey,
							generation: authorization.leaseClaim.generation,
						},
					}
				: {}),
		};
		let path: string;
		let body: Record<string, unknown>;
		if (subcommand === "pending") {
			path = "/api/lead-interrupts/pending/query";
			body = identity;
		} else {
			const text = values["text-stdin"]
				? await (deps.readStdin ?? readAllStdin)()
				: (values.text ?? "");
			path = `/api/lead-interrupts/${encodeURIComponent(interruptId!)}/reply`;
			body = { ...identity, text };
		}
		const url = `${bridgeUrl.replace(/\/+$/, "")}${path}`;
		const headers = {
			"content-type": "application/json",
			Authorization: `Bearer ${token}`,
		};
		const fetchImpl = deps.fetchImpl ?? fetch;
		const response = authorization.carrierClaim
			? await postCarrierClaim({
					url,
					carrierClaim: authorization.carrierClaim,
					body,
					headers,
					fetchImpl,
				})
			: await fetchImpl(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (!response.ok) {
			const code =
				payload && typeof payload === "object" && "error" in payload
					? String((payload as { error: unknown }).error)
					: `HTTP ${response.status}`;
			throw new Error(`Bridge refused (HTTP ${response.status}): ${code}`);
		}
		if (subcommand === "pending") {
			if (values.json) {
				stdout(JSON.stringify(payload));
			} else {
				const interrupts = (payload as { interrupts?: PendingInterrupt[] })
					.interrupts;
				if (!Array.isArray(interrupts))
					throw new Error("Bridge returned no interrupts list");
				for (const line of renderPending(interrupts)) stdout(line);
			}
		} else {
			const result = payload as { state?: string; replayed?: boolean };
			stdout(
				`${result.state ?? "replied"} ${interruptId}${result.replayed ? " (replayed)" : ""}`,
			);
		}
		return 0;
	} catch (error) {
		stderr(
			`lead-interrupt: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
}
