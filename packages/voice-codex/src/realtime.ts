interface JsonRpcResponse {
	result?: unknown;
	error?: { code: number; message: string };
}

export interface RealtimeProcess {
	start(): Promise<void>;
	startThreadWithResult(
		params: Record<string, unknown>,
	): Promise<{ id: string; result: unknown }>;
	request(method: string, params?: unknown): Promise<JsonRpcResponse>;
	notify(method: string, params?: unknown): void;
	on(
		event: "notification",
		callback: (method: string, params: unknown) => void,
	): void;
	stop(): Promise<void>;
}

interface RealtimeFrontendOptions {
	process: RealtimeProcess;
	cwd: string;
	voice: string;
	displayName: string;
	onTranscript(input: { role: "user" | "assistant"; text: string }): void;
	onAudio(pcm24Mono: Buffer): void;
	onClosed(reason: string): void;
	onFrontendDelegation(input: { itemId: string }): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function buildFrontendPrompt(displayName: string): string {
	return [
		`你是 ${displayName} 的语音前台,不是 Lead 本人。`,
		"你只负责准确听写用户语音,不要替用户改写。",
		"只有标记为 [BACKEND] 的文字才需要逐字朗读。",
		"用户一句话结束时只回应一个字,或保持安静。",
		"不要回答问题,不要推理,不要调用工具,不要声称已经执行任何操作,不要主动发言。",
	].join("\n");
}

export class RealtimeFrontend {
	private threadId?: string;
	private stopped = false;
	private readonly delegationItems = new Set<string>();

	constructor(private readonly options: RealtimeFrontendOptions) {}

	async start(): Promise<void> {
		this.assertRunning();
		this.options.process.on("notification", (method, params) =>
			this.notification(method, params),
		);
		await this.options.process.start();
		this.assertRunning();
		const prompt = buildFrontendPrompt(this.options.displayName);
		if (Math.ceil(Array.from(prompt).length / 2) > 8_192) {
			throw new Error("frontend_prompt_too_large");
		}
		const started = await this.options.process.startThreadWithResult({
			cwd: this.options.cwd,
			sandbox: "read-only",
			approvalPolicy: "never",
			baseInstructions: prompt,
			config: { sandbox_workspace_write: { network_access: false } },
		});
		this.assertRunning();
		const result = record(started.result);
		const thread = record(result?.thread);
		const sandbox = result?.sandbox ?? thread?.sandbox;
		const sandboxType = record(sandbox)?.type;
		if (
			(result?.cwd ?? thread?.cwd) !== this.options.cwd ||
			(sandbox !== "read-only" && sandboxType !== "readOnly") ||
			(result?.approvalPolicy ?? thread?.approvalPolicy) !== "never"
		) {
			throw new Error("thread_receipt_drift");
		}
		this.threadId = started.id;
		const response = await this.options.process.request(
			"thread/realtime/start",
			{
				threadId: started.id,
				transport: { type: "websocket" },
				version: "v2",
				outputModality: "audio",
				voice: this.options.voice,
				prompt,
				clientManagedHandoffs: true,
				includeStartupContext: false,
				delegationAckFiller: false,
			},
		);
		this.assertRunning();
		if (response.error)
			throw new Error(`realtime_start:${response.error.message}`);
	}

	appendAudio(pcm24Mono: Buffer): void {
		if (!this.threadId || pcm24Mono.length === 0 || pcm24Mono.length % 2 !== 0)
			return;
		this.options.process.notify("thread/realtime/appendAudio", {
			threadId: this.threadId,
			audio: {
				data: pcm24Mono.toString("base64"),
				sampleRate: 24_000,
				numChannels: 1,
				samplesPerChannel: pcm24Mono.length / 2,
			},
		});
	}

	async appendSpeech(text: string): Promise<void> {
		if (!this.threadId) throw new Error("realtime_not_started");
		const response = await this.options.process.request(
			"thread/realtime/appendSpeech",
			{ threadId: this.threadId, text },
		);
		if (response.error)
			throw new Error(`append_speech:${response.error.message}`);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.threadId) {
			// Send stop before closing stdin, but never let its receipt delay fencing.
			void this.options.process
				.request("thread/realtime/stop", { threadId: this.threadId })
				.catch(() => undefined);
		}
		await this.options.process.stop();
		this.threadId = undefined;
	}

	private assertRunning(): void {
		if (this.stopped) throw new Error("realtime_stopped");
	}

	private notification(method: string, value: unknown): void {
		const params = record(value);
		if (
			!params ||
			(typeof params.threadId === "string" && params.threadId !== this.threadId)
		)
			return;
		if (
			method === "item/added" ||
			method === "item/started" ||
			method === "item/completed"
		) {
			const item = record(params.item);
			if (
				item?.type === "handoff_request" &&
				typeof item.id === "string" &&
				!this.delegationItems.has(item.id)
			) {
				this.delegationItems.add(item.id);
				this.options.onFrontendDelegation({ itemId: item.id });
			}
			return;
		}
		if (method === "thread/realtime/closed") {
			this.options.onClosed(
				typeof params.reason === "string" ? params.reason : "realtime_closed",
			);
			return;
		}
		if (method === "thread/realtime/transcript/done") {
			if (
				(params.role === "user" || params.role === "assistant") &&
				typeof params.text === "string"
			) {
				this.options.onTranscript({ role: params.role, text: params.text });
			}
			return;
		}
		if (method !== "thread/realtime/outputAudio/delta") return;
		const audio = record(params.audio);
		if (
			!audio ||
			audio.sampleRate !== 24_000 ||
			audio.numChannels !== 1 ||
			typeof audio.data !== "string"
		) {
			this.options.onClosed("realtime_protocol");
			return;
		}
		const pcm = Buffer.from(audio.data, "base64");
		if (
			pcm.length === 0 ||
			pcm.length % 2 !== 0 ||
			pcm.toString("base64") !== audio.data ||
			audio.samplesPerChannel !== pcm.length / 2
		) {
			this.options.onClosed("realtime_protocol");
			return;
		}
		this.options.onAudio(pcm);
	}
}
