import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { Agent } from "undici";
import timers from "undici/lib/util/timers.js";
import { createAiDispatcher } from "./ai-transport.mjs";

async function heldRequest(t, dispatcher, mode, signal) {
    let respond;
    const received = new Promise((resolve) => { respond = resolve; });
    const server = http.createServer((_req, res) => {
        if (mode === "body") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.write("image-");
        }
        respond(res);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        await dispatcher.destroy();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        timers.reset();
    });
    const request = fetch(`http://127.0.0.1:${server.address().port}`, { dispatcher, signal });
    request.catch(() => {});
    const response = await received;
    const result = mode === "body" ? (await request).text() : request.then((r) => r.text());
    result.catch(() => {});
    await nextTurn();
    timers.tick(1);
    return { result, response };
}

for (const mode of ["headers", "body"]) {
    test(`default transport reproduces five-minute ${mode} cutoff`, async (t) => {
        const { result } = await heldRequest(t, new Agent(), mode);
        timers.tick(610_000);
        await assert.rejects(result, (error) => error.cause?.code === (mode === "headers" ? "UND_ERR_HEADERS_TIMEOUT" : "UND_ERR_BODY_TIMEOUT"));
    });

    test(`configured transport accepts ${mode} after 610 seconds`, async (t) => {
        const { result, response } = await heldRequest(t, createAiDispatcher(1_200_000), mode);
        // Advance the transport's test clock, without waiting ten real minutes.
        timers.tick(610_000);
        await nextTurn();
        response.end("done");
        assert.equal(await result, mode === "body" ? "image-done" : "done");
    });

    test(`configured transport still enforces ${mode} deadline`, async (t) => {
        const { result } = await heldRequest(t, createAiDispatcher(1_200_000), mode);
        timers.tick(1_201_000);
        await assert.rejects(result, (error) => error.cause?.code === (mode === "headers" ? "UND_ERR_HEADERS_TIMEOUT" : "UND_ERR_BODY_TIMEOUT"));
    });
}

test("manual cancellation still interrupts a long upstream wait", async (t) => {
    const controller = new AbortController();
    const { result } = await heldRequest(t, createAiDispatcher(1_200_000), "headers", controller.signal);
    controller.abort();
    await assert.rejects(result, { name: "AbortError" });
});

test("the overall AbortSignal deadline still interrupts a long upstream wait", async (t) => {
    const { result } = await heldRequest(t, createAiDispatcher(1_200_000), "headers", AbortSignal.timeout(300));
    await assert.rejects(result, { name: "TimeoutError" });
});
