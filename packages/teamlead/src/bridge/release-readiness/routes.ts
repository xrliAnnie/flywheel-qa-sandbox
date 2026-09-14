import { Router } from "express";
import { z } from "zod";
import type { StateStore } from "../../StateStore.js";
import { masterOnlyAuthMiddleware } from "../dependency-route.js";
import { evaluateReadiness } from "./evaluate.js";
import { renderReadinessReport } from "./report.js";
import type { ReleaseReadinessService } from "./service.js";
import { parseReadinessSubject, type ReadinessSubject } from "./subject.js";

const commit = z
	.string()
	.length(40)
	.regex(/^[0-9a-f]{40}$/);
const issueIdentifier = z.string().regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/);
const resolution = z.union([
	z
		.object({
			issueIdentifier,
		})
		.strict(),
	z
		.object({
			abandon: z.literal(true),
			reason: z.string().trim().min(1).max(200),
		})
		.strict(),
]);

export function createReadinessRouter(deps: {
	store: StateStore;
	service: ReleaseReadinessService;
	subject: () => ReadinessSubject | null;
	masterToken?: string;
	scopedToken?: string;
}): Router {
	const router = Router();
	router.post("/report/render", (req, res) => {
		const body = z
			.object({
				day: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.refine((day) => {
						const date = new Date(`${day}T00:00:00.000Z`);
						return (
							Number.isFinite(date.getTime()) &&
							date.toISOString().slice(0, 10) === day
						);
					})
					.optional(),
			})
			.strict()
			.safeParse(req.body ?? {});
		const subject = deps.subject();
		if (!body.success || !subject) {
			res
				.status(400)
				.json({ error: "valid day and local version identity required" });
			return;
		}
		const input = deps.service.collect(subject);
		const verdict = deps.store.appendReleaseReadinessVerdict({
			...evaluateReadiness(input),
			subject,
			evaluatedAt: input.now,
		});
		try {
			res
				.set("X-Readiness-Commit", subject.sourceCommit)
				.set("X-Readiness-Version", subject.baseVersion)
				.type("html")
				.send(
					renderReadinessReport(
						input,
						verdict,
						body.data.day ?? input.now.slice(0, 10),
					),
				);
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			res.status(413).json({ error: error.message });
		}
	});
	router.post("/bug-report", (req, res) => {
		const input = z
			.object({
				issueIdentifier,
				sourceCommit: commit.optional(),
				baseVersion: z.string().optional(),
				reporter: z.string().min(1).max(200).optional(),
			})
			.strict()
			.safeParse(req.body);
		if (!input.success) {
			res.status(400).json({ error: "invalid bug report" });
			return;
		}
		const explicit =
			input.data.sourceCommit !== undefined ||
			input.data.baseVersion !== undefined;
		const subject = explicit
			? parseReadinessSubject(input.data.baseVersion, input.data.sourceCommit)
			: deps.subject();
		if (explicit && !subject) {
			res
				.status(400)
				.json({ error: "valid sourceCommit and baseVersion required" });
			return;
		}
		const result = deps.store.recordReleaseBugReport({
			issueIdentifier: input.data.issueIdentifier,
			sourceCommit: subject?.sourceCommit ?? null,
			baseVersion: subject?.baseVersion ?? null,
			reporter: input.data.reporter ?? null,
			at: new Date().toISOString(),
		});
		res.status(result.created ? 201 : 200).json(result.report);
	});
	router.get("/verdict", (req, res) => {
		const subject =
			Object.keys(req.query).length === 0
				? deps.subject()
				: parseReadinessSubject(req.query.baseVersion, req.query.commit);
		if (!subject) {
			res.status(400).json({ error: "valid commit and baseVersion required" });
			return;
		}
		res.json(deps.service.evaluate(subject));
	});
	router.get("/verdicts", (req, res) => {
		const query = z
			.object({
				commit,
				limit: z
					.string()
					.regex(/^[1-9][0-9]*$/)
					.transform(Number)
					.pipe(z.number().int().min(1).max(100))
					.optional(),
			})
			.safeParse(req.query);
		if (!query.success) {
			res.status(400).json({ error: "valid commit and limit 1..100 required" });
			return;
		}
		res.json(
			deps.store.getReleaseReadinessVerdicts(
				query.data.commit,
				query.data.limit,
			),
		);
	});
	router.post(
		"/bug-intent/:intentId/resolve",
		masterOnlyAuthMiddleware(deps.masterToken, deps.scopedToken),
		(req, res) => {
			const input = resolution.safeParse(req.body);
			const intentId = z.string().min(1).safeParse(req.params.intentId);
			if (!input.success || !intentId.success) {
				res.status(400).json({
					error: "issueIdentifier or abandon with nonempty reason required",
				});
				return;
			}
			const result = deps.store.resolveReleaseBugIntent({
				...input.data,
				intentId: intentId.data,
				resolvedBy: "master-api-token",
				resolvedAt: new Date().toISOString(),
			});
			if (!result) {
				res.status(404).json({ error: "intent not found" });
				return;
			}
			res.json(result);
		},
	);
	return router;
}
