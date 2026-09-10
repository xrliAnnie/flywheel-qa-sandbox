import express from "express";
import {
	type ProjectEntry,
	type ProjectLinearBinding,
	resolveLeadDepartment,
} from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	ActiveScopeNotFoundError,
	EpicSnapshotTruncatedError,
	EpicTooLargeError,
	fetchLinearActiveScopeSnapshot,
	type LinearActiveScopeSnapshot,
} from "./linear-epic-query.js";
import {
	type LinearIssue,
	lookupLinearIssueByIdentifier,
} from "./linear-query.js";
import { issueMatchesBinding } from "./linear-scope.js";

export interface LeadNoteRouterDeps {
	store: Pick<
		StateStore,
		"setLeadNote" | "getLeadNote" | "getLeadNotes" | "clearLeadNote"
	>;
	projects: ProjectEntry[];
	linearApiKey?: string;
	lookup?: (identifier: string) => Promise<LinearIssue | null>;
	fetchSnapshot?: (
		apiKey: string,
		binding: ProjectLinearBinding,
	) => Promise<LinearActiveScopeSnapshot>;
	now?: () => Date;
	onEpicChange?: (project: string, reason: "lead_note_changed") => void;
}

const IDENTIFIER = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Plain one-line text; role identity is the original configured department.
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const validRole = (role: string) =>
	role.length > 0 && role === role.trim() && !CONTROL.test(role);

export function createLeadNoteRouter(deps: LeadNoteRouterDeps): express.Router {
	const router = express.Router();
	for (const command of ["set", "show", "clear"] as const) {
		router[command === "show" ? "get" : "post"](
			`/${command}`,
			async (req, res) => {
				const fail = (status: number, error: string) => {
					res.status(status).json({ ok: false, error });
				};
				const input: unknown = command === "show" ? req.query : req.body;
				if (!input || typeof input !== "object" || Array.isArray(input)) {
					fail(400, "invalid_arguments");
					return;
				}
				const fields = input as Record<string, unknown>;
				const allowed =
					command === "set"
						? ["projectName", "issue", "role", "text"]
						: ["projectName", "issue", "role"];
				if (
					Object.entries(fields).some(
						([key, value]) =>
							!allowed.includes(key) || typeof value !== "string",
					)
				) {
					fail(400, "invalid_arguments");
					return;
				}
				const { projectName, issue, role } = fields as Record<string, string>;
				if (
					!projectName ||
					!issue ||
					(command !== "show" && role === undefined) ||
					(command === "set" && fields.text === undefined) ||
					(!IDENTIFIER.test(issue) && !(command !== "set" && UUID.test(issue)))
				) {
					fail(400, "invalid_arguments");
					return;
				}
				const project = deps.projects.find(
					(entry) => entry.projectName === projectName,
				);
				if (!project) {
					fail(404, "unknown_project");
					return;
				}
				if (command === "set") {
					const roles = project.leads
						.map(resolveLeadDepartment)
						.filter((value): value is string => value !== undefined);
					if (role !== undefined && roles.includes(role) && !validRole(role)) {
						fail(422, "role_configuration_invalid");
						return;
					}
					if (!roles.some(validRole)) {
						fail(422, "role_configuration_missing");
						return;
					}
					if (role === undefined || !roles.includes(role) || !validRole(role)) {
						fail(400, "invalid_role");
						return;
					}
				} else if (role !== undefined && !validRole(role)) {
					fail(400, "invalid_role");
					return;
				}
				const text =
					command === "set"
						? (fields.text as string).normalize("NFC").trim()
						: undefined;
				if (
					command === "set" &&
					(!text ||
						[...text].length > 280 ||
						CONTROL.test(fields.text as string))
				) {
					fail(400, "invalid_text");
					return;
				}
				let issueUuid = issue;
				if (!UUID.test(issue)) {
					if (!project.linear) {
						fail(404, "project_unbound");
						return;
					}
					if (!deps.linearApiKey) {
						fail(501, "linear_not_configured");
						return;
					}
					try {
						const found = await (
							deps.lookup ??
							((identifier: string) =>
								lookupLinearIssueByIdentifier(deps.linearApiKey!, identifier))
						)(issue);
						if (!found) {
							fail(404, "issue_not_found");
							return;
						}
						if (!issueMatchesBinding(found, project.linear)) {
							const snapshot = await (
								deps.fetchSnapshot ?? fetchLinearActiveScopeSnapshot
							)(deps.linearApiKey, project.linear);
							if (snapshot.roots.length === 0) {
								fail(422, "scope_membership_unavailable");
								return;
							}
							if (
								!snapshot.roots.some((root) => root.id === found.id) &&
								!snapshot.descendantIds.includes(found.id)
							) {
								fail(403, "issue_outside_project");
								return;
							}
						}
						issueUuid = found.id;
					} catch (error) {
						if (
							error instanceof ActiveScopeNotFoundError ||
							error instanceof EpicSnapshotTruncatedError ||
							error instanceof EpicTooLargeError
						)
							fail(422, "scope_membership_unavailable");
						else fail(502, "linear_unavailable");
						return;
					}
				}
				const base = {
					ok: true,
					command,
					project: projectName,
					issue,
					issue_uuid: issueUuid,
				};
				let changed = true;
				let note:
					| { text: string; role: string; written_at: string }
					| undefined;
				try {
					if (command === "show") {
						const notes = deps.store
							.getLeadNotes(projectName, [issueUuid])
							.filter((note) => role === undefined || note.role === role)
							.map(({ text, role, written_at }) => ({
								text,
								role,
								written_at,
							}));
						res.json({ ...base, notes });
						return;
					}
					if (command === "set") {
						note = {
							text: text!,
							role: role!,
							written_at: (deps.now?.() ?? new Date()).toISOString(),
						};
						deps.store.setLeadNote({
							projectName,
							issueUuid,
							role: note.role,
							text: note.text,
							writtenAt: note.written_at,
						});
					} else
						changed = deps.store.clearLeadNote(projectName, issueUuid, role!);
				} catch {
					fail(500, "store_error");
					return;
				}
				let refresh = changed ? "unavailable" : "unchanged";
				if (changed && deps.onEpicChange) {
					try {
						deps.onEpicChange(projectName, "lead_note_changed");
						refresh = "invoked";
					} catch {
						/* Durable write succeeded; refresh is unavailable. */
					}
				}
				res.json({
					...base,
					...(command === "set" ? { note } : { role, changed }),
					refresh,
				});
			},
		);
	}
	return router;
}
