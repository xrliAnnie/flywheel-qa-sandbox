/** FLY-2033: real IO assembly for the meeting-artifact reconciler. */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { LinearClient } from "@linear/sdk";
import { resolveFounderTimezone } from "../packages/config/dist/founder-timezone.js";
import {
	canonicalizeMeetingStateDir,
	loadMeetingNotesConfig,
	loadTrustedCurrentMeeting,
	loadTrustedMeetingArchive,
	type MeetingNotesConfig,
} from "../packages/teamlead/dist/meeting-notes-config.js";
import {
	buildMeetingIssueDescription,
	canBootstrapMeetingLabel,
	collectLinearPages,
	executeMeetingNotesActions,
	findUnarchivedTerminalMeetings,
	indexMeetingIssues,
	type LinearPage,
	MEETING_LABEL_DESCRIPTION,
	type MeetingIssueObservation,
	type MeetingNotesFailureClass,
	type MeetingRecord,
	planMeetingNotesActions,
	resolveLinearLabel,
} from "../packages/teamlead/dist/meeting-notes-scheduler.js";
import { resolveLeadMenus } from "../packages/teamlead/dist/workflow-menu.js";

const REPO_ROOT = resolve(process.env.FLYWHEEL_DIR ?? process.cwd());
const CONFIG_PATH = resolve(
	process.env.FLYWHEEL_MEETING_NOTES_CONFIG ??
		join(REPO_ROOT, ".flywheel", "meeting-notes.yaml"),
);
const BRIDGE_URL = (
	process.env.FLYWHEEL_BRIDGE_URL ??
	process.env.BRIDGE_URL ??
	"http://localhost:9876"
).replace(/\/+$/, "");
const FOUNDER_TIMEZONE = resolveFounderTimezone();
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_IN_TEXT_RE =
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const ALERTED_FAILURE_EXIT = 2;
let deliveredAlert = false;
let alertDeliveryFailed = false;

function log(message: string): void {
	console.log(`[meeting-notes ${new Date().toISOString()}] ${message}`);
}

function sanitizeDetail(value: unknown): string {
	return (value instanceof Error ? value.message : String(value))
		.replace(/\p{Cc}+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 800);
}

function founderDay(now = new Date()): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: FOUNDER_TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const value = (type: string) =>
		parts.find((part) => part.type === type)?.value;
	return `${value("year")}${value("month")}${value("day")}`;
}

function deliverAlert(input: {
	subject: string;
	failureClass: MeetingNotesFailureClass;
	detail: string;
}): void {
	const script = join(REPO_ROOT, "scripts", "lead-alert.sh");
	const signature = `${input.subject}:${input.failureClass}:${founderDay()}`;
	const result = spawnSync(
		"bash",
		[
			script,
			"--lead",
			"claude-infra-bot-lead",
			"--project",
			"flywheel",
			"--kind",
			"meeting_notes_failed",
			"--severity",
			"warning",
			"--title",
			"会议留痕管线故障",
			"--body",
			`subject=${input.subject} failureClass=${input.failureClass} detail=${sanitizeDetail(input.detail)}`,
			"--signature",
			signature,
			"--strict-delivery",
		],
		{ encoding: "utf8", env: process.env },
	);
	const receipt = result.stdout.trim();
	if (receipt !== "sent" && receipt !== "queued_transient") {
		alertDeliveryFailed = true;
		throw new Error(
			`meeting-notes alert delivery unproven: rc=${result.status ?? "signal"} receipt=${receipt || "empty"} stderr=${sanitizeDetail(result.stderr)}`,
		);
	}
	deliveredAlert = true;
}

function markFailureExit(): void {
	process.exitCode =
		deliveredAlert && !alertDeliveryFailed ? ALERTED_FAILURE_EXIT : 1;
}

type RawResponse = { data?: Record<string, unknown> };

async function rawPage<T>(
	client: LinearClient,
	query: string,
	variables: Record<string, unknown>,
	field: string,
): Promise<LinearPage<T>> {
	const response = (await client.client.rawRequest(
		query,
		variables,
	)) as RawResponse;
	const connection = response.data?.[field] as
		| {
				nodes?: T[];
				pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
		  }
		| undefined;
	if (
		!connection ||
		!Array.isArray(connection.nodes) ||
		typeof connection.pageInfo?.hasNextPage !== "boolean"
	) {
		throw new Error(`Linear ${field} page is unreadable`);
	}
	return {
		nodes: connection.nodes,
		pageInfo: {
			hasNextPage: connection.pageInfo.hasNextPage,
			endCursor: connection.pageInfo.endCursor ?? null,
		},
	};
}

interface RoutingContext {
	teamId: string;
	projectId: string;
	meetingLabelId: string;
	departmentLabelId: string;
	canceledStateId: string;
}

function exactlyOne<T>(values: T[], label: string): T {
	if (values.length !== 1) {
		throw new Error(`${label} must resolve uniquely; found ${values.length}`);
	}
	return values[0]!;
}

async function routingPreflight(
	linear: LinearClient,
	config: MeetingNotesConfig,
	options: { allowMeetingLabelCreate: boolean },
): Promise<RoutingContext> {
	const menus = resolveLeadMenus({
		projectRoot: REPO_ROOT,
		leadId: config.dispatch.leadId,
	});
	const prd = menus.filter(
		(menu) => menu.shape === config.dispatch.taskCategory,
	);
	const selected = exactlyOne(prd, "prd menu adoption");
	if (selected.founderReview !== true) {
		throw new Error("prd menu must retain founderReview=true");
	}

	const teams = await collectLinearPages((after) =>
		rawPage<{ id: string; key: string }>(
			linear,
			`query Teams($after:String){teams(first:100,after:$after){nodes{id key} pageInfo{hasNextPage endCursor}}}`,
			{ after },
			"teams",
		),
	);
	const team = exactlyOne(
		teams.filter((candidate) => candidate.key === config.linear.team),
		`Linear team ${config.linear.team}`,
	);
	const projects = await collectLinearPages((after) =>
		rawPage<{ id: string; name: string }>(
			linear,
			`query Projects($after:String,$name:String!,$teamId:ID!){projects(first:100,after:$after,filter:{name:{eq:$name},accessibleTeams:{some:{id:{eq:$teamId}}}}){nodes{id name} pageInfo{hasNextPage endCursor}}}`,
			{ after, name: config.linear.project, teamId: team.id },
			"projects",
		),
	);
	const project = exactlyOne(
		projects,
		`Linear project ${config.linear.project}`,
	);
	const labels = await collectLinearPages((after) =>
		rawPage<{ id: string; name: string; description?: string | null }>(
			linear,
			`query Labels($after:String,$teamId:ID!){issueLabels(first:100,after:$after,filter:{team:{id:{eq:$teamId}}}){nodes{id name description} pageInfo{hasNextPage endCursor}}}`,
			{ after, teamId: team.id },
			"issueLabels",
		),
	);
	const departmentLabel = await resolveLinearLabel({
		labels,
		name: config.linear.departmentLabel,
	});
	const meetingLabel = await resolveLinearLabel({
		labels,
		name: config.linear.meetingLabel,
		canonicalDescription: MEETING_LABEL_DESCRIPTION,
		...(options.allowMeetingLabelCreate
			? {
					create: async () => {
						const payload = await linear.createIssueLabel({
							teamId: team.id,
							name: config.linear.meetingLabel,
							color: "#5E6AD2",
							description: MEETING_LABEL_DESCRIPTION,
						});
						const created = await payload.issueLabel;
						if (!payload.success || !created?.id) {
							throw new Error(
								`Linear label ${config.linear.meetingLabel} creation failed`,
							);
						}
						return {
							id: created.id,
							name: created.name,
							description: created.description,
						};
					},
				}
			: {}),
	});
	const states = await collectLinearPages((after) =>
		rawPage<{ id: string; name: string; type: string }>(
			linear,
			`query States($after:String,$teamId:ID!){workflowStates(first:100,after:$after,filter:{team:{id:{eq:$teamId}}}){nodes{id name type} pageInfo{hasNextPage endCursor}}}`,
			{ after, teamId: team.id },
			"workflowStates",
		),
	);
	const canceledState = exactlyOne(
		states.filter(
			(state) =>
				state.type.toLowerCase() === "canceled" ||
				state.name.toLowerCase() === "canceled" ||
				state.name.toLowerCase() === "cancelled",
		),
		"Linear Canceled workflow state",
	);
	return {
		teamId: team.id,
		projectId: project.id,
		meetingLabelId: meetingLabel.id,
		departmentLabelId: departmentLabel.id,
		canceledStateId: canceledState.id,
	};
}

function scanMeetings(config: MeetingNotesConfig): {
	meetings: MeetingRecord[];
	archivedMeetingIds: ReadonlySet<string>;
	errors: Array<{ subject: string; detail: string }>;
} {
	const byId = new Map<string, MeetingRecord>();
	const archivedMeetingIds = new Set<string>();
	const errors: Array<{ subject: string; detail: string }> = [];
	try {
		const current = loadTrustedCurrentMeeting(config);
		if (current) byId.set(current.id, current);
	} catch (error) {
		errors.push({ subject: "preflight", detail: sanitizeDetail(error) });
	}
	const root = canonicalizeMeetingStateDir(config);
	const archives = join(root, "meetings");
	if (!existsSync(archives)) {
		return { meetings: [...byId.values()], archivedMeetingIds, errors };
	}
	const archiveRoot = lstatSync(archives);
	if (archiveRoot.isSymbolicLink() || !archiveRoot.isDirectory()) {
		errors.push({
			subject: "preflight",
			detail: "meeting archives root is not a regular directory",
		});
		return { meetings: [...byId.values()], archivedMeetingIds, errors };
	}
	for (const entry of readdirSync(archives, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory() || !UUID_RE.test(entry.name)) {
			errors.push({
				subject: "preflight",
				detail: `unexpected meeting archive entry: ${entry.name}`,
			});
			continue;
		}
		try {
			const archived = loadTrustedMeetingArchive(config, entry.name);
			byId.set(archived.id, archived);
			archivedMeetingIds.add(archived.id);
		} catch (error) {
			errors.push({ subject: entry.name, detail: sanitizeDetail(error) });
		}
	}
	return { meetings: [...byId.values()], archivedMeetingIds, errors };
}

interface RawCommentConnection {
	nodes?: Array<{ body: string }>;
	pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

function parseCommentPage(
	connection: RawCommentConnection | undefined,
	issueId: string,
): LinearPage<string> {
	if (
		!connection ||
		!Array.isArray(connection.nodes) ||
		connection.nodes.some((node) => typeof node.body !== "string") ||
		typeof connection.pageInfo?.hasNextPage !== "boolean"
	) {
		throw new Error(`Linear comments page is unreadable for ${issueId}`);
	}
	return {
		nodes: connection.nodes.map((node) => node.body),
		pageInfo: {
			hasNextPage: connection.pageInfo.hasNextPage,
			endCursor: connection.pageInfo.endCursor ?? null,
		},
	};
}

async function issueComments(
	linear: LinearClient,
	issueId: string,
	initialPage: LinearPage<string>,
): Promise<string[]> {
	const comments: string[] = [];
	const cursors = new Set<string>();
	let page = initialPage;
	for (;;) {
		comments.push(...page.nodes);
		if (!page.pageInfo.hasNextPage) return comments;
		const after = page.pageInfo.endCursor;
		if (!after || cursors.has(after)) {
			throw new Error(
				`Linear comments cursor is missing or repeated for ${issueId}`,
			);
		}
		cursors.add(after);
		const response = (await linear.client.rawRequest(
			`query Comments($issueId:String!,$after:String){issue(id:$issueId){comments(first:100,after:$after){nodes{body} pageInfo{hasNextPage endCursor}}}}`,
			{ issueId, after },
		)) as RawResponse;
		const issue = response.data?.issue as
			| { comments?: RawCommentConnection }
			| undefined;
		page = parseCommentPage(issue?.comments, issueId);
	}
}

async function loadMeetingIssues(
	linear: LinearClient,
	routing: RoutingContext,
): Promise<MeetingIssueObservation[]> {
	const nodes = await collectLinearPages((after) =>
		rawPage<{
			id: string;
			identifier: string;
			description: string | null;
			state: { name: string; type: string };
			comments?: RawCommentConnection;
		}>(
			linear,
			`query MeetingIssues($after:String,$teamId:ID!,$labelId:ID!){issues(first:100,after:$after,filter:{team:{id:{eq:$teamId}},labels:{id:{eq:$labelId}}}){nodes{id identifier description state{name type} comments(first:100){nodes{body} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}`,
			{ after, teamId: routing.teamId, labelId: routing.meetingLabelId },
			"issues",
		),
	);
	const observations: MeetingIssueObservation[] = [];
	for (const node of nodes) {
		const comments = await issueComments(
			linear,
			node.id,
			parseCommentPage(node.comments, node.id),
		);
		observations.push({
			id: node.id,
			identifier: node.identifier,
			description: node.description ?? "",
			stateName: node.state.name,
			stateType: node.state.type,
			comments,
		});
	}
	return observations;
}

function localScheduledAt(iso: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: FOUNDER_TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(iso));
}

async function main(): Promise<void> {
	const linearApiKey = process.env.LINEAR_API_KEY?.trim();
	const bridgeToken = process.env.TEAMLEAD_API_TOKEN?.trim();
	if (!linearApiKey || !bridgeToken) {
		const detail = "LINEAR_API_KEY and TEAMLEAD_API_TOKEN are required";
		deliverAlert({ subject: "preflight", failureClass: "config", detail });
		throw new Error(detail);
	}
	let config: MeetingNotesConfig;
	try {
		config = loadMeetingNotesConfig(CONFIG_PATH);
		if (config.tickIntervalSeconds !== 120) {
			throw new Error(
				"tickIntervalSeconds must match the versioned launchd StartInterval (120)",
			);
		}
		canonicalizeMeetingStateDir(config);
	} catch (error) {
		const detail = sanitizeDetail(error);
		deliverAlert({ subject: "preflight", failureClass: "config", detail });
		throw error;
	}
	const scan = scanMeetings(config);
	let failed = false;
	for (const error of scan.errors) {
		failed = true;
		deliverAlert({
			subject: error.subject,
			failureClass: "schema",
			detail: error.detail,
		});
	}
	const linear = new LinearClient({ apiKey: linearApiKey });
	let routing: RoutingContext;
	try {
		routing = await routingPreflight(linear, config, {
			allowMeetingLabelCreate: canBootstrapMeetingLabel({
				meetingCount: scan.meetings.length,
				archivedMeetingCount: scan.archivedMeetingIds.size,
				scanErrorCount: scan.errors.length,
			}),
		});
	} catch (error) {
		const detail = sanitizeDetail(error);
		deliverAlert({ subject: "preflight", failureClass: "config", detail });
		throw error;
	}
	if (scan.meetings.length === 0) {
		log("no meetings found");
		if (failed) markFailureExit();
		return;
	}

	let issueIndex: ReturnType<typeof indexMeetingIssues>;
	try {
		issueIndex = indexMeetingIssues(await loadMeetingIssues(linear, routing));
	} catch (error) {
		const detail = sanitizeDetail(error);
		const meetingId = detail.match(UUID_IN_TEXT_RE)?.[0];
		deliverAlert({
			subject: meetingId ?? "linear-index",
			failureClass: meetingId ? "identity" : "linear",
			detail,
		});
		throw error;
	}
	for (const meeting of findUnarchivedTerminalMeetings(
		scan.meetings,
		issueIndex,
		{ archivedMeetingIds: scan.archivedMeetingIds },
	)) {
		failed = true;
		deliverAlert({
			subject: meeting.id,
			failureClass: "schema",
			detail: `terminal meeting snapshot has no immutable archive: ${meeting.id}`,
		});
	}

	const actions = planMeetingNotesActions(scan.meetings, issueIndex, {
		archivedMeetingIds: scan.archivedMeetingIds,
	});
	const report = await executeMeetingNotesActions(actions, {
		createIssue: async (meeting) => {
			const titleTopic = meeting.topic
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 160);
			const payload = await linear.createIssue({
				teamId: routing.teamId,
				projectId: routing.projectId,
				labelIds: [routing.meetingLabelId, routing.departmentLabelId],
				title: `[meeting] ${localScheduledAt(meeting.scheduledAt)} ${meeting.leadId} × Annie · ${titleTopic}`,
				description: buildMeetingIssueDescription(meeting),
			});
			const created = await payload.issue;
			if (!created?.id) throw new Error("Linear createIssue returned no issue");
			log(`created ${created.identifier} for meeting ${meeting.id}`);
		},
		startRun: async ({ issueId, idempotencyKey }) => {
			const response = await fetch(`${BRIDGE_URL}/api/runs/start`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Authorization: `Bearer ${bridgeToken}`,
				},
				body: JSON.stringify({
					issueId,
					projectName: "flywheel",
					leadId: config.dispatch.leadId,
					taskCategory: config.dispatch.taskCategory,
					idempotencyKey,
				}),
			});
			let body: { code?: string } = {};
			try {
				body = (await response.json()) as { code?: string };
			} catch {
				// Status still determines whether this response can settle.
			}
			return {
				status: response.status,
				...(body.code ? { code: body.code } : {}),
			};
		},
		addComment: async (issueId, body) => {
			const payload = await linear.createComment({ issueId, body });
			const comment = await payload.comment;
			if (!comment?.id)
				throw new Error("Linear createComment returned no comment");
		},
		cancelIssue: async (issueId) => {
			const payload = await linear.updateIssue(issueId, {
				stateId: routing.canceledStateId,
			});
			const updated = await payload.issue;
			if (!updated?.id) throw new Error("Linear updateIssue returned no issue");
		},
	});
	for (const error of report.errors) {
		failed = true;
		deliverAlert({
			subject: error.meetingId,
			failureClass: error.failureClass,
			detail: error.detail,
		});
	}
	log(
		`done meetings=${scan.meetings.length} actions=${actions.length} completed=${report.completed.length} pending=${report.pending.length} errors=${report.errors.length}`,
	);
	if (failed) markFailureExit();
}

main().catch((error) => {
	console.error(`[meeting-notes] fatal: ${sanitizeDetail(error)}`);
	markFailureExit();
});
