import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export interface MigrationIO {
	fetch: typeof fetch;
	run(file: string, args: string[]): Promise<string>;
	now(): number;
}

export const migrationIO: MigrationIO = {
	fetch: globalThis.fetch,
	now: Date.now,
	run: async (file, args) =>
		(
			await promisify(execFile)(file, args, {
				timeout: 15_000,
				maxBuffer: 4 * 1024 * 1024,
				encoding: "utf8",
				env: { ...process.env, LC_ALL: "C", BASH_ENV: "" },
			})
		).stdout,
};

export function digest(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function readPrivate(path: string): string {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
		throw new Error("private-file-invalid");
	return readFileSync(path, "utf8");
}

export async function withRayaDeployLock<T>(
	rayaHome: string,
	io: MigrationIO,
	work: () => Promise<T>,
): Promise<T> {
	mkdirSync(rayaHome, { recursive: true, mode: 0o700 });
	const lock = join(rayaHome, "deploy.lock.d");
	try {
		mkdirSync(lock, { mode: 0o700 });
	} catch {
		try {
			if (!lstatSync(lock).isDirectory() || lstatSync(lock).isSymbolicLink())
				throw new Error("invalid-lock");
			const readPart = (name: string) => {
				const path = join(lock, name),
					stat = lstatSync(path);
				if (!stat.isFile() || stat.isSymbolicLink())
					throw new Error("invalid-lock");
				return readFileSync(path, "utf8");
			};
			const pidBytes = readPart("pid"),
				startBytes = readPart("start");
			const owner = Number(pidBytes.trim());
			if (
				!/^[1-9][0-9]*$/.test(pidBytes.trim()) ||
				!Number.isSafeInteger(owner) ||
				!startBytes.trim()
			)
				throw new Error("invalid-lock");
			let alive = true;
			try {
				process.kill(owner, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				alive = false;
			}
			if (alive) {
				const actual = (
					await io.run("ps", ["-o", "lstart=", "-p", String(owner)])
				).trim();
				if (!actual || actual === startBytes.trim())
					throw new Error("live-lock");
			}
			if (readPart("pid") !== pidBytes || readPart("start") !== startBytes)
				throw new Error("changed-lock");
			unlinkSync(join(lock, "pid"));
			unlinkSync(join(lock, "start"));
			rmdirSync(lock);
			mkdirSync(lock, { mode: 0o700 });
		} catch {
			throw new Error("deploy-lock-held");
		}
	}
	const pid = `${process.pid}\n`;
	let start: string;
	try {
		start = (
			await io.run("ps", ["-o", "lstart=", "-p", String(process.pid)])
		).trim();
		if (!start) throw new Error("deploy-lock-owner-invalid");
		writeFileSync(join(lock, "pid"), pid, { mode: 0o600, flag: "wx" });
		writeFileSync(join(lock, "start"), `${start}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		return await work();
	} finally {
		if (
			!existsSync(join(lock, "pid")) ||
			readFileSync(join(lock, "pid"), "utf8") === pid
		) {
			for (const file of ["pid", "start"])
				if (existsSync(join(lock, file))) unlinkSync(join(lock, file));
			rmdirSync(lock);
		}
	}
}

export function atomicJson(
	path: string,
	value: unknown,
	expected: string | null,
): void {
	if (!isAbsolute(path) || lstatSync(dirname(path)).isSymbolicLink())
		throw new Error("write-path-invalid");
	const current = () => {
		try {
			return digest(readPrivate(path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	};
	if (current() !== expected) throw new Error("write-conflict");
	const temporary = `${path}.tmp.${randomUUID()}`;
	try {
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(value)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (current() !== expected) throw new Error("write-conflict");
		renameSync(temporary, path);
		const directory = openSync(dirname(path), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

export async function discordJson(
	io: MigrationIO,
	path: string,
	token: string,
	body?: unknown,
): Promise<unknown> {
	try {
		const response = await io.fetch(`https://discord.com/api/v10${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bot ${token}`,
				"Content-Type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error("discord-request-failed");
		return await response.json();
	} catch {
		throw new Error("discord-request-failed");
	}
}

export interface ProbeIntent {
	nonce: string;
	at: string;
	channel_id: string;
	bot_user_id: string;
	prefix: string;
	text: string;
	message_id?: string;
}

export function discordSnowflake(ms: number): string {
	if (!Number.isSafeInteger(ms) || ms < 1420070400000)
		throw new Error("snowflake-time-invalid");
	return ((BigInt(ms) - 1420070400000n) << 22n).toString();
}

export function discordMessage(value: unknown): {
	id: string;
	author: { id: string; bot?: boolean };
	content: string;
	channel_id?: string;
} {
	if (!value || typeof value !== "object")
		throw new Error("discord-message-invalid");
	const v = value as Record<string, unknown>;
	const author = v.author as Record<string, unknown> | undefined;
	if (
		typeof v.id !== "string" ||
		!/^[0-9]{17,20}$/.test(v.id) ||
		!author ||
		typeof author.id !== "string" ||
		!/^[0-9]{17,20}$/.test(author.id) ||
		typeof v.content !== "string"
	)
		throw new Error("discord-message-invalid");
	return value as ReturnType<typeof discordMessage>;
}

export async function ensureDiscordProbe(input: {
	file: string;
	channelId: string;
	botId: string;
	token: string;
	prefix: string;
	text: string;
	io: MigrationIO;
}): Promise<ProbeIntent & { message_id: string }> {
	const { io } = input;
	let bytes: string | undefined;
	try {
		bytes = readPrivate(input.file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const intent: ProbeIntent = bytes
		? JSON.parse(bytes)
		: {
				nonce: randomUUID(),
				at: new Date(io.now()).toISOString(),
				channel_id: input.channelId,
				bot_user_id: input.botId,
				prefix: input.prefix,
				text: input.text,
			};
	if (
		!/^[0-9a-f-]{36}$/.test(intent.nonce) ||
		!Number.isFinite(Date.parse(intent.at)) ||
		intent.channel_id !== input.channelId ||
		intent.bot_user_id !== input.botId ||
		intent.prefix !== input.prefix ||
		intent.text !== input.text
	)
		throw new Error("probe-intent-invalid");
	if (intent.message_id) {
		if (!/^[0-9]{17,20}$/.test(intent.message_id))
			throw new Error("probe-intent-invalid");
		return intent as ProbeIntent & { message_id: string };
	}
	const content = `[${intent.prefix} ${intent.nonce}] ${intent.text}`;
	const persist = (id: string) => {
		const result = { ...intent, message_id: id };
		atomicJson(input.file, result, bytes === undefined ? null : digest(bytes));
		return result;
	};
	if (bytes !== undefined) {
		// A durable intent is evidence that POST may already have happened.
		// Recovery only reads: an uncertain response never authorizes another POST.
		try {
			let after = discordSnowflake(Date.parse(intent.at) - 60_000);
			for (let page = 0; page < 10; page++) {
				const raw = await discordJson(
					io,
					`/channels/${input.channelId}/messages?limit=100&after=${after}`,
					input.token,
				);
				if (!Array.isArray(raw)) throw new Error("probe-history-invalid");
				const messages = raw.map(discordMessage);
				const matches = messages.filter(
					(message) =>
						message.author.id === input.botId && message.content === content,
				);
				if (matches.length === 1) return persist(matches[0]!.id);
				if (matches.length > 1 || messages.length < 100) break;
				const next = messages.reduce(
					(max, message) =>
						BigInt(message.id) > BigInt(max) ? message.id : max,
					after,
				);
				if (next === after) break;
				after = next;
			}
		} catch {
			throw new Error("probe-delivery-ambiguous");
		}
		throw new Error("probe-delivery-ambiguous");
	}
	atomicJson(input.file, intent, null);
	bytes = readPrivate(input.file);
	try {
		const message = discordMessage(
			await discordJson(
				io,
				`/channels/${input.channelId}/messages`,
				input.token,
				{ content, allowed_mentions: { parse: [] } },
			),
		);
		if (
			message.author.id !== input.botId ||
			message.channel_id !== input.channelId ||
			message.content !== content
		)
			throw new Error("probe-response-invalid");
		return persist(message.id);
	} catch {
		throw new Error("probe-delivery-ambiguous");
	}
}
