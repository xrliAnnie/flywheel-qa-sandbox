import { Router } from "express";
import type { StateStore, Session } from "../StateStore.js";

function omitIssueId(session: Session): Omit<Session, "issue_id"> & { identifier?: string } {
	const { issue_id: _, issue_identifier, ...rest } = session;
	return { ...rest, identifier: issue_identifier };
}

export function createQueryRouter(store: StateStore): Router {
	const router = Router();

	router.get("/sessions", (req, res) => {
		const mode = (req.query.mode as string) ?? "active";
		const rawLimit = parseInt((req.query.limit as string) ?? "20", 10);
		const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 20;

		let sessions: Session[];

		switch (mode) {
			case "active":
				sessions = store.getActiveSessions();
				break;
			case "recent":
				sessions = store.getRecentSessions(limit);
				break;
			case "stuck": {
				const rawThreshold = parseInt((req.query.stuck_threshold as string) ?? "15", 10);
			const threshold = Number.isFinite(rawThreshold) ? Math.min(Math.max(rawThreshold, 1), 1440) : 15;
				sessions = store.getStuckSessions(threshold);
				break;
			}
			case "by_identifier": {
				const identifier = req.query.identifier as string;
				if (!identifier) {
					res.status(400).json({ error: "identifier query param required for mode=by_identifier" });
					return;
				}
				const session = store.getSessionByIdentifier(identifier);
				sessions = session ? [session] : [];
				break;
			}
			default:
				res.status(400).json({ error: `Unknown mode: ${mode}` });
				return;
		}

		res.json({
			sessions: sessions.map(omitIssueId),
			count: sessions.length,
		});
	});

	router.get("/sessions/:id", (req, res) => {
		const id = req.params.id;

		// Deterministic fallback: try execution_id first, then identifier
		let session = store.getSession(id);
		if (!session) {
			session = store.getSessionByIdentifier(id);
		}
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}

		res.json(omitIssueId(session));
	});

	router.get("/sessions/:id/history", (req, res) => {
		const id = req.params.id;

		// Resolve session first using same deterministic fallback
		let session = store.getSession(id);
		if (!session) {
			session = store.getSessionByIdentifier(id);
		}
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}

		const history = store.getSessionHistory(session.issue_id);
		res.json({
			identifier: session.issue_identifier,
			history: history.map(omitIssueId),
			count: history.length,
		});
	});

	return router;
}
