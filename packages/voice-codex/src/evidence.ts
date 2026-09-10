import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

export class EvidenceLog {
	constructor(readonly path: string) {}

	append(record: Record<string, unknown>): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const fd = openSync(
			this.path,
			constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
			0o600,
		);
		try {
			chmodSync(this.path, 0o600);
			writeSync(fd, `${JSON.stringify(record)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}
