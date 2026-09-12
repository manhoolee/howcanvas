import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createServerDatabase } from "./database.mjs";
import { creditUnits, durationCost } from "./credit-accounting.mjs";

test("15-second hold, verified settlement and change are atomic, idempotent and persistent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-ledger-"));
    const file = path.join(dir, "db.sqlite");
    let db = createServerDatabase(file);
    const raw = new DatabaseSync(file);
    try {
        const user = { id: "user", credits: 200 };
        db.initializeCredits(user);
        const r = db.reserveCredit({ id: "bill", generationTaskId: "internal-1", userId: "user", kind: "video", model: "video", createdAt: new Date().toISOString(), cost: 150, unitPrice: 10, pricingUnit: "second", quantity: 15, videoBilling: true });
        assert.deepEqual([db.creditAccount("user").credits, db.creditAccount("user").reservedCredits, db.creditAccount("user").usage.creditsSpent], [50, 150, 0]);
        assert.throws(() => db.reserveCredit({ ...r, id: "other" }), /预扣需要/);
        assert.throws(() => db.settleCredit(r.id, 60), /证据/);
        db.recordBilling({ ...r, taskId: "provider-1", actualDurationMs: 6000, quantity: 6, media: { sha256: "verified" } }, "media-verified");
        raw.exec("CREATE TRIGGER simulate_failure BEFORE INSERT ON billing_events WHEN NEW.event_type='confirmed' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
        assert.throws(() => db.settleCredit(r.id, 60), /simulated/);
        assert.equal(db.creditAccount("user").credits, 50);
        assert.equal(db.getBillingReceipt("user", "bill").status, "pending");
        assert.equal(db.creditPostings("user").length, 2);
        raw.exec("DROP TRIGGER simulate_failure");
        const settled = db.settleCredit(r.id, 60);
        assert.deepEqual([settled.confirmedCost, settled.returnedCost], [60, 90]);
        db.settleCredit(r.id, 60);
        db.releaseCredit(r.id);
        db.recordBilling(r, "stale-poll");
        assert.deepEqual([db.creditAccount("user").credits, db.creditAccount("user").reservedCredits, db.creditAccount("user").usage.creditsSpent], [140, 0, 60]);
        assert.equal(db.billingEvents(r.id).filter((e) => e.event === "difference-returned").length, 1);
        db.close(); db = createServerDatabase(file);
        db.initializeCredits({ ...user, credits: 999 });
        assert.equal(db.creditAccount("user").credits, 140);
        assert.equal(db.getBillingReceipt("user", "bill").status, "completed");
        assert.equal(db.associateProviderTask("bill", "namespace", "provider-1"), true);
        assert.equal(db.associateProviderTask("bill", "namespace", "provider-1"), true);
        assert.equal(db.associateProviderTask("bill", "namespace", "different-task"), false);
        assert.equal(db.associateProviderTask("bill", "different-namespace", "provider-1"), false);
        db.reserveCredit({ ...r, id: "another-user-bill", generationTaskId: "internal-2", cost: 0 });
        assert.equal(db.associateProviderTask("another-user-bill", "namespace", "provider-1"), false);
        assert.equal(db.associateProviderTask("missing", "namespace", "unclaimed"), false);
        db.adjustCredits("user", 2.5, "adjust1", "admin", "test credit");
        db.adjustCredits("user", 2.5, "adjust1", "admin", "test credit");
        assert.equal(db.creditAccount("user").credits, 142.5);
        assert.throws(() => db.adjustCredits("user", 3, "adjust1", "admin", "test credit"), /冲突/);
    } finally { raw.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("channel changes preserve original credentials and archived channels reject reservations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-history-"));
    const db = createServerDatabase(path.join(dir, "db.sqlite"));
    try {
        db.initializeCredits({ id: "u", credits: 200 });
        const channel = { id: "c", name: "original", apiKey: "old-test-secret", baseUrl: "https://provider.test", apiFormat: "openai", models: [{ name: "video", capability: "video" }] };
        const old = db.registerChannelRevision(channel);
        const current = db.registerChannelRevision({ ...channel, apiKey: "new-test-secret", baseUrl: "https://other.test" });
        assert.equal(db.resolveChannelRevision(old).apiKey, "old-test-secret");
        assert.equal(db.resolveChannelRevision(old).baseUrl, "https://provider.test");
        db.archiveChannel("c", true, "admin");
        assert.throws(() => db.reserveCredit({ id: "r", userId: "u", channelId: "c", channelRevisionId: current, cost: 150 }), /渠道配置/);
        assert.equal(db.creditAccount("u").credits, 200);
        db.revokeChannelCredentials("c", "admin");
        assert.throws(() => db.resolveChannelRevision(old), /凭据不可用/);
        db.registerChannelRevision(channel);
        assert.throws(() => db.resolveChannelRevision(old), /凭据不可用/, "restart/registration must not reactivate revoked keys");
        assert.ok(!JSON.stringify(db.channelHistory("c")).includes("old-test-secret"));
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("decimal amounts use integer arithmetic", () => {
    assert.equal(creditUnits("0.000001"), 1);
    assert.equal(durationCost("0.1", 6000), 0.6);
    assert.equal(durationCost("10", 6042), 60.42);
    assert.throws(() => creditUnits("0.0000001"));
    assert.throws(() => durationCost(10, NaN));
});
