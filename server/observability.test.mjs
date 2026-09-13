import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServerDatabase } from "./database.mjs";
import { createAnalytics } from "./observability-worker.mjs";
import {
  summarize,
  imageFact,
  parseRange,
  csv,
  safeError,
} from "./observability-domain.mjs";

test("strict success counts partial outcomes and excludes unresolved/canceled without hiding them", () => {
  const tasks = Object.entries({
    succeeded: 70,
    partial: 5,
    failed: 10,
    canceled: 5,
    running: 10,
  }).flatMap(([status, n]) =>
    Array.from({ length: n }, () => ({ status, retries: null })),
  );
  const r = summarize(tasks);
  assert.equal(r.total, 100);
  assert.equal(r.denominator, 85);
  assert.ok(Math.abs(r.successRate - (70 / 85) * 100) < 1e-10);
  assert.equal(r.completionRate, 70);
  assert.equal(r.firstSuccessRate, null);
  const mixed = [
    { status: "succeeded" },
    ...Array.from({ length: 9 }, (_, i) => ({
      status: i ? "failed" : "succeeded",
    })),
  ];
  assert.equal(summarize(mixed).successRate, 20);
});
test("range uses exact 24-hour half-open boundaries and rejects injection/invalid periods", () => {
  const now = Date.parse("2026-09-13T04:00:00Z");
  const r = parseRange({ range: "24h" }, now);
  assert.equal(Date.parse(r.to) - Date.parse(r.from), 86400000);
  assert.equal(r.grain, 300000);
  assert.throws(() => parseRange({ from: "garbage" }, now));
  assert.throws(() =>
    parseRange({ from: "2020-01-01", to: "2026-01-01" }, now),
  );
  assert.equal(summarize([]).successRate, null);
});
test("outputs preserve per-task identity and partial success without global hash deduplication", () => {
  const t = imageFact({
    id: "task",
    userId: "u",
    status: "succeeded",
    createdAt: "2026-09-13T00:00:00Z",
    expectedOutputs: 4,
    media: [{ sha256: "same" }, { sha256: "same" }, { sha256: "third" }],
  });
  assert.equal(t.status, "partial");
  assert.equal(t.delivered, 3);
  assert.equal(new Set(t.artifacts.map((a) => a.id)).size, 3);
  assert.equal(summarize([t]).outputSuccessRate, 75);
  assert.equal(
    imageFact({ ...t, media: [], expectedOutputs: undefined }).expected,
    null,
  );
});
test("CSV neutralizes formulas and masks credential URLs in errors", () => {
  assert.ok(
    csv(
      [{ name: "=HYPERLINK(1)", note: 'a"b' }],
      [
        { key: "name", label: "name" },
        { key: "note", label: "note" },
      ],
    ).includes("'=HYPERLINK"),
  );
  assert.equal(
    safeError("fetch https://private/x?token=abc Bearer secret123 sk-private"),
    "fetch [地址] [凭据] [凭据]",
  );
});
test("outbox replay, historical mapping, credit reconciliation and filters remain exact across restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-observability-"));
  const file = path.join(dir, "server.sqlite");
  const source = createServerDatabase(file);
  let analytics;
  try {
    const now = new Date().toISOString(),
      users = [
        {
          id: "a",
          username: "alice",
          displayName: "Alice",
          role: "user",
          status: "active",
          createdAt: now,
        },
        {
          id: "b",
          username: "bob",
          role: "admin",
          status: "active",
          createdAt: now,
        },
      ];
    fs.writeFileSync(path.join(dir, "users.json"), JSON.stringify(users));
    source.initializeCredits({ ...users[0], credits: 200 });
    source.initializeCredits({ ...users[1], credits: 100 });
    const receipt = source.reserveCredit({
      id: "bill",
      userId: "a",
      generationTaskId: "gen",
      taskId: "img",
      kind: "image",
      model: "model-a",
      channelId: "ch",
      status: "pending",
      createdAt: now,
      cost: 150,
    });
    source.saveTask({
      id: "img",
      userId: "a",
      receiptId: "bill",
      model: "model-a",
      channelId: "ch",
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      persistedAt: now,
      status: "succeeded",
      expectedOutputs: 4,
      media: Array.from({ length: 4 }, (_, i) => ({
        storageKey: `output-${i}`,
        sha256: `hash-${i}`,
        bytes: 10,
      })),
    });
    source.settleCredit(receipt.id, 60);
    const options = {
      sourceFile: file,
      analysisFile: path.join(dir, "analytics.sqlite"),
      usersFile: path.join(dir, "users.json"),
    };
    analytics = createAnalytics(options);
    analytics.sync(true);
    const range = {
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date(Date.now() + 1000).toISOString(),
    };
    let r = analytics.query("report", range);
    assert.equal(r.summary.total, 1);
    assert.equal(r.summary.outputs, 4);
    assert.equal(r.summary.successRate, 100);
    assert.equal(r.models[0].id, "model-a");
    assert.equal(
      analytics.query("report", { ...range, userId: "b" }).summary.total,
      0,
    );
    const c = analytics.query("credits", range);
    assert.equal(c.totals.spent, 60);
    assert.equal(c.rows.find((u) => u.id === "a").credits, 140);
    assert.equal(c.rows.find((u) => u.id === "a").reservedCredits, 0);
    assert.equal(c.rows.find((u) => u.id === "a").difference, 0);
    assert.equal(analytics.query("artifacts", range).total, 4);
    const attempt = {
      taskId: "img",
      userId: "a",
      kind: "image",
      model: "model-a",
      channelId: "ch",
      purpose: "generation",
      startedAt: now,
      status: "running",
    };
    source.observe("attempt", "try1", attempt);
    source.observe("attempt", "try1", { ...attempt, status: "succeeded" });
    analytics.sync(true);
    assert.equal(analytics.query("task", { id: "img" }).attempts.length, 1);
    analytics.close();
    analytics = createAnalytics(options);
    analytics.sync(true);
    r = analytics.query("report", range);
    assert.equal(r.summary.total, 1);
    assert.equal(r.summary.outputs, 4);
    assert.equal(r.attempts.total, 1);
    source.deleteUserData("a");
    analytics.sync(true);
    assert.equal(analytics.query("report", range).summary.total, 1);
  } finally {
    analytics?.close();
    source.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
