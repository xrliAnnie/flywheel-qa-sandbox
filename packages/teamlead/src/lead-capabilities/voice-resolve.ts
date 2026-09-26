import type { LeadBackendId } from "../lead-backends/lead-backend.js";
import type {
	ProjectEntry,
	VoiceBackgroundBrowserMode,
} from "../ProjectConfig.js";
import { effectiveVoiceBackground } from "../ProjectConfig.js";
import { LEAD_CAPABILITY_CATALOG } from "./catalog.js";

const SESSION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BROWSER_MODES = new Set<VoiceBackgroundBrowserMode>([
	"founder_chrome",
	"isolated",
	"off",
]);

export function resolveVoiceBackgroundCapabilities(input: {
	project: ProjectEntry;
	leadId: string;
	sessionId: string;
	browserMode: VoiceBackgroundBrowserMode;
}) {
	const matches = input.project.leads.filter(
		(lead) => lead.agentId === input.leadId,
	);
	const lead = matches[0];
	if (
		!input.project.projectName ||
		!input.project.projectRoot ||
		matches.length !== 1 ||
		!lead ||
		!SESSION_ID.test(input.sessionId) ||
		!BROWSER_MODES.has(input.browserMode)
	)
		throw new Error("voice_capability_scope_denied");
	const background = effectiveVoiceBackground(lead);
	if (!background.enabled || background.browser !== input.browserMode)
		throw new Error("voice_capability_scope_denied");
	const browserEnabled = input.browserMode !== "off";
	const operations = LEAD_CAPABILITY_CATALOG.filter(
		(operation) =>
			operation.classification !== "reserved" &&
			(browserEnabled || !operation.operationId.startsWith("browser.")),
	);
	return Object.freeze({
		identity: Object.freeze({
			projectName: input.project.projectName,
			leadId: lead.agentId,
			backend: (lead.backend ?? "claude-code") as LeadBackendId,
			activationId: `voice:${input.sessionId}`,
			actor: "voice" as const,
		}),
		browserMode: input.browserMode,
		operations,
		deniedOperations: LEAD_CAPABILITY_CATALOG.filter(
			(operation) => operation.classification === "reserved",
		),
	});
}
