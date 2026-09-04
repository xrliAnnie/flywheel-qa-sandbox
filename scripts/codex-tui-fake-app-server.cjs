#!/usr/bin/env node
// FLY-2296: unix-socket-only fake Codex app-server for the real-TUI nudge probe.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const [socketPath, logPath, cwd, threadId] = process.argv.slice(2);
if (![socketPath, logPath, cwd, threadId].every((value) => value)) {
	process.stderr.write(
		"usage: codex-tui-fake-app-server.cjs <socket> <log> <cwd> <thread-id>\n",
	);
	process.exit(2);
}

const repoRoot = path.resolve(__dirname, "..");
const wsPath = require.resolve("ws", {
	paths: [path.join(repoRoot, "packages", "claude-runner")],
});
const { WebSocketServer } = require(wsPath);

const now = Math.floor(Date.now() / 1000);
const thread = {
	id: threadId,
	sessionId: threadId,
	cliVersion: "0.153.0",
	createdAt: now,
	updatedAt: now,
	cwd,
	ephemeral: false,
	modelProvider: "openai",
	model: "gpt-5.6-sol",
	preview: "",
	projectId: "fly2296-probe",
	source: "cli",
	status: { type: "idle" },
	turns: [],
};

const rateLimits = {
	rateLimits: {
		limitId: "codex",
		limitName: "Codex",
		planType: "pro",
		primary: {
			usedPercent: 95,
			windowDurationMins: 300,
			resetsAt: now + 3600,
		},
		secondary: {
			usedPercent: 40,
			windowDurationMins: 10080,
			resetsAt: now + 86_400,
		},
		rateLimitReachedType: null,
		credits: null,
		spendControlReached: false,
	},
	ordinaryUsageAllowed: true,
	rateLimitsByLimitId: null,
	accountId: "acct-fly2296-probe",
	rateLimitResetCredits: null,
};

const models = {
	data: [
		{
			id: "gpt-5.6-sol",
			model: "gpt-5.6-sol",
			displayName: "gpt-5.6-sol",
			description: "FLY-2296 probe",
			hidden: false,
			isDefault: true,
			defaultReasoningEffort: "medium",
			supportedReasoningEfforts: [
				{ reasoningEffort: "medium", description: "medium" },
			],
		},
		{
			id: "gpt-5.6-luna",
			model: "gpt-5.6-luna",
			displayName: "gpt-5.6-luna",
			description: "FLY-2296 lower-credit control",
			hidden: false,
			isDefault: false,
			defaultReasoningEffort: "medium",
			supportedReasoningEfforts: [
				{ reasoningEffort: "medium", description: "medium" },
			],
		},
	],
	nextCursor: null,
};

function resultFor(method) {
	switch (method) {
		case "config/read":
			return {
				config: {
					model: "gpt-5.6-sol",
					projects: { [cwd]: { trust_level: "trusted" } },
				},
				origins: {},
				layers: null,
			};
		case "account/read":
			return {
				account: {
					type: "chatgpt",
					email: "probe@example.test",
					planType: "pro",
				},
				requiresOpenaiAuth: true,
			};
		case "thread/read":
			return { thread };
		case "thread/resume":
			return {
				approvalPolicy: "never",
				approvalsReviewer: "user",
				cwd,
				model: "gpt-5.6-sol",
				modelProvider: "openai",
				reasoningEffort: "medium",
				sandbox: {
					type: "workspaceWrite",
					writableRoots: [],
					networkAccess: false,
					excludeSlashTmp: false,
					excludeTmpdirEnvVar: false,
				},
				serviceTier: null,
				turnsBackwardsCursor: null,
				itemsBackwardsCursor: null,
				instructionSources: [],
				thread,
			};
		case "model/list":
			return models;
		case "skills/list":
			return { data: [] };
		case "account/rateLimits/read":
			return rateLimits;
		default:
			return {};
	}
}

function log(message) {
	fs.appendFileSync(
		logPath,
		`${new Date().toISOString().slice(11, 23)} ${message}\n`,
	);
}

function sendTurnCompleted(ws) {
	const turn = {
		id: "turn-fly2296-probe",
		items: [],
		status: "inProgress",
		startedAt: now,
	};
	for (const notification of [
		{ method: "turn/started", params: { threadId, turn } },
		{
			method: "turn/completed",
			params: {
				threadId,
				turn: {
					...turn,
					status: "completed",
					completedAt: now + 1,
					durationMs: 1000,
					error: null,
				},
			},
		},
	]) {
		const wire = JSON.stringify(notification);
		ws.send(wire);
		log(`SENT ${wire}`);
	}
}

const server = http.createServer();
const webSockets = new WebSocketServer({ server });

webSockets.on("connection", (ws, request) => {
	log(
		`CONNECT url=${request.url ?? ""} auth=${request.headers.authorization ? "yes" : "no"}`,
	);
	let sentCompletion = false;
	ws.on("message", (buffer) => {
		let message;
		try {
			message = JSON.parse(buffer.toString());
		} catch {
			log("RAW invalid-json");
			return;
		}
		if (message.method && message.id !== undefined) {
			log(`REQ id=${message.id} ${message.method}`);
			ws.send(
				JSON.stringify({ id: message.id, result: resultFor(message.method) }),
			);
			if (message.method === "account/rateLimits/read" && !sentCompletion) {
				sentCompletion = true;
				sendTurnCompleted(ws);
			}
		} else if (message.method) {
			log(`NOTIFY ${message.method}`);
		} else {
			log("RESP");
		}
	});
	ws.on("close", () => log("CLOSE"));
});

function shutdown() {
	webSockets.close();
	server.close(() => {
		try {
			fs.unlinkSync(socketPath);
		} catch (error) {
			if (error.code !== "ENOENT") {
				process.stderr.write(
					`fake app-server: could not unlink ${socketPath}: ${error.message}\n`,
				);
				process.exit(2);
			}
		}
		process.exit(0);
	});
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("error", (error) => {
	process.stderr.write(`fake app-server: ${error.message}\n`);
	process.exit(2);
});
server.listen(socketPath, () => log(`LISTEN ${socketPath}`));
