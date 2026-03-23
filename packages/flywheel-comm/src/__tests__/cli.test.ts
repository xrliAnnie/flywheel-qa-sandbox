import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../dist/index.js");

function runCli(args: string[], env?: Record<string, string>): string {
  return execFileSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  }).trim();
}

function runCliSafe(
  args: string[],
  env?: Record<string, string>,
): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return {
      stdout: (e.stdout ?? "").toString().trim(),
      exitCode: e.status ?? 1,
    };
  }
}

describe("CLI", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-cli-"));
    dbPath = join(tmpDir, "comm.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("ask", () => {
    it("should output question ID", () => {
      const result = runCli([
        "ask",
        "--lead",
        "product-lead",
        "--db",
        dbPath,
        "What should I do?",
      ]);
      // Should be a UUID
      expect(result).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("should output JSON with --json", () => {
      const result = runCli([
        "ask",
        "--lead",
        "product-lead",
        "--db",
        dbPath,
        "--json",
        "What should I do?",
      ]);
      const parsed = JSON.parse(result);
      expect(parsed.question_id).toBeTruthy();
    });

    it("should fail without --lead", () => {
      const { exitCode } = runCliSafe(["ask", "--db", dbPath, "question"]);
      expect(exitCode).toBe(1);
    });
  });

  describe("check", () => {
    it("should output 'not yet' when no response", () => {
      const qId = runCli([
        "ask",
        "--lead",
        "product-lead",
        "--db",
        dbPath,
        "Q?",
      ]);
      const result = runCli(["check", "--db", dbPath, qId]);
      expect(result).toBe("not yet");
    });

    it("should output answer when responded", () => {
      const qId = runCli([
        "ask",
        "--lead",
        "product-lead",
        "--db",
        dbPath,
        "Q?",
      ]);
      runCli(["respond", "--lead", "product-lead", "--db", dbPath, qId, "Use REST."]);
      const result = runCli(["check", "--db", dbPath, qId]);
      expect(result).toBe("Use REST.");
    });

    it("should always exit 0 regardless of answer status", () => {
      const qId = runCli([
        "ask",
        "--lead",
        "product-lead",
        "--db",
        dbPath,
        "Q?",
      ]);
      // Not yet answered — should still exit 0
      const { exitCode } = runCliSafe(["check", "--db", dbPath, qId]);
      expect(exitCode).toBe(0);
    });

    it("should output JSON with --json", () => {
      const qId = runCli([
        "ask",
        "--lead",
        "product-lead",
        "--db",
        dbPath,
        "Q?",
      ]);
      // Pending
      const pendingResult = JSON.parse(
        runCli(["check", "--db", dbPath, "--json", qId]),
      );
      expect(pendingResult.status).toBe("pending");

      // Answer
      runCli(["respond", "--lead", "product-lead", "--db", dbPath, qId, "Answer"]);
      const answeredResult = JSON.parse(
        runCli(["check", "--db", dbPath, "--json", qId]),
      );
      expect(answeredResult.status).toBe("answered");
      expect(answeredResult.content).toBe("Answer");
    });
  });

  describe("pending", () => {
    it("should list pending questions", () => {
      runCli([
        "ask",
        "--lead",
        "product-lead",
        "--db",
        dbPath,
        "First question",
      ]);
      runCli([
        "ask",
        "--lead",
        "product-lead",
        "--db",
        dbPath,
        "Second question",
      ]);

      const result = runCli([
        "pending",
        "--lead",
        "product-lead",
        "--db",
        dbPath,
      ]);
      expect(result).toContain("First question");
      expect(result).toContain("Second question");
    });

    it("should output JSON with --json", () => {
      runCli(["ask", "--lead", "product-lead", "--db", dbPath, "Q?"]);
      const result = JSON.parse(
        runCli([
          "pending",
          "--lead",
          "product-lead",
          "--db",
          dbPath,
          "--json",
        ]),
      );
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Q?");
    });
  });

  describe("respond", () => {
    it("should confirm response", () => {
      const qId = runCli([
        "ask",
        "--lead",
        "product-lead",
        "--db",
        dbPath,
        "Q?",
      ]);
      const result = runCli(["respond", "--lead", "product-lead", "--db", dbPath, qId, "Answer here"]);
      expect(result).toContain("Responded to");
    });
  });

  describe("DB path resolution", () => {
    it("should resolve from FLYWHEEL_COMM_DB env var", () => {
      const qId = runCli(
        ["ask", "--lead", "product-lead", "Q?"],
        { FLYWHEEL_COMM_DB: dbPath },
      );
      expect(qId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("should resolve from --project flag", () => {
      const qId = runCli([
        "ask",
        "--lead",
        "product-lead",
        "--project",
        "test-project",
        "Q?",
      ]);
      expect(qId).toBeTruthy();
    });

    it("should fail without any DB path", () => {
      const { exitCode } = runCliSafe(
        ["ask", "--lead", "product-lead", "Q?"],
        { FLYWHEEL_COMM_DB: "" },
      );
      expect(exitCode).toBe(1);
    });
  });

  describe("help", () => {
    it("should print usage with --help", () => {
      const result = runCli(["--help"]);
      expect(result).toContain("Usage:");
      expect(result).toContain("ask");
      expect(result).toContain("check");
    });
  });
});
