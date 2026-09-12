import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServerDatabase } from "./database.mjs";
import { isVideoCreation, videoOutcome, videoTaskId, videoBillingQuantity } from "./generation-billing.mjs";

test("only video creation routes are billable; task queries and content retrieval are free", () => {
    for (const route of ["/v1/videos", "/videos", "/v2/videos/generations", "/v2/video_generation", "/v1/contents/generations/tasks"]) {
        assert.equal(isVideoCreation("POST", route), true);
        assert.equal(isVideoCreation("GET", route), false);
    }
    for (const route of ["/v1/videos/task-1", "/v1/videos/task-1/content", "/v2/videos/generations/task-1", "/v2/query/video_generation/task-1", "/v1/contents/generations/tasks/task-1"]) {
        assert.equal(isVideoCreation("GET", route), false);
        assert.equal(isVideoCreation("POST", route), false);
        assert.equal(videoTaskId(route), "task-1");
    }
    assert.equal(videoTaskId("/v2/videos/generations/grok%3Atask-id"), "grok:task-id");
});

test("terminal failure, temporary errors and successful generation are distinct", () => {
    const outcome = (value) => videoOutcome(Buffer.from(JSON.stringify(value)));
    for (const status of ["failed", "FAILURE", "cancelled"]) assert.equal(outcome({ task: { id: "t1", status } }).state, "failed");
    assert.equal(outcome({ task: { id: "t1", status: "expired" } }).state, "unknown");
    assert.equal(outcome({ status: "SUCCESS", data: { video_url: "https://example.com/video.mp4" } }).state, "ready");
    assert.equal(outcome({ task: { status: "succeeded", content: { url: "https://example.com/video.mp4" } } }).state, "ready");
    assert.equal(outcome({ code: 429, error: "temporary" }).state, "unknown");
    assert.equal(outcome({ error: "provider unavailable" }).state, "unknown");
    assert.equal(videoOutcome(Buffer.from("invalid JSON")).state, "unknown");
    assert.equal(outcome({ task_id: "t1" }).taskId, "t1");
    assert.equal(outcome({ status: "queued", metadata: { url: "" } }).state, "pending");
    assert.equal(outcome({ status: "queued", metadata: { url: "" } }).phase, "queued");
});

test("all supported video lengths reserve 15 seconds and invalid model durations are rejected", async () => {
    const req = (body) => ({ headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
    for (const seconds of [6, 10, 15]) {
        const request = req({ model: "video", seconds });
        assert.equal(await videoBillingQuantity(request, "second"), 15);
        assert.equal(request.videoRequestedSeconds, seconds);
    }
    const auto = req({ model: "seedance-2.0", duration: -1 });
    assert.equal(await videoBillingQuantity(auto, "second"), 15);
    assert.equal(auto.videoRequestedSeconds, null);
    for (const seconds of [0, -2, 16, "bad", null]) await assert.rejects(videoBillingQuantity(req({ model: "video", seconds }), "second"));
    await assert.rejects(videoBillingQuantity(req({ seconds: 6, duration: 10 }), "second"), /不一致/);
    await assert.rejects(videoBillingQuantity(req({ duration: 5 }), "second", { apiFormat: "grok-video-v2" }));
    await assert.rejects(videoBillingQuantity(req({ duration: 2 }), "second", { apiFormat: "minimax-h3" }));
});

test("request reservations and response replay survive restart and isolate accounts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-billing-"));
    const file = path.join(dir, "server.sqlite");
    let db = createServerDatabase(file);
    try {
        assert.equal(db.reserveGeneration("user-a", "request-1", "hash-a"), null);
        assert.equal(db.reserveGeneration("user-a", "request-1", "hash-a").response_json, null);
        db.completeGeneration("user-a", "request-1", { status: 202, taskId: "task-1" });
        assert.equal(db.reserveGeneration("user-a", "pending", "hash-b"), null);
        db.close();
        db = createServerDatabase(file);
        assert.equal(JSON.parse(db.reserveGeneration("user-a", "request-1", "hash-a").response_json).taskId, "task-1");
        assert.equal(db.reserveGeneration("user-a", "pending", "hash-b").response_json, null);
        assert.equal(db.reserveGeneration("user-b", "request-1", "hash-a"), null);
        assert.equal(db.reserveGeneration("user-a", "request-1", "changed").fingerprint, "hash-a");
        db.deleteUserData("user-a");
        assert.equal(db.reserveGeneration("user-a", "request-1", "hash-a"), null);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("audit ledger keeps immutable transition snapshots and enforces one confirmed bill per task", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-ledger-"));
    const file = path.join(dir, "server.sqlite");
    let db = createServerDatabase(file);
    try {
        const receipt = { id: "receipt-1", generationTaskId: "generation-1", userId: "user-a", createdAt: new Date().toISOString(), kind: "video", model: "model-a", channelId: "channel-a", taskId: "task-a", status: "pending", unitPrice: 100, quantity: 1, cost: 100 };
        db.initializeCredits({ id: "user-a", credits: 200 });
        db.reserveCredit(receipt);
        db.settleCredit(receipt.id, 100);
        assert.throws(() => db.recordBilling({ ...receipt, status: "completed", id: "receipt-2" }, "confirmed"), /UNIQUE/);
        assert.equal(db.listBilling().total, 1);
        db.close();
        db = createServerDatabase(file);
        assert.equal(db.findVideoReceipt("user-a", "channel-a", "task-a").id, "receipt-1");
        assert.equal(db.getBillingReceipt("user-b", "receipt-1"), null);
        assert.equal(db.billingEvents("receipt-1")[0].receipt.status, "pending");
        assert.equal(db.billingEvents("receipt-1")[1].receipt.status, "completed");
        db.deleteUserData("user-a");
        assert.equal(db.listBilling({ userId: "user-a" }).total, 1, "account cleanup must preserve accounting history");
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
