import { createHash, timingSafeEqual } from "node:crypto";
import { type Request, type Response, Router } from "express";
import {
	parseCodexQuotaBindingV1,
	parseCodexQuotaSignalV1,
} from "flywheel-core";
import type { StateStore } from "../StateStore.js";

export interface CodexQuotaRouteOptions {
	store: StateStore;
	ingestToken?: string;
	credential(): Promise<{
		rootKey: string;
		profile: string;
		accountKey: string;
		generation: number;
		authDigest: string;
	}>;
}
const identifier = (value: unknown): value is string =>
	typeof value === "string" && /^[-A-Za-z0-9:_]{1,512}$/.test(value);
const exact = (
	body: unknown,
	keys: string[],
): body is Record<string, unknown> =>
	!!body &&
	typeof body === "object" &&
	!Array.isArray(body) &&
	Object.keys(body).every((key) => keys.includes(key));

export function createCodexQuotaRouter(
	options: CodexQuotaRouteOptions,
): Router {
	const router = Router();
	const quota = options.store.codexQuota;
	router.use((req, res, next) => {
		if (!options.ingestToken) {
			res.status(503).json({ code: "CODEX_QUOTA_UNAVAILABLE" });
			return;
		}
		const expected = Buffer.from(`Bearer ${options.ingestToken}`);
		const actual = Buffer.from(req.get("authorization") ?? "");
		if (
			actual.length !== expected.length ||
			!timingSafeEqual(actual, expected)
		) {
			res.status(401).json({ code: "UNAUTHORIZED" });
			return;
		}
		next();
	});
	const owner = (input: Record<string, unknown>, res: Response): boolean => {
		if (!identifier(input.executionId) || !identifier(input.projectName)) {
			res.status(400).json({ code: "INVALID_QUOTA_OWNER" });
			return false;
		}
		const session = options.store.getSession(input.executionId);
		if (!session || session.project_name !== input.projectName) {
			res.status(403).json({ code: "QUOTA_OWNER_MISMATCH" });
			return false;
		}
		return true;
	};
	const status = (bindingId: string) => {
		const binding = quota.getBinding(bindingId)!;
		const parent = options.store.getSession(binding.executionId);
		const parentTerminal =
			!parent ||
			["completed", "failed", "terminated", "cancelled", "stopped"].includes(
				parent.status,
			);
		if (parentTerminal)
			quota.updateTarget(
				`codex:${binding.credentialRootKey}:${binding.generation}`,
				"review",
				bindingId,
				{ state: "abandoned" },
			);
		const root = quota.getRoot(binding.credentialRootKey);
		const incident = quota.getIncident(
			`codex:${binding.credentialRootKey}:${binding.generation}`,
		);
		const target =
			incident &&
			quota
				.listTargets(String(incident.incident_id))
				.find(
					(row) => row.target_kind === "review" && row.target_id === bindingId,
				);
		const state =
			parentTerminal || target?.state === "abandoned"
				? "abandoned"
				: incident?.state === "probe_failed" &&
						root?.generation === binding.generation
					? "probe_failed"
					: !root ||
							quota.isPaused(binding.credentialRootKey) ||
							(target &&
								target.state !== "recovered" &&
								!options.store.getCodexQuotaRecoveryPermit(
									String(incident!.incident_id),
								))
						? "paused"
						: "ready";
		return { state, generation: root?.generation ?? binding.generation };
	};
	router.post("/bind", async (req, res) => {
		if (
			!exact(req.body, [
				"executionId",
				"projectName",
				"invocationId",
				"purpose",
				"authDigest",
				"model",
			]) ||
			!identifier(req.body.invocationId) ||
			typeof req.body.model !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(req.body.model) ||
			req.body.purpose !== "review" ||
			typeof req.body.authDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(req.body.authDigest)
		) {
			res.status(400).json({ code: "INVALID_QUOTA_BIND" });
			return;
		}
		if (!owner(req.body, res)) return;
		const parent = options.store.getSession(req.body.executionId as string);
		if (
			!parent ||
			["completed", "failed", "terminated", "cancelled", "stopped"].includes(
				parent.status,
			)
		) {
			res.status(409).json({ code: "QUOTA_PARENT_TERMINAL" });
			return;
		}
		try {
			const credential = await options.credential();
			const root = quota.getRoot(credential.rootKey);
			if (
				credential.authDigest !== req.body.authDigest ||
				!root ||
				root.accountKey !== credential.accountKey ||
				root.profile !== credential.profile ||
				root.generation !== credential.generation
			) {
				res.status(409).json({ code: "QUOTA_CREDENTIAL_MISMATCH" });
				return;
			}
			const bindingId = `review:${createHash("sha256")
				.update(JSON.stringify([req.body.executionId, req.body.invocationId]))
				.digest("hex")}`;
			const binding = parseCodexQuotaBindingV1({
				bindingId,
				executionId: req.body.executionId,
				runId: null,
				purpose: "review",
				accountKey: root.accountKey,
				profile: root.profile,
				generation: root.generation,
				credentialRootKey: root.rootKey,
			});
			if (!binding) throw new Error("invalid binding");
			quota.registerBinding(binding);
			quota.registerReviewModel(bindingId, req.body.model);
			res.json({ binding, ...status(bindingId) });
		} catch {
			res.status(503).json({ code: "CODEX_QUOTA_UNAVAILABLE" });
		}
	});
	router.post("/observe", (req, res) => {
		if (!exact(req.body, ["executionId", "projectName", "signal"])) {
			res.status(400).json({ code: "INVALID_QUOTA_SIGNAL" });
			return;
		}
		const signal = parseCodexQuotaSignalV1(req.body.signal);
		if (!signal || signal.source !== "review_exec") {
			res.status(400).json({ code: "INVALID_QUOTA_SIGNAL" });
			return;
		}
		if (!owner(req.body, res)) return;
		const binding = quota.getBinding(signal.bindingId);
		if (
			!binding ||
			binding.executionId !== req.body.executionId ||
			binding.purpose !== "review"
		) {
			res.status(403).json({ code: "QUOTA_BINDING_MISMATCH" });
			return;
		}
		quota.recordSignal({
			executionId: binding.executionId,
			bindingId: binding.bindingId,
		});
		res.json({ accepted: true });
	});
	const handleStatus = (req: Request, res: Response) => {
		const input = req.method === "GET" ? req.query : req.body;
		if (
			!exact(
				input,
				req.method === "GET"
					? ["bindingId", "executionId", "projectName"]
					: [
							"bindingId",
							"executionId",
							"projectName",
							"state",
							"successorBindingId",
						],
			) ||
			!identifier(input.bindingId) ||
			(req.method !== "GET" &&
				!["abandoned", "resumed"].includes(String(input.state)))
		) {
			res.status(400).json({ code: "INVALID_QUOTA_STATUS" });
			return;
		}
		if (!owner(input, res)) return;
		const binding = quota.getBinding(input.bindingId);
		if (
			!binding ||
			binding.executionId !== input.executionId ||
			binding.purpose !== "review"
		) {
			res.status(403).json({ code: "QUOTA_BINDING_MISMATCH" });
			return;
		}
		if (req.method === "POST" && input.state === "resumed") {
			const successor =
				typeof input.successorBindingId === "string"
					? quota.getBinding(input.successorBindingId)
					: undefined;
			const root = quota.getRoot(binding.credentialRootKey);
			if (
				!options.store.getCodexQuotaRecoveryPermit(
					`codex:${binding.credentialRootKey}:${binding.generation}`,
				) ||
				!successor ||
				successor.purpose !== "review" ||
				successor.executionId !== binding.executionId ||
				successor.credentialRootKey !== binding.credentialRootKey ||
				successor.generation !== root?.generation ||
				successor.generation <= binding.generation ||
				quota.isPaused(binding.credentialRootKey)
			) {
				res.status(409).json({ code: "QUOTA_RESUME_UNPROVEN" });
				return;
			}
		}
		if (req.method === "POST")
			quota.updateTarget(
				`codex:${binding.credentialRootKey}:${binding.generation}`,
				"review",
				binding.bindingId,
				{ state: input.state === "resumed" ? "recovered" : "abandoned" },
			);
		res.json(status(binding.bindingId));
	};
	router.get("/status", handleStatus);
	router.post("/status", handleStatus);
	return router;
}
