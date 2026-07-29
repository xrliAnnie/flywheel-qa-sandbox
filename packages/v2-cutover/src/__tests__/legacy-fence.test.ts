import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	archiveAndTombstoneLegacyPath,
	legacyArchiveRestoreState,
	restoreLegacyArchivePath,
	runLegacyWriterLiveFire,
} from "../legacy-fence.js";

describe("legacy archive tombstones and live fire", () => {
	let root: string | undefined;

	afterEach(() => {
		if (!root) return;
		const makeWritable = (path: string): void => {
			try {
				chmodSync(path, 0o700);
				if (lstatSync(path).isDirectory()) {
					for (const entry of readdirSync(path)) {
						makeWritable(join(path, entry));
					}
				}
			} catch {
				// Missing paths need no restoration.
			}
		};
		makeWritable(root);
		rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("moves bytes to a read-only archive and makes old writers fail loud", () => {
		root = mkdtempSync(join(tmpdir(), "flywheel-v2-fence-"));
		const legacyRoot = join(root, "legacy");
		const commPath = join(legacyRoot, "comm.db");
		const inboxRoot = join(legacyRoot, "json-inboxes");
		mkdirSync(inboxRoot, { recursive: true });
		writeFileSync(commPath, "legacy sqlite bytes");
		writeFileSync(join(inboxRoot, "lead.json"), "[]");
		const legacyRootMode = lstatSync(legacyRoot).mode & 0o777;

		const comm = archiveAndTombstoneLegacyPath({
			sourcePath: commPath,
			archivePath: join(root, "archive", "comm.db"),
		});
		expect(lstatSync(commPath).isDirectory()).toBe(true);
		expect(lstatSync(commPath).mode & 0o777).toBe(0o500);
		expect(lstatSync(legacyRoot).mode & 0o777).toBe(legacyRootMode);
		writeFileSync(
			join(legacyRoot, "v2-cutover-authority.json"),
			'{"state":"live"}\n',
		);
		const inbox = archiveAndTombstoneLegacyPath({
			sourcePath: inboxRoot,
			archivePath: join(root, "archive", "json-inboxes"),
		});
		expect(comm.kind).toBe("file");
		expect(inbox.kind).toBe("directory");
		expect(
			archiveAndTombstoneLegacyPath({
				sourcePath: inboxRoot,
				archivePath: join(root, "archive", "json-inboxes"),
			}),
		).toEqual(inbox);

		const results = runLegacyWriterLiveFire({
			watchedPaths: [commPath, inboxRoot],
			commands: [
				{
					name: "comm-db-writer",
					argv: [
						process.execPath,
						"-e",
						"require('node:fs').writeFileSync(process.argv[1], 'new')",
						commPath,
					],
				},
				{
					name: "comm-db-sqlite-writer",
					argv: [
						process.execPath,
						"-e",
						"const Database=require('better-sqlite3'); new Database(process.argv[1]).exec('CREATE TABLE resurrected(id INTEGER)')",
						commPath,
					],
				},
				{
					name: "comm-db-recursive-rebuilder",
					argv: [
						process.execPath,
						"-e",
						"const fs=require('node:fs'); fs.rmSync(process.argv[1], {recursive:true,force:true}); fs.writeFileSync(process.argv[1], 'new')",
						commPath,
					],
				},
				{
					name: "json-recreator",
					argv: [
						process.execPath,
						"-e",
						"require('node:fs').writeFileSync(process.argv[1], '[]')",
						join(inboxRoot, "new.json"),
					],
				},
			],
		});
		expect(results).toHaveLength(4);
		expect(results.every((result) => result.exitCode !== 0)).toBe(true);
		restoreLegacyArchivePath(inbox);
		expect(
			archiveAndTombstoneLegacyPath({
				sourcePath: inboxRoot,
				archivePath: join(root, "archive", "json-inboxes-2"),
			}).sourceDigest,
		).toBe(inbox.sourceDigest);
		restoreLegacyArchivePath(comm);
		expect(readFileSync(commPath, "utf8")).toBe("legacy sqlite bytes");
		expect(lstatSync(legacyRoot).mode & 0o777).toBe(legacyRootMode);
	});

	it("rejects weakened or symlinked tombstone sentinels on replay", () => {
		root = mkdtempSync(join(tmpdir(), "flywheel-v2-fence-shape-"));
		const legacyRoot = join(root, "legacy");
		const sourcePath = join(legacyRoot, "teamlead.db");
		const archivePath = join(root, "archive", "teamlead.db");
		mkdirSync(legacyRoot, { recursive: true });
		chmodSync(legacyRoot, 0o750);
		writeFileSync(sourcePath, "runner registry");

		archiveAndTombstoneLegacyPath({ sourcePath, archivePath });
		const markerPath = join(sourcePath, ".flywheel-v2-tombstone.json");
		const markerBytes = readFileSync(markerPath);
		const parentMode = lstatSync(legacyRoot).mode & 0o777;

		chmodSync(legacyRoot, 0o700);
		expect(() =>
			archiveAndTombstoneLegacyPath({ sourcePath, archivePath }),
		).toThrow(/parent.*mode/i);
		chmodSync(legacyRoot, parentMode);
		chmodSync(sourcePath, 0o700);
		expect(() =>
			archiveAndTombstoneLegacyPath({ sourcePath, archivePath }),
		).toThrow(/tombstone.*mode/i);

		chmodSync(sourcePath, 0o500);
		chmodSync(markerPath, 0o600);
		expect(() =>
			archiveAndTombstoneLegacyPath({ sourcePath, archivePath }),
		).toThrow(/marker.*mode/i);

		chmodSync(sourcePath, 0o700);
		rmSync(markerPath);
		const replacement = join(root, "replacement-marker.json");
		writeFileSync(replacement, markerBytes);
		symlinkSync(replacement, markerPath);
		chmodSync(sourcePath, 0o500);
		expect(() =>
			archiveAndTombstoneLegacyPath({ sourcePath, archivePath }),
		).toThrow(/marker.*symbolic link/i);
	});

	it("rejects malformed tombstone receipt metadata", () => {
		root = mkdtempSync(join(tmpdir(), "flywheel-v2-fence-metadata-"));
		const legacyRoot = join(root, "legacy");
		const sourcePath = join(legacyRoot, "teamlead.db");
		const archivePath = join(root, "archive", "teamlead.db");
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(sourcePath, "runner registry");
		archiveAndTombstoneLegacyPath({ sourcePath, archivePath });

		const markerPath = join(sourcePath, ".flywheel-v2-tombstone.json");
		const original = JSON.parse(readFileSync(markerPath, "utf8")) as Record<
			string,
			unknown
		>;
		const writeMarker = (changes: Record<string, unknown>): void => {
			chmodSync(sourcePath, 0o700);
			chmodSync(markerPath, 0o600);
			writeFileSync(
				markerPath,
				`${JSON.stringify({ ...original, ...changes })}\n`,
			);
			chmodSync(markerPath, 0o400);
			chmodSync(sourcePath, 0o500);
		};

		writeMarker({ source_modes: [] });
		expect(() =>
			archiveAndTombstoneLegacyPath({ sourcePath, archivePath }),
		).toThrow(/source_modes/i);
		writeMarker({ parent_mode: 0o1000 });
		expect(() =>
			archiveAndTombstoneLegacyPath({ sourcePath, archivePath }),
		).toThrow(/parent_mode/i);
		writeMarker({ kind: "directory" });
		expect(() =>
			archiveAndTombstoneLegacyPath({ sourcePath, archivePath }),
		).toThrow(/kind|digest/i);
	});

	it("detects shared-parent mode weakening during live fire", () => {
		root = mkdtempSync(join(tmpdir(), "flywheel-v2-fence-mode-"));
		const legacyRoot = join(root, "legacy");
		const sourcePath = join(legacyRoot, "teamlead.db");
		mkdirSync(legacyRoot, { recursive: true });
		chmodSync(legacyRoot, 0o750);
		writeFileSync(sourcePath, "runner registry");
		archiveAndTombstoneLegacyPath({
			sourcePath,
			archivePath: join(root, "archive", "teamlead.db"),
		});

		expect(() =>
			runLegacyWriterLiveFire({
				watchedPaths: [sourcePath],
				commands: [
					{
						name: "parent-mode-weakener",
						argv: [
							process.execPath,
							"-e",
							"const fs=require('node:fs'); const path=require('node:path'); fs.chmodSync(path.dirname(process.argv[1]), 0o700); console.error('EACCES simulated'); process.exit(1)",
							sourcePath,
						],
					},
				],
			}),
		).toThrow(/changed a frozen path/i);
	});

	it("accepts SQLite CANTOPEN as bounded fail-loud evidence", () => {
		root = mkdtempSync(join(tmpdir(), "flywheel-v2-fence-cantopen-"));
		const sourcePath = join(root, "teamlead.db");
		writeFileSync(sourcePath, "runner registry");
		archiveAndTombstoneLegacyPath({
			sourcePath,
			archivePath: join(root, "archive", "teamlead.db"),
		});

		expect(
			runLegacyWriterLiveFire({
				watchedPaths: [sourcePath],
				commands: [
					{
						name: "sqlite-cantopen",
						argv: [
							process.execPath,
							"-e",
							"console.error('SqliteError: unable to open database file (SQLITE_CANTOPEN)'); process.exit(1)",
						],
					},
				],
			}),
		).toHaveLength(1);
	});

	it("rejects writable archive files and directories on replay", () => {
		root = mkdtempSync(join(tmpdir(), "flywheel-v2-fence-archive-mode-"));
		const fileSource = join(root, "teamlead.db");
		const fileArchive = join(root, "archive", "teamlead.db");
		const directorySource = join(root, "json-inboxes");
		const directoryArchive = join(root, "archive", "json-inboxes");
		mkdirSync(directorySource, { recursive: true });
		writeFileSync(fileSource, "runner registry");
		writeFileSync(join(directorySource, "lead.json"), "[]");
		archiveAndTombstoneLegacyPath({
			sourcePath: fileSource,
			archivePath: fileArchive,
		});
		archiveAndTombstoneLegacyPath({
			sourcePath: directorySource,
			archivePath: directoryArchive,
		});

		chmodSync(fileArchive, 0o600);
		expect(() =>
			archiveAndTombstoneLegacyPath({
				sourcePath: fileSource,
				archivePath: fileArchive,
			}),
		).toThrow(/archive.*mode/i);
		chmodSync(fileArchive, 0o400);

		chmodSync(directoryArchive, 0o700);
		expect(() =>
			archiveAndTombstoneLegacyPath({
				sourcePath: directorySource,
				archivePath: directoryArchive,
			}),
		).toThrow(/archive.*mode/i);
		chmodSync(directoryArchive, 0o500);
		chmodSync(join(directoryArchive, "lead.json"), 0o600);
		expect(() =>
			archiveAndTombstoneLegacyPath({
				sourcePath: directorySource,
				archivePath: directoryArchive,
			}),
		).toThrow(/archive.*mode/i);
	});

	it("binds rollback mode metadata to the validated tombstone receipt", () => {
		root = mkdtempSync(join(tmpdir(), "flywheel-v2-fence-receipt-"));
		const sourcePath = join(root, "teamlead.db");
		const archivePath = join(root, "archive", "teamlead.db");
		chmodSync(root, 0o750);
		writeFileSync(sourcePath, "runner registry");
		const receipt = archiveAndTombstoneLegacyPath({
			sourcePath,
			archivePath,
		});

		expect(() =>
			legacyArchiveRestoreState({
				...receipt,
				sourceModes: { ...receipt.sourceModes, "../sibling": 0o777 },
			}),
		).toThrow(/receipt.*sourceModes/i);
		expect(() =>
			restoreLegacyArchivePath({
				...receipt,
				parentMode: 0o777,
			}),
		).toThrow(/receipt.*parentMode/i);
		expect(lstatSync(root).mode & 0o777).toBe(0o750);
	});

	it("re-enters rollback across tombstone removal and archive promotion", () => {
		root = mkdtempSync(join(tmpdir(), "flywheel-v2-fence-restore-reentry-"));
		const setup = (name: string) => {
			const parent = join(root as string, name);
			const sourcePath = join(parent, "teamlead.db");
			const archivePath = join(root as string, "archive", name, "teamlead.db");
			mkdirSync(parent, { recursive: true });
			chmodSync(parent, 0o750);
			writeFileSync(sourcePath, `runner registry ${name}`);
			return {
				parent,
				sourcePath,
				archivePath,
				receipt: archiveAndTombstoneLegacyPath({
					sourcePath,
					archivePath,
				}),
			};
		};
		const assertRestored = (
			fixture: ReturnType<typeof setup>,
			name: string,
		): void => {
			restoreLegacyArchivePath(fixture.receipt);
			expect(readFileSync(fixture.sourcePath, "utf8")).toBe(
				`runner registry ${name}`,
			);
			expect(lstatSync(fixture.parent).mode & 0o777).toBe(0o750);
			expect(lstatSync(fixture.sourcePath).mode & 0o777).toBe(
				fixture.receipt.sourceModes["."],
			);
		};

		const writableTombstone = setup("writable-tombstone");
		chmodSync(writableTombstone.sourcePath, 0o700);
		assertRestored(writableTombstone, "writable-tombstone");

		const removedTombstone = setup("removed-tombstone");
		chmodSync(removedTombstone.sourcePath, 0o700);
		rmSync(removedTombstone.sourcePath, { recursive: true });
		assertRestored(removedTombstone, "removed-tombstone");

		const writableArchive = setup("writable-archive");
		chmodSync(writableArchive.sourcePath, 0o700);
		rmSync(writableArchive.sourcePath, { recursive: true });
		chmodSync(writableArchive.archivePath, 0o600);
		assertRestored(writableArchive, "writable-archive");

		const partialTombstoneCleanup = setup("partial-tombstone-cleanup");
		const restoreTombstonePath = `${partialTombstoneCleanup.sourcePath}.flywheel-v2-restore-tombstone`;
		chmodSync(partialTombstoneCleanup.sourcePath, 0o700);
		renameSync(partialTombstoneCleanup.sourcePath, restoreTombstonePath);
		chmodSync(restoreTombstonePath, 0o700);
		rmSync(join(restoreTombstonePath, ".flywheel-v2-tombstone.json"));
		assertRestored(partialTombstoneCleanup, "partial-tombstone-cleanup");
		expect(existsSync(restoreTombstonePath)).toBe(false);

		const promotedArchive = setup("promoted-archive");
		chmodSync(promotedArchive.sourcePath, 0o700);
		rmSync(promotedArchive.sourcePath, { recursive: true });
		renameSync(promotedArchive.archivePath, promotedArchive.sourcePath);
		assertRestored(promotedArchive, "promoted-archive");
	});

	it("rejects a restore-tombstone namespace collision before archiving", () => {
		root = mkdtempSync(join(tmpdir(), "flywheel-v2-fence-restore-collision-"));
		const sourcePath = join(root, "teamlead.db");
		const archivePath = join(root, "archive", "teamlead.db");
		const restoreTombstonePath = `${sourcePath}.flywheel-v2-restore-tombstone`;
		writeFileSync(sourcePath, "runner registry");
		writeFileSync(restoreTombstonePath, "collision");

		expect(() =>
			archiveAndTombstoneLegacyPath({ sourcePath, archivePath }),
		).toThrow(/restore tombstone.*exists/i);
		expect(readFileSync(sourcePath, "utf8")).toBe("runner registry");
		expect(existsSync(archivePath)).toBe(false);
	});
});
