import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { downloadVideo } from "./video-delivery.mjs";

async function fixture(t, handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return { baseUrl, apiKey: "test-credential" };
}

test("extended download deadline covers the response body and reports actual bytes", async (t) => {
    const channel = await fixture(t, (_req, res) => {
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "8" });
        res.write("first");
        const timer = setTimeout(() => res.end("end"), 350);
        res.on("close", () => clearTimeout(timer));
    });
    const options = { assertSafeUrl: async () => {}, maximumBytes: 100 };
    await assert.rejects(downloadVideo(channel.baseUrl, channel, { ...options, timeoutMs: 150 }), (error) => error.name === "AbortError" || error.name === "TimeoutError");
    const progress = [];
    const result = await downloadVideo(channel.baseUrl, channel, { ...options, timeoutMs: 1500, onProgress: (value) => progress.push(value) });
    assert.equal(result.toString(), "firstend");
    assert.ok(progress.some(p => p.receivedBytes === 5 && p.totalBytes === 8));
    assert.deepEqual(progress.at(-1), { receivedBytes: 8, totalBytes: 8 });
});

test("streamed oversized media is stopped even without Content-Length", async (t) => {
    const channel = await fixture(t, (_req, res) => { res.writeHead(200, { "Content-Type": "video/mp4" }); res.end("too-large"); });
    await assert.rejects(downloadVideo(channel.baseUrl, channel, { assertSafeUrl: async () => {}, maximumBytes: 4 }), /大小上限/);
});

test("redirect downloads validate each address and do not forward provider credentials", async (t) => {
    const target = await fixture(t, (req, res) => { assert.equal(req.headers.authorization, undefined); res.end("video"); });
    const channel = await fixture(t, (req, res) => { assert.equal(req.headers.authorization, "Bearer test-credential"); res.writeHead(302, { Location: target.baseUrl }); res.end(); });
    const checked = [];
    const result = await downloadVideo(channel.baseUrl, channel, { assertSafeUrl: async (url) => { checked.push(url.origin); }, maximumBytes: 100 });
    assert.equal(result.toString(), "video");
    assert.deepEqual(checked, [channel.baseUrl, target.baseUrl]);
});
