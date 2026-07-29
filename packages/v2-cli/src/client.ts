import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { sendHostRequest } from "flywheel-v2-host";

export interface V2ClientOptions {
	socketPath: string;
	secretPath: string;
	timeoutMs?: number;
}

export class V2Client {
	readonly #options: V2ClientOptions;
	readonly #secret: Buffer;

	constructor(options: V2ClientOptions) {
		if (!isAbsolute(options.socketPath) || !isAbsolute(options.secretPath)) {
			throw new TypeError("v2 client socket and secret paths must be absolute");
		}
		if ((statSync(options.secretPath).mode & 0o777) !== 0o600) {
			throw new Error("v2 client secret must be mode 0600");
		}
		this.#options = options;
		this.#secret = readFileSync(options.secretPath);
		if (this.#secret.length < 32) {
			throw new Error("v2 client secret must contain at least 32 bytes");
		}
	}

	request<Result>(action: string, payload: unknown): Promise<Result> {
		return sendHostRequest<Result>({
			socketPath: this.#options.socketPath,
			secret: this.#secret,
			action,
			payload,
			timeoutMs: this.#options.timeoutMs,
		});
	}

	async submitProposalWithRetry<Result>(
		payload: unknown,
		options: { attempts?: number; retryDelayMs?: number } = {},
	): Promise<Result> {
		const attempts = options.attempts ?? 5;
		const retryDelayMs = options.retryDelayMs ?? 100;
		if (!Number.isSafeInteger(attempts) || attempts <= 0) {
			throw new TypeError("attempts must be a positive safe integer");
		}
		let lastError: unknown;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				return await this.request<Result>("submit_proposal", payload);
			} catch (error) {
				lastError = error;
				if (
					error instanceof Error &&
					/capability binding|digest conflict|does not match|is failed|is missing/.test(
						error.message,
					)
				) {
					throw error;
				}
				if (attempt < attempts) {
					await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
				}
			}
		}
		throw lastError;
	}
}
