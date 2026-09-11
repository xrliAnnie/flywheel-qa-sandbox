import {
	isWorkflowReworkNodeReuseContext,
	renderWorkflowReworkContextLine,
} from "./workflow-rework-context.js";

function renderLeadAttribution(context: unknown): string | undefined {
	if (!context || typeof context !== "object" || Array.isArray(context)) {
		return undefined;
	}
	const outer = context as {
		authority?: unknown;
		authorityContext?: unknown;
	};
	if (
		outer.authority !== "lead" ||
		!outer.authorityContext ||
		typeof outer.authorityContext !== "object" ||
		Array.isArray(outer.authorityContext)
	) {
		return undefined;
	}
	const attribution = outer.authorityContext as {
		authority?: unknown;
		actor?: unknown;
		lead_feedback?: unknown;
		founder_quote?: unknown;
	};
	if (
		attribution.authority !== "lead" ||
		typeof attribution.actor !== "string" ||
		!attribution.actor.trim() ||
		typeof attribution.lead_feedback !== "string" ||
		!attribution.lead_feedback.trim()
	) {
		return "Lead rework attribution is invalid.";
	}
	let quote: string;
	if (attribution.founder_quote === null) {
		quote = "Founder quote: none (Lead submitted independently)";
	} else if (
		attribution.founder_quote &&
		typeof attribution.founder_quote === "object" &&
		!Array.isArray(attribution.founder_quote) &&
		typeof (attribution.founder_quote as { message_id?: unknown })
			.message_id === "string" &&
		typeof (attribution.founder_quote as { text?: unknown }).text === "string"
	) {
		const founderQuote = attribution.founder_quote as {
			message_id: string;
			text: string;
		};
		quote = `Founder quote (message ${founderQuote.message_id}): ${founderQuote.text || "[empty text]"}`;
	} else {
		return "Lead rework attribution is invalid.";
	}
	return `Rework submitted by lead:${attribution.actor.trim()}. Lead feedback: ${attribution.lead_feedback}\n${quote}`;
}

export function renderWorkflowReworkWakeContent(input: {
	wakeId: string;
	activationId: string;
	epoch: number;
	executionId: string;
	context: unknown;
}): string {
	const nodeReuse = isWorkflowReworkNodeReuseContext(input.context);
	const activation = nodeReuse
		? "New verification round"
		: "Workflow rework activation";
	const leadAttribution = renderLeadAttribution(input.context);
	return `[phase-wake ${input.wakeId}] ${activation} ${input.activationId} is ready at TURN epoch ${input.epoch}. FIRST run flywheel-comm turn --exec-id ${input.executionId}; proceed only if it answers yours. ${leadAttribution ? `${leadAttribution} ` : ""}${renderWorkflowReworkContextLine(input.context)}`;
}
