// FLY-997 thin agent loop on @google/genai — the spike's own-loop skeleton
// (plan §3.2). Manual function dispatch only; the tool registry is a WHITELIST
// (unknown tool name → explicit error fed back, never hangs — voice-core
// GeminiLiveBackend same discipline). Audit line written BEFORE every dispatch
// (FLY-245 audit-first discipline).
//
// API surface: primary = Interactions API (current recommended surface;
// SDK marks it experimental — recorded in evidence). On this surface function
// execution is manual BY CONSTRUCTION: calls come back as content items and
// the loop must send FunctionResultContent to continue. There is no
// automatic-function-calling path to disable (that concept lives in the
// generateContent/live surfaces). Fallback = generateContent with
// automaticFunctionCalling disabled explicitly.

import { validateArgs } from "./tools.mjs";

export class QuotaError extends Error {
	constructor(msg) {
		super(msg);
		this.name = "QuotaError";
	}
}

function isQuota(err) {
	const s = String(err?.message ?? err);
	return /429|RESOURCE_EXHAUSTED|rate limit|quota/i.test(s);
}
function isTransient(err) {
	const s = String(err?.message ?? err);
	return /\b(500|502|503)\b|INTERNAL|UNAVAILABLE|overloaded|fetch failed/i.test(
		s,
	);
}

async function callModel(fn) {
	try {
		return await fn();
	} catch (err) {
		if (isQuota(err)) throw new QuotaError(String(err?.message ?? err));
		if (isTransient(err)) {
			// single retry on transient 5xx — NOT a retry loop (plan §4)
			await new Promise((r) => setTimeout(r, 2500));
			try {
				return await fn();
			} catch (err2) {
				if (isQuota(err2)) throw new QuotaError(String(err2?.message ?? err2));
				throw err2;
			}
		}
		throw err;
	}
}

// --- surface adapters --------------------------------------------------------
// Both adapters expose: start(userMessage) / continueWith(functionResults)
// → { functionCalls: [{id, name, args}], text, usage:{input, output} }

function interactionsAdapter(ai, model, systemInstruction, registry) {
	const tools = Object.values(registry).map((t) => ({
		type: "function",
		name: t.declaration.name,
		description: t.declaration.description,
		parameters: t.declaration.parameters,
	}));
	let lastId = null;

	function parse(interaction) {
		// SDK 2.x / May-2026 schema: responses carry `steps[]`
		// (function_call / thought / model_output{content:[{type:'text',text}]}).
		const steps = interaction.steps ?? [];
		const functionCalls = steps
			.filter((o) => o.type === "function_call")
			.map((o) => ({ id: o.id, name: o.name, args: o.arguments ?? {} }));
		const text = steps
			.flatMap((o) => {
				if (o.type === "text") return [o.text ?? ""];
				if (o.type === "model_output")
					return (o.content ?? [])
						.filter((c) => c.type === "text")
						.map((c) => c.text ?? "");
				return [];
			})
			.join("");
		const usage = {
			input: interaction.usage?.total_input_tokens ?? 0,
			output: interaction.usage?.total_output_tokens ?? 0,
		};
		return { functionCalls, text, usage, status: interaction.status };
	}

	return {
		surface: "interactions",
		async start(userMessage) {
			const interaction = await callModel(() =>
				ai.interactions.create({
					model,
					input: userMessage,
					system_instruction: systemInstruction,
					tools,
					store: true,
					stream: false,
				}),
			);
			lastId = interaction.id;
			return parse(interaction);
		},
		async continueWith(functionResults) {
			const input = functionResults.map((r) => ({
				type: "function_result",
				call_id: r.id,
				name: r.name,
				result: r.result,
				...(r.isError && { is_error: true }),
			}));
			const interaction = await callModel(() =>
				ai.interactions.create({
					model,
					input,
					previous_interaction_id: lastId,
					system_instruction: systemInstruction,
					tools,
					store: true,
					stream: false,
				}),
			);
			lastId = interaction.id;
			return parse(interaction);
		},
	};
}

function generateContentAdapter(ai, model, systemInstruction, registry) {
	const tools = [
		{
			functionDeclarations: Object.values(registry).map((t) => t.declaration),
		},
	];
	const contents = [];
	let callCounter = 0;

	function parse(res) {
		const cand = res.candidates?.[0];
		if (cand?.content) contents.push(cand.content);
		const functionCalls = (res.functionCalls ?? []).map((fc) => ({
			id: fc.id ?? `call-${++callCounter}`,
			name: fc.name,
			args: fc.args ?? {},
		}));
		const usage = {
			input: res.usageMetadata?.promptTokenCount ?? 0,
			output: res.usageMetadata?.candidatesTokenCount ?? 0,
		};
		return { functionCalls, text: res.text ?? "", usage };
	}

	async function send() {
		const res = await callModel(() =>
			ai.models.generateContent({
				model,
				contents,
				config: {
					systemInstruction,
					tools,
					// explicit: this loop is manual-dispatch; never let the SDK auto-execute
					automaticFunctionCalling: { disable: true },
				},
			}),
		);
		return parse(res);
	}

	return {
		surface: "generateContent",
		async start(userMessage) {
			contents.push({ role: "user", parts: [{ text: userMessage }] });
			return send();
		},
		async continueWith(functionResults) {
			contents.push({
				role: "user",
				parts: functionResults.map((r) => ({
					functionResponse: {
						id: r.id,
						name: r.name,
						response: { result: r.result },
					},
				})),
			});
			return send();
		},
	};
}

// --- the loop ----------------------------------------------------------------

export async function runAgent({
	ai,
	model,
	surface = "interactions",
	systemInstruction,
	userMessage,
	registry,
	maxSteps = 12,
	audit = () => {},
}) {
	const adapter =
		surface === "interactions"
			? interactionsAdapter(ai, model, systemInstruction, registry)
			: generateContentAdapter(ai, model, systemInstruction, registry);

	const result = {
		surface: adapter.surface,
		model,
		finalText: "",
		steps: 0,
		maxStepsExceeded: false,
		toolCalls: [],
		usage: { input: 0, output: 0 },
	};

	let turn = await adapter.start(userMessage);
	result.usage.input += turn.usage.input;
	result.usage.output += turn.usage.output;

	while (true) {
		if (!turn.functionCalls.length) {
			result.finalText = turn.text;
			break;
		}
		result.steps += 1;
		if (result.steps > maxSteps) {
			result.maxStepsExceeded = true;
			result.finalText = turn.text;
			break;
		}

		const functionResults = [];
		for (const fc of turn.functionCalls) {
			const record = {
				step: result.steps,
				name: fc.name,
				args: fc.args,
				hallucinated: false,
				validationErrors: [],
				httpStatus: null,
			};
			// audit BEFORE dispatch (FLY-245 discipline)
			audit({
				ts: new Date().toISOString(),
				model,
				surface: adapter.surface,
				tool: fc.name,
				args: fc.args,
				decision: "dispatch",
			});

			const tool = registry[fc.name];
			if (!tool) {
				// whitelist red line: unknown tool → explicit error back, never executed
				record.hallucinated = true;
				functionResults.push({
					id: fc.id,
					name: fc.name,
					result: {
						error: `unknown tool: ${fc.name}. Available tools: ${Object.keys(registry).join(", ")}`,
					},
					isError: true,
				});
				result.toolCalls.push(record);
				continue;
			}
			const errors = validateArgs(tool.declaration.parameters, fc.args);
			if (errors.length) {
				record.validationErrors = errors;
				functionResults.push({
					id: fc.id,
					name: fc.name,
					result: { error: `invalid arguments: ${errors.join("; ")}` },
					isError: true,
				});
				result.toolCalls.push(record);
				continue;
			}
			const out = await tool.handler(fc.args);
			record.httpStatus = out.httpStatus;
			result.toolCalls.push(record);
			functionResults.push({
				id: fc.id,
				name: fc.name,
				result: out,
				isError: out.httpStatus >= 400,
			});
		}

		turn = await adapter.continueWith(functionResults);
		result.usage.input += turn.usage.input;
		result.usage.output += turn.usage.output;
	}

	return result;
}
