import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSwarmBoard } from "../swarm-board.ts";
import { swarmMentionPattern } from "../swarm-contract.ts";

const VALID_ID = "1665e07b-1a7f-4ab3-a2df-52beefe0097f";

function withTempAppData(fn) {
  const dir = mkdtempSync(join(tmpdir(), "agy-swarm-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readSwarmBoard rejects malformed provider thread IDs", () => {
  const result = readSwarmBoard("../etc/passwd");
  assert.equal(result.exists, false);
  assert.equal(result.providerThreadId, null);
});

test("readSwarmBoard returns exists=false when swarm directory is absent", () => {
  withTempAppData((appDataDir) => {
    const result = readSwarmBoard(VALID_ID, { appDataDir });
    assert.equal(result.exists, false);
    assert.equal(result.providerThreadId, VALID_ID);
    assert.deepEqual(result.members, []);
    assert.deepEqual(result.messages, []);
  });
});

test("readSwarmBoard parses members, board.jsonl, swarm.json, and plan.json", () => {
  withTempAppData((appDataDir) => {
    const swarmDir = join(appDataDir, "brain", VALID_ID, ".system_generated", "swarm");
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      join(swarmDir, "swarm.json"),
      JSON.stringify({ version: 1, backend: "local", swarm_id: VALID_ID, created_at: "2026-11-23T19:43:42Z" }),
    );
    writeFileSync(
      join(swarmDir, "members.json"),
      JSON.stringify({
        title: "Read-only 2-worker swarm test",
        members: {
          "worker-b": {
            role: "worker",
            phase: "WAITING",
            model: "gemini-4-neon-medium",
            workspace_mode: "share",
            killed: false,
            last_read_seq: 2,
          },
          coordinator: {
            role: "coordinator",
            phase: "RUNNING",
            applied_model: "gemini-4-neon-high",
            workspace_mode: "inherit",
            killed: false,
            last_read_seq: 4,
          },
          "worker-a": {
            role: "worker",
            phase: "STOPPED",
            model: "gemini-4-neon-medium",
            workspace_mode: "inherit",
            killed: true,
            last_read_seq: 3,
          },
        },
      }),
    );
    writeFileSync(
      join(swarmDir, "plan.json"),
      JSON.stringify({
        goal: { title: "Verify swarm board", line: "Read files and report cleanly." },
        tasks: { "worker-a": "Check package.json", "worker-b": "Check maintenance.ts" },
        threads: [{ id: "t-check", title: "Checks", goal: "Collect both answers.", tasks: ["worker-a", "worker-b"] }],
      }),
    );
    writeFileSync(
      join(swarmDir, "board.jsonl"),
      [
        JSON.stringify({ seq: 1, agent: "coordinator", text: "@worker-a Check package.json", time: "2026-11-23 20:43:44", kind: "brief" }),
        "{not valid partial json line",
        JSON.stringify({ seq: 2, agent: "worker-a", text: "@coordinator [done] bb-plugin-antigravity-plus 0.2.0", time: "2026-11-23 20:44:01" }),
      ].join("\n"),
    );

    const snapshot = readSwarmBoard(VALID_ID, { appDataDir });
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.title, "Read-only 2-worker swarm test");
    assert.equal(snapshot.swarmId, VALID_ID);
    assert.equal(snapshot.createdAt, "2026-11-23T19:43:42Z");

    // Coordinator first, then active workers, then killed workers
    assert.deepEqual(
      snapshot.members.map((m) => m.name),
      ["coordinator", "worker-b", "worker-a"],
    );
    assert.equal(snapshot.members[0].model, "gemini-4-neon-high");
    assert.equal(snapshot.members[1].workspaceMode, "share");
    assert.equal(snapshot.members[2].killed, true);

    assert.equal(snapshot.plan?.goalTitle, "Verify swarm board");
    assert.equal(snapshot.plan?.threads.length, 1);

    assert.equal(snapshot.totalMessages, 2);
    assert.equal(snapshot.truncated, false);
    assert.equal(snapshot.messages[0].kind, "brief");
    assert.match(snapshot.messages[1].text, /\[done\]/);
  });
});

test("readSwarmBoard caps board output to the latest 200 messages", () => {
  withTempAppData((appDataDir) => {
    const swarmDir = join(appDataDir, "brain", VALID_ID, ".system_generated", "swarm");
    mkdirSync(swarmDir, { recursive: true });
    const lines = [];
    for (let i = 1; i <= 215; i += 1) {
      lines.push(JSON.stringify({ seq: i, agent: "worker-a", text: `post ${i}` }));
    }
    writeFileSync(join(swarmDir, "board.jsonl"), lines.join("\n"));

    const snapshot = readSwarmBoard(VALID_ID, { appDataDir });
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.totalMessages, 215);
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.messages.length, 200);
    assert.equal(snapshot.messages[0].seq, 16);
    assert.equal(snapshot.messages[199].seq, 215);
  });
});

test("readSwarmBoard tail-reads oversized board.jsonl without losing trailing posts and rejects oversized JSON objects", () => {
  withTempAppData((appDataDir) => {
    const swarmDir = join(appDataDir, "brain", VALID_ID, ".system_generated", "swarm");
    mkdirSync(swarmDir, { recursive: true });
    // Oversized members.json (> maxFileBytes) must not be tail-sliced into invalid JSON
    writeFileSync(
      join(swarmDir, "members.json"),
      JSON.stringify({ title: "Big", padding: "x".repeat(4096), members: {} }),
    );
    const lines = [
      JSON.stringify({ seq: 1, agent: "coordinator", text: "a".repeat(600) }),
      JSON.stringify({ seq: 2, agent: "worker-a", text: "b".repeat(600) }),
      JSON.stringify({ seq: 3, agent: "worker-b", text: "@coordinator [done] latest line" }),
    ];
    writeFileSync(join(swarmDir, "board.jsonl"), lines.join("\n"));

    const snapshot = readSwarmBoard(VALID_ID, { appDataDir, maxFileBytes: 512 });
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.title, null);
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.messages[0].seq, 3);
    assert.match(snapshot.messages[0].text, /latest line/);
  });
});

test("Swarm mentions match complete agent names", () => {
  const mention = swarmMentionPattern("worker-1");
  assert.equal(mention.test("Thanks, @worker-1!"), true);
  assert.equal(mention.test("@worker-10 @worker-1-backup"), false);
  assert.equal(mention.test("mail@worker-1"), false);
  assert.equal(mention.test("@worker-1é"), false);
  assert.equal(swarmMentionPattern("worker.1").test("(@worker.1)"), true);
  assert.equal(swarmMentionPattern("worker.1").test("@workerX1"), false);
});
