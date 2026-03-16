import type { StateStore, CleanupCandidate } from "./StateStore.js";

export interface DiscordClient {
	sendMessage(threadId: string, content: string): Promise<void>;
	archiveThread(threadId: string): Promise<void>;
}

export class RateLimitError extends Error {
	constructor(message: string) { super(message); this.name = "RateLimitError"; }
}

function isAlreadyArchivedError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.message.includes("archived") || err.message.includes("Cannot send");
}

export class FetchDiscordClient implements DiscordClient {
	constructor(private token: string) {}
	async sendMessage(threadId: string, content: string): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);
		try {
			const res = await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
				method: "POST", headers: { Authorization: `Bot ${this.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ content }), signal: controller.signal,
			});
			if (res.status === 429) throw new RateLimitError("Discord rate limit hit");
			if (!res.ok) { const b = await res.text().catch(() => ""); throw new Error(`sendMessage failed (${res.status}): ${b}`); }
		} finally { clearTimeout(timeout); }
	}
	async archiveThread(threadId: string): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);
		try {
			const res = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
				method: "PATCH", headers: { Authorization: `Bot ${this.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ archived: true }), signal: controller.signal,
			});
			if (res.status === 429) throw new RateLimitError("Discord rate limit hit");
			if (!res.ok) { const b = await res.text().catch(() => ""); throw new Error(`archiveThread failed (${res.status}): ${b}`); }
		} finally { clearTimeout(timeout); }
	}
}

export class CleanupService {
	private timer: NodeJS.Timeout | null = null;
	private archiving = new Set<string>();
	constructor(private store: StateStore, private discord: DiscordClient, private thresholdMinutes: number, private intervalMs: number) {}
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => { this.check().catch((e) => console.error("[CleanupService]", e)); }, this.intervalMs);
	}
	stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
	async check(): Promise<void> {
		for (const c of this.store.getEligibleForCleanup(this.thresholdMinutes)) {
			if (this.archiving.has(c.thread_id)) continue;
			this.archiving.add(c.thread_id);
			try { await this.archiveOne(c); }
			catch (err) {
				if (err instanceof RateLimitError) { console.warn("[CleanupService] Rate limited"); break; }
				console.warn(`[CleanupService] Failed ${c.thread_id}:`, (err as Error).message);
			} finally { this.archiving.delete(c.thread_id); }
		}
	}
	private async archiveOne(candidate: CleanupCandidate): Promise<void> {
		if (!candidate.cleanup_notified_at) {
			try {
				await this.discord.sendMessage(candidate.thread_id, "This post has been auto-archived (completed > 24h). Use Discord search to find it later.");
				this.store.markCleanupNotified(candidate.thread_id);
			} catch (err) { if (!isAlreadyArchivedError(err)) throw err; }
		}
		await this.discord.archiveThread(candidate.thread_id);
		this.store.markArchived(candidate.thread_id);
		console.log(`[CleanupService] Archived ${candidate.thread_id} (${candidate.issue_id})`);
	}
}
