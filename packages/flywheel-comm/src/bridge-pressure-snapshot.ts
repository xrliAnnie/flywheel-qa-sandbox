import { loadavg } from "node:os";
import { sanitizeOneLine } from "flywheel-config";

interface PressureHealth {
	event_loop?: { p99_ms?: unknown; max_ms?: unknown; episodes?: unknown };
	outbound_pressure?: {
		events?: { response_closed_before_finish_total?: unknown };
	};
}

/** Best-effort diagnostics: the full headers/body read has a two-second budget. */
export async function printBridgePressure(
	bridgeUrl: string,
	tag: string,
	log: (line: string) => void,
): Promise<void> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const number = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value)
			? String(value)
			: "unknown";
	let line: string;
	try {
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error("2s deadline exceeded"));
			}, 2000);
		});
		const health = await Promise.race([
			(async () => {
				const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/health`, {
					signal: controller.signal,
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return (await response.json()) as PressureHealth | null;
			})(),
			deadline,
		]);
		line = `[${tag}] bridge pressure: event_loop p99=${number(health?.event_loop?.p99_ms)} max=${number(health?.event_loop?.max_ms)} episodes=${number(health?.event_loop?.episodes)} closed_before_finish(events)=${number(health?.outbound_pressure?.events?.response_closed_before_finish_total)} load1=${number(loadavg()[0])}`;
	} catch (error) {
		const message = sanitizeOneLine(
			error instanceof Error ? error.message : "unknown error",
			160,
		);
		line = `[${tag}] bridge pressure: health unavailable (${message}) load1=${number(loadavg()[0])}`;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	try {
		log(line);
	} catch {
		/* Diagnostics must not change the caller outcome. */
	}
}
