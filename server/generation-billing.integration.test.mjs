import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("video reservations, free polling, delivery confirmation, refunds and image deduplication", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-billing-http-"));
    const videoFile = path.join(dir, "fixture.mp4");
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=64x64:r=25:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoFile], { windowsHide: true, timeout: 30000 });
    const video = fs.readFileSync(videoFile);
    const calls = [];
    const states = new Map();
    let releaseSlow;
    const slow = new Promise((resolve) => { releaseSlow = resolve; });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const upstream = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString();
        calls.push({ method: req.method, url: req.url, body: raw });
        if (req.url === "/result.mp4") { res.setHeader("Content-Type", "video/mp4"); return res.end(video); }
        res.setHeader("Content-Type", "application/json");
        if (req.url.includes("/images/")) return res.end(JSON.stringify({ data: [{ b64_json: png }] }));
        if (req.method === "POST") {
            const body = JSON.parse(raw);
            if (body.prompt === "slow") await slow;
            if (body.prompt === "reject") { res.statusCode = 400; return res.end('{"error":"invalid request"}'); }
            if (body.prompt === "uncertain") { res.statusCode = 503; return res.end('{"error":"provider unavailable"}'); }
            return res.end(JSON.stringify({ id: body.prompt, status: "queued" }));
        }
        const taskId = req.url.split("/")[3];
        const state = states.get(taskId) || "running";
        if (state === "temporary") { res.statusCode = 503; return res.end('{"error":"temporary"}'); }
        return res.end(JSON.stringify({ id: taskId, status: state, ...(state === "completed" ? { video_url: `http://127.0.0.1:${upstreamPort}/result.mp4` } : {}) }));
    });
    const upstreamPort = await listen(upstream);
    const portProbe = http.createServer();
    const port = await listen(portProbe);
    await new Promise((resolve) => portProbe.close(resolve));
    let output = "";
    let db;
    const child = spawn(process.execPath, ["index.mjs"], {
        cwd: serverDir,
        env: { ...process.env, PORT: String(port), DATA_DIR: dir, NODE_ENV: "production", AUTH_SECRET: "billing-test-secret-with-at-least-32-characters", ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "strong-admin-password", PRICE_VIDEO: "10", PRICE_IMAGE: "2" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    t.after(async () => {
        releaseSlow();
        if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once("close", resolve)); }
        await new Promise((resolve) => upstream.close(resolve));
        db?.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i += 1) {
        try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
        assert.equal(child.exitCode, null, output);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    async function request(route, { cookie, body, headers, method = body === undefined ? "GET" : "POST" } = {}) {
        const res = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}), ...headers }, body });
        return { status: res.status, data: await res.json(), cookie: res.headers.get("set-cookie")?.split(";")[0] };
    }
    const admin = await request("/api/auth/login", { body: JSON.stringify({ username: "admin", password: "strong-admin-password" }) });
    assert.equal(admin.status, 200, output);
    db = new DatabaseSync(path.join(dir, "server.sqlite"));
    const channel = await request("/api/admin/channels", { cookie: admin.cookie, body: JSON.stringify({ name: "billing mock", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "mock-secret", apiFormat: "openai", models: [{ name: "video-model", capability: "video" }, { name: "image-model", capability: "image" }] }) });
    const channelId = channel.data.channel.id;
    async function user(username, credits) {
        assert.equal((await request("/api/admin/users", { cookie: admin.cookie, body: JSON.stringify({ username, credits, permissions: ["video", "image"], password: "strong-user-password" }) })).status, 200);
        return (await request("/api/auth/login", { body: JSON.stringify({ username, password: "strong-user-password" }) })).cookie;
    }
    const cookie = await user("billing_user", 10);
    const otherCookie = await user("billing_other", 100);
    const me = async (session = cookie) => (await request("/api/auth/me", { cookie: session })).data.user;
    const receipts = (username = "billing_user") => {
        const userId = JSON.parse(fs.readFileSync(path.join(dir, "users.json"))).find((u) => u.username === username).id;
        return db.prepare("SELECT payload_json FROM billing_ledger WHERE user_id=? ORDER BY created_at").all(userId).map((r) => JSON.parse(r.payload_json));
    };
    const videoPath = `/api/ai/${channelId}/v1/videos`;
    const videoHeaders = { "X-Infinite-Canvas-Model": "video-model", "Idempotency-Key": "video-request-000001" };
    const create = (prompt, session = cookie, key = videoHeaders["Idempotency-Key"]) => request(videoPath, { cookie: session, headers: { ...videoHeaders, "Idempotency-Key": key }, body: JSON.stringify({ model: "video-model", prompt }) });
    const poll = (id, session = cookie) => request(`${videoPath}/${id}`, { cookie: session, headers: { "X-Infinite-Canvas-Model": "video-model" } });
    const ack = (id, session = cookie, bytes = 100) => request(`/api/video-tasks/${channelId}/${id}/ack`, { cookie: session, body: JSON.stringify({ bytes }) });

    const first = create("slow");
    for (let i = 0; i < 100 && !calls.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 1);
    assert.equal((await create("slow")).data.code, "GENERATION_PENDING");
    assert.equal((await me()).credits, 0);
    releaseSlow();
    assert.equal((await first).data.id, "slow");
    assert.equal((await create("slow")).data.id, "slow");
    assert.equal(calls.filter((r) => r.method === "POST").length, 1);
    assert.equal((await create("different")).data.code, "GENERATION_CONFLICT");
    assert.equal(receipts().length, 1);
    assert.equal(receipts()[0].taskId, "slow");
    assert.equal(receipts()[0].status, "pending");
    assert.equal((await ack("slow")).status, 409);
    for (let i = 0; i < 12; i += 1) assert.equal((await poll("slow")).status, 200);
    states.set("slow", "temporary");
    assert.equal((await poll("slow")).status, 503);
    assert.equal(receipts()[0].refunded, false);
    assert.equal((await me()).credits, 0);
    states.set("slow", "completed");
    await poll("slow");
    assert.equal(receipts()[0].status, "pending", "provider success alone must not confirm delivery");
    assert.equal((await ack("slow", cookie, 0)).status, 409, "client bytes cannot establish verified delivery");
    assert.equal((await ack("slow", otherCookie)).status, 404, "another account cannot confirm this receipt");
    assert.equal(receipts()[0].status, "pending");
    for (let i = 0; i < 200; i++) {
        await request(`/api/video-tasks/${channelId}/slow`, { cookie });
        if (receipts()[0].status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(receipts()[0].status, "completed", output + JSON.stringify(receipts()[0]));
    const deliveredTask = (await request(`/api/video-tasks/${channelId}/slow`, { cookie })).data.task;
    assert.equal(deliveredTask.phase, "persisted");
    assert.equal(deliveredTask.receivedBytes, video.length);
    assert.equal((await ack("slow")).status, 200);
    assert.equal((await ack("slow")).status, 200);
    assert.equal(receipts()[0].status, "completed");
    states.set("slow", "failed");
    await poll("slow");
    assert.equal(receipts()[0].refunded, false, "a later retrieval failure cannot refund a confirmed delivery");
    assert.equal((await me()).usage.video, 1);
    assert.equal(receipts().length, 1);

    assert.equal((await create("failed-task", otherCookie)).status, 200, "request keys are isolated by account");
    states.set("failed-task", "failed");
    await poll("failed-task", otherCookie);
    assert.equal((await me(otherCookie)).credits, 100);
    assert.equal((await poll("failed-task", otherCookie)).status, 409);
    assert.equal((await ack("failed-task", otherCookie)).status, 409);
    assert.equal((await me(otherCookie)).credits, 100);
    await create("reject", otherCookie, "video-rejected-000001");
    assert.equal((await me(otherCookie)).credits, 100, "explicit creation rejection refunds the reservation");
    await create("uncertain", otherCookie, "video-uncertain-00001");
    assert.equal((await me(otherCookie)).credits, 90, "ambiguous provider errors retain the reservation");

    const imagePath = `/api/image-tasks/${channelId}/edits`;
    function multipart(prompt = "image") {
        const body = new FormData();
        body.append("model", "image-model");
        body.append("prompt", prompt);
        body.append("image", new Blob([Buffer.from(png, "base64")], { type: "image/png" }), "reference.png");
        return body;
    }
    const submitImage = (body) => request(imagePath, { cookie: otherCookie, headers: { "X-Infinite-Canvas-Model": "image-model", "Idempotency-Key": "image-request-000001" }, body });
    const image = await submitImage(multipart());
    assert.equal(image.status, 202);
    assert.equal((await submitImage(multipart())).data.task.id, image.data.task.id, "new multipart boundaries must replay the same task");
    assert.equal((await submitImage(multipart("different"))).status, 409);
    for (let i = 0; i < 100; i += 1) {
        const state = await request(`/api/image-tasks/${image.data.task.id}`, { cookie: otherCookie });
        if (state.data.task.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (let i = 0; i < 3; i += 1) assert.equal((await request(`/api/image-tasks/${image.data.task.id}/result`, { cookie: otherCookie })).status, 200);
    const imageReceipts = receipts("billing_other").filter((r) => r.kind === "image");
    assert.equal(imageReceipts.length, 1);
    assert.equal(imageReceipts[0].taskId, image.data.task.id);
    assert.equal(imageReceipts[0].status, "completed");
    assert.equal(calls.filter((r) => r.url.includes("/images/")).length, 1);
    assert.equal((await me(otherCookie)).credits, 88);

    const ledger = await request("/api/admin/billing-ledger", { cookie: admin.cookie });
    assert.equal(ledger.status, 200);
    assert.equal(ledger.data.total, 5);
    const confirmed = ledger.data.items.find((item) => item.taskId === "slow");
    assert.equal(confirmed.userId, (await me()).id);
    assert.equal(confirmed.unitPrice, 10);
    assert.equal(confirmed.cost, 10);
    assert.equal(confirmed.quantity, 1);
    assert.equal(confirmed.kind, "video");
    assert.equal(confirmed.model, "video-model");
    assert.ok(confirmed.createdAt);
    assert.ok(confirmed.confirmedAt);
    const history = await request(`/api/admin/billing-ledger/${confirmed.id}/events`, { cookie: admin.cookie });
    assert.equal(history.data.events.filter((event) => event.event === "precharged").length, 1);
    assert.equal(history.data.events.filter((event) => event.event === "confirmed").length, 1);
    assert.ok(history.data.events.some((event) => event.event === "download-started"));
    assert.ok(history.data.events.some((event) => event.event === "download-completed" && event.receipt.delivery.phase === "verifying"));
    assert.equal(history.data.events[0].receipt.status, "pending", "event snapshots must not change after confirmation");
    assert.equal(history.data.events.at(-1).receipt.taskId, "slow");
    const filtered = await request("/api/admin/billing-ledger?taskId=slow&status=completed&limit=1", { cookie: admin.cookie });
    assert.equal(filtered.data.total, 1);
    assert.equal(filtered.data.items[0].id, confirmed.id);
    assert.equal((await request("/api/admin/billing-ledger?from=invalid", { cookie: admin.cookie })).status, 400);
    assert.equal((await request("/api/admin/billing-ledger", { cookie })).status, 403);
    assert.equal((await request(`/api/admin/billing-ledger/${confirmed.id}/events`, { cookie })).status, 403);
    const ownLedger = await request(`/api/billing/ledger?userId=${encodeURIComponent((await me(otherCookie)).id)}`, { cookie });
    assert.equal(ownLedger.data.total, 1, "a supplied foreign user ID must never change the account scope");
    assert.ok(ownLedger.data.items.every((item) => item.userId === confirmed.userId));
    assert.equal((await request(`/api/billing/ledger/${confirmed.id}/events`, { cookie })).data.events.length, history.data.events.length);
    assert.equal((await request(`/api/billing/ledger/${confirmed.id}/events`, { cookie: otherCookie })).status, 404);
    assert.equal((await request("/api/billing/ledger")).status, 401);
    const foreignTask = await request("/api/billing/ledger?taskId=slow", { cookie: otherCookie });
    assert.equal(foreignTask.data.total, 0);

    assert.equal((await request("/api/admin/settings", { cookie: admin.cookie, method: "PUT", body: JSON.stringify({ videoPricingUnit: "second" }) })).status, 200);
    const secondsCookie = await user("seconds_user", 200);
    const quote = await request(`/api/billing/video-quote/${channelId}?model=video-model`, { cookie: secondsCookie });
    assert.equal(quote.data.reservedCost, 150);
    const secondsHeaders = { ...videoHeaders, "Idempotency-Key": "seconds-request-00001", "X-Billing-Quote": quote.data.token };
    const body = JSON.stringify({ model: "video-model", prompt: "seconds-task", seconds: 6 });
    assert.equal((await request(videoPath, { cookie: secondsCookie, headers: secondsHeaders, body })).status, 200);
    assert.deepEqual([(await me(secondsCookie)).credits, (await me(secondsCookie)).reservedCredits], [50, 150]);
    assert.equal((await request(videoPath, { cookie: secondsCookie, headers: secondsHeaders, body })).status, 200);
    assert.equal((await request(`/api/admin/channels/${channelId}`, { cookie: admin.cookie, method: "DELETE" })).status, 409);
    assert.equal((await request(`/api/admin/channels/${channelId}`, { cookie: admin.cookie, method: "PATCH", body: JSON.stringify({ baseUrl: "http://127.0.0.1:1", apiKey: "changed-secret", archived: true }) })).status, 200);
    assert.equal((await request(videoPath, { cookie: secondsCookie, headers: secondsHeaders, body })).data.id, "seconds-task", "accepted submissions replay even after a channel is archived");
    states.set("seconds-task", "completed");
    for (let i = 0; i < 200; i++) {
        await request(`/api/video-tasks/${channelId}/seconds-task`, { cookie: secondsCookie });
        if (receipts("seconds_user")[0].status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const secondBill = receipts("seconds_user")[0];
    assert.equal(secondBill.status, "completed", JSON.stringify(secondBill) + output);
    assert.equal(secondBill.actualDurationMs, 6000);
    assert.deepEqual([secondBill.reservedCost, secondBill.confirmedCost, secondBill.returnedCost], [150, 60, 90]);
    assert.deepEqual([(await me(secondsCookie)).credits, (await me(secondsCookie)).reservedCredits], [140, 0]);
    assert.equal((await ack("seconds-task", secondsCookie)).status, 200);
    assert.equal((await ack("seconds-task", secondsCookie)).status, 200);
    assert.equal((await me(secondsCookie)).credits, 140);
    const media = await fetch(`${base}/api/video-tasks/${channelId}/seconds-task/media`, { headers: { Cookie: secondsCookie } });
    assert.equal(media.status, 200);
    assert.equal((await media.arrayBuffer()).byteLength, video.length);
    assert.equal((await fetch(`${base}/api/video-tasks/${channelId}/seconds-task/media`, { headers: { Cookie: otherCookie } })).status, 404);
});
