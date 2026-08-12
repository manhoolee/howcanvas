import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServerDatabase, legacyDocumentIsNewer } from "./database.mjs";

const serverDir = path.dirname(fileURLToPath(import.meta.url));

test("只有更新的旧 JSON 文档才能补进 SQLite", () => {
    assert.equal(legacyDocumentIsNewer("2026-08-01T00:00:01.000Z", "2026-08-01T00:00:00.000Z"), true);
    assert.equal(legacyDocumentIsNewer("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:01.000Z"), false);
    assert.equal(legacyDocumentIsNewer("", "2026-08-01T00:00:01.000Z"), false);
    assert.equal(legacyDocumentIsNewer("2026-08-01T00:00:01.000Z", ""), true);
});

test("媒体索引按账号和作用域隔离并只在内容变化时升级版本", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-media-index-"));
    const database = createServerDatabase(path.join(directory, "server.sqlite"));
    try {
        const base = { userId: "user-a", scope: "canvas", storageKey: "image:test", bytes: 12, mimeType: "image/png", sha256: "hash-a", updatedAt: "2026-08-02T00:00:00.000Z" };
        assert.equal(database.upsertMediaAsset(base).version, 1);
        assert.equal(database.upsertMediaAsset({ ...base, updatedAt: "2026-08-02T00:01:00.000Z" }).version, 1);
        assert.equal(database.upsertMediaAsset({ ...base, sha256: "hash-b", updatedAt: "2026-08-02T00:02:00.000Z" }).version, 2);
        database.upsertMediaAsset({ ...base, userId: "user-b" });
        assert.equal(database.listMediaAssets("user-a").length, 1);
        assert.equal(database.listMediaAssets("user-b").length, 1);
    } finally {
        database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
}

async function freePort() {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function waitForServer(baseUrl, child, output) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`后端提前退出（${child.exitCode}）\n${output()}`);
        try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) return;
        } catch {
            // 等待端口就绪
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`等待后端启动超时\n${output()}`);
}

async function request(baseUrl, pathname, { cookie = "", headers = {}, body, method = body === undefined ? "GET" : "POST" } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
            ...headers,
        },
        body,
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
    return { status: response.status, data, headers: response.headers, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || "" };
}

test("服务端安全边界：注册、权限、AI 允许列表、计费回滚与上传类型", async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-security-"));
    const upstreamRequests = [];
    const mockPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    let upstreamBaseUrl = "";
    const upstream = http.createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/generated.png") {
            res.writeHead(200, { "Content-Type": "image/png", "Content-Length": mockPng.length });
            res.end(mockPng);
            return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        upstreamRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, headers: req.headers, body });
        if (body.includes('"prompt":"fail"')) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "mock failure" }));
            return;
        }
        if (body.includes('"prompt":"base64"')) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data: [{ b64_json: mockPng.toString("base64") }] }));
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ url: `${upstreamBaseUrl}/generated.png` }] }));
    });
    const upstreamPort = await listen(upstream);
    upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
    const port = await freePort();
    let childOutput = "";
    const child = spawn(process.execPath, ["index.mjs"], {
        cwd: serverDir,
        env: {
            ...process.env,
            PORT: String(port),
            DATA_DIR: dataDir,
            NODE_ENV: "production",
            AUTH_SECRET: "test-auth-secret-that-is-longer-than-32-characters",
            ADMIN_USERNAME: "admin",
            ADMIN_PASSWORD: "strong-admin-password",
            ALLOW_REGISTRATION: "false",
            PRICE_IMAGE: "2",
            MAX_TEXT_ASSET_BYTES: "65536",
            GROK_AIOHTTP_PYTHON: process.env.GROK_AIOHTTP_TEST_PYTHON || process.execPath,
            GROK_AIOHTTP_HELPER: process.env.GROK_AIOHTTP_TEST_PYTHON
                ? path.join(serverDir, "grok_request.py")
                : path.join(serverDir, "grok_request.test-helper.mjs"),
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { childOutput += chunk; });
    child.stderr.on("data", (chunk) => { childOutput += chunk; });

    t.after(async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        if (child.exitCode === null) await new Promise((resolve) => child.once("close", resolve));
        await new Promise((resolve) => upstream.close(resolve));
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, child, () => childOutput);

    const config = await request(baseUrl, "/api/auth/config");
    assert.equal(config.status, 200);
    assert.equal(config.data.registrationEnabled, false);
    const firstVisit = await request(baseUrl, "/api/landing/visits", { method: "POST" });
    assert.equal(firstVisit.status, 201);
    assert.equal(firstVisit.data.visits, 1001);
    const secondVisit = await request(baseUrl, "/api/landing/visits", { method: "POST" });
    assert.equal(secondVisit.status, 201);
    assert.equal(secondVisit.data.visits, 1002);
    const closedRegistration = await request(baseUrl, "/api/auth/register", { body: JSON.stringify({ username: "visitor", password: "very-strong-password" }) });
    assert.equal(closedRegistration.status, 403);

    const loginAdmin = await request(baseUrl, "/api/auth/login", { body: JSON.stringify({ username: "admin", password: "strong-admin-password" }) });
    assert.equal(loginAdmin.status, 200);
    assert.ok(loginAdmin.cookie);

    const invalidUsername = await request(baseUrl, "/api/admin/users", {
        cookie: loginAdmin.cookie,
        body: JSON.stringify({ username: "a/b", password: "very-strong-password" }),
    });
    assert.equal(invalidUsername.status, 400);

    async function createUser(username, permissions) {
        const created = await request(baseUrl, "/api/admin/users", {
            cookie: loginAdmin.cookie,
            body: JSON.stringify({ username, password: "very-strong-password", permissions, credits: 10 }),
        });
        assert.equal(created.status, 200);
        return created.data.user;
    }
    await createUser("restricted", []);
    const imageUser = await createUser("image_user", ["image", "assets"]);

    const channelResponse = await request(baseUrl, "/api/admin/channels", {
        cookie: loginAdmin.cookie,
        body: JSON.stringify({
            name: "mock",
            baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
            apiKey: "upstream-secret",
            apiFormat: "openai",
            models: [{ name: "image-model", capability: "image" }],
        }),
    });
    assert.equal(channelResponse.status, 200);
    const channelId = channelResponse.data.channel.id;

    const invalidGrokChannel = await request(baseUrl, "/api/admin/channels", {
        cookie: loginAdmin.cookie,
        body: JSON.stringify({
            name: "invalid-grok",
            baseUrl: `http://127.0.0.1:${upstreamPort}`,
            apiKey: "upstream-secret",
            apiFormat: "grok-video-v2",
            models: [{ name: "another-video-model", capability: "video" }],
        }),
    });
    assert.equal(invalidGrokChannel.status, 400);

    const grokChannelResponse = await request(baseUrl, "/api/admin/channels", {
        cookie: loginAdmin.cookie,
        body: JSON.stringify({
            name: "grok-v2",
            baseUrl: `http://127.0.0.1:${upstreamPort}`,
            apiKey: "grok-upstream-secret",
            apiFormat: "grok-video-v2",
            models: [{ name: "grok-video-3", capability: "video" }],
        }),
    });
    assert.equal(grokChannelResponse.status, 200);
    const grokChannelId = grokChannelResponse.data.channel.id;

    const minimaxChannelResponse = await request(baseUrl, "/api/admin/channels", {
        cookie: loginAdmin.cookie,
        body: JSON.stringify({
            name: "minimax-h3",
            baseUrl: upstreamBaseUrl,
            apiKey: "minimax-upstream-secret",
            apiFormat: "minimax-h3",
            models: [{ name: "MiniMax-H3", capability: "video" }],
        }),
    });
    assert.equal(minimaxChannelResponse.status, 200);
    const minimaxChannelId = minimaxChannelResponse.data.channel.id;

    const invalidMiniMaxChannel = await request(baseUrl, "/api/admin/channels", {
        cookie: loginAdmin.cookie,
        body: JSON.stringify({
            name: "invalid-minimax-h3",
            baseUrl: upstreamBaseUrl,
            apiKey: "minimax-upstream-secret",
            apiFormat: "minimax-h3",
            models: [{ name: "MiniMax-H2", capability: "video" }],
        }),
    });
    assert.equal(invalidMiniMaxChannel.status, 400);

    const validDefaultModel = await request(baseUrl, "/api/admin/settings", {
        cookie: loginAdmin.cookie,
        method: "PUT",
        body: JSON.stringify({ defaultModels: { image: `${channelId}::image-model` } }),
    });
    assert.equal(validDefaultModel.status, 200);
    assert.equal(validDefaultModel.data.settings.defaultModels.image, `${channelId}::image-model`);

    const missingDefaultModel = await request(baseUrl, "/api/admin/settings", {
        cookie: loginAdmin.cookie,
        method: "PUT",
        body: JSON.stringify({ defaultModels: { image: `${channelId}::missing-model` } }),
    });
    assert.equal(missingDefaultModel.status, 400);

    const wrongCapabilityDefaultModel = await request(baseUrl, "/api/admin/settings", {
        cookie: loginAdmin.cookie,
        method: "PUT",
        body: JSON.stringify({ defaultModels: { image: `${grokChannelId}::grok-video-3` } }),
    });
    assert.equal(wrongCapabilityDefaultModel.status, 400);
    const settingsAfterInvalidDefaults = await request(baseUrl, "/api/admin/settings", { cookie: loginAdmin.cookie });
    assert.equal(settingsAfterInvalidDefaults.data.settings.defaultModels.image, `${channelId}::image-model`);

    async function loginUser(username) {
        const result = await request(baseUrl, "/api/auth/login", { body: JSON.stringify({ username, password: "very-strong-password" }) });
        assert.equal(result.status, 200);
        return result.cookie;
    }
    let restrictedCookie = await loginUser("restricted");
    const imageCookie = await loginUser("image_user");

    const sameBrowserLogin = await request(baseUrl, "/api/auth/login", {
        cookie: restrictedCookie,
        body: JSON.stringify({ username: "restricted", password: "very-strong-password" }),
    });
    assert.equal(sameBrowserLogin.status, 200);
    assert.equal((await request(baseUrl, "/api/auth/me", { cookie: restrictedCookie })).status, 200, "同一浏览器重新登录不应踢掉共享会话");
    const otherDeviceLogin = await request(baseUrl, "/api/auth/login", {
        body: JSON.stringify({ username: "restricted", password: "very-strong-password" }),
    });
    assert.equal(otherDeviceLogin.status, 200);
    const replacedSession = await request(baseUrl, "/api/auth/me", { cookie: restrictedCookie });
    assert.equal(replacedSession.status, 401);
    assert.equal(replacedSession.data.code, "SESSION_REPLACED");
    restrictedCookie = otherDeviceLogin.cookie;

    const handshake = await request(baseUrl, "/api/sync/handshake", { cookie: imageCookie });
    assert.equal(handshake.status, 200);
    assert.ok(handshake.data.documents.some((item) => item.domain === "canvas"));
    assert.ok(fs.existsSync(path.join(dataDir, "server.sqlite")));

    const adminWorkbench = await request(baseUrl, "/api/workbench/image", {
        cookie: loginAdmin.cookie,
        method: "PUT",
        body: JSON.stringify({ logs: [{ id: "admin-image-log", createdAt: 1 }] }),
    });
    assert.equal(adminWorkbench.status, 200);
    const crossAccountWorkbench = await request(baseUrl, "/api/workbench/image", {
        cookie: imageCookie,
        method: "PUT",
        body: JSON.stringify({ logs: [{ id: "admin-image-log", createdAt: 1 }, { id: "image-user-log", createdAt: 2 }] }),
    });
    assert.equal(crossAccountWorkbench.status, 200);
    assert.equal(crossAccountWorkbench.data.count, 1);
    assert.equal(crossAccountWorkbench.data.droppedCrossAccount, 1);
    const imageWorkbench = await request(baseUrl, "/api/workbench/image", { cookie: imageCookie });
    assert.deepEqual(imageWorkbench.data.logs.map((log) => log.id), ["image-user-log"]);

    // Production uses Linux; Windows cannot create the namespaced `image:<id>` filenames.
    if (process.platform !== "win32") {
        const adminMedia = await request(baseUrl, "/api/workbench/image/files/image:admin-media", {
            cookie: loginAdmin.cookie,
            method: "PUT",
            headers: { "Content-Type": "image/png" },
            body: Buffer.from("admin-media"),
        });
        assert.equal(adminMedia.status, 200);
        const crossAccountMedia = await request(baseUrl, "/api/workbench/image/files/image:admin-media", {
            cookie: imageCookie,
            method: "PUT",
            headers: { "Content-Type": "image/png" },
            body: Buffer.from("copied-media"),
        });
        assert.equal(crossAccountMedia.status, 409);

        const canvasMediaBody = Buffer.from("canvas-media");
        const canvasMediaPath = "/api/canvas/files/image%3Aadmin-canvas-media";
        const uploadedCanvasMedia = await request(baseUrl, canvasMediaPath, { cookie: loginAdmin.cookie, method: "PUT", headers: { "Content-Type": "image/png" }, body: canvasMediaBody });
        assert.equal(uploadedCanvasMedia.status, 200);
        assert.equal(uploadedCanvasMedia.data.media.scope, "canvas");
        assert.equal(uploadedCanvasMedia.data.media.bytes, canvasMediaBody.length);
        assert.equal(uploadedCanvasMedia.data.media.version, 1);
        const canvasMediaHead = await request(baseUrl, canvasMediaPath, { cookie: loginAdmin.cookie, method: "HEAD" });
        assert.equal(canvasMediaHead.status, 200);
        assert.equal(Number(canvasMediaHead.headers.get("content-length")), canvasMediaBody.length);
        const versionedCanvasMedia = await request(baseUrl, `${canvasMediaPath}?owner=${encodeURIComponent(loginAdmin.data.user.id)}&version=test`, { cookie: loginAdmin.cookie });
        assert.equal(versionedCanvasMedia.status, 200);
        assert.match(versionedCanvasMedia.headers.get("cache-control") || "", /private/);
        assert.equal((await request(baseUrl, `${canvasMediaPath}?owner=another-account&version=test`, { cookie: loginAdmin.cookie })).status, 403);
        const mediaIndex = await request(baseUrl, "/api/media-index", { cookie: loginAdmin.cookie });
        assert.equal(mediaIndex.status, 200);
        assert.equal(mediaIndex.data.ownerId, loginAdmin.data.user.id);
        assert.ok(mediaIndex.data.entries.some((entry) => entry.scope === "canvas" && entry.storageKey === "image:admin-canvas-media" && entry.sha256));
        assert.ok(mediaIndex.data.entries.some((entry) => entry.scope === "workbench-image" && entry.storageKey === "image:admin-media" && entry.sha256));
        const unchangedCanvasMedia = await request(baseUrl, canvasMediaPath, { cookie: loginAdmin.cookie, method: "PUT", headers: { "Content-Type": "image/png" }, body: canvasMediaBody });
        assert.equal(unchangedCanvasMedia.data.media.version, 1);
        const changedCanvasMedia = await request(baseUrl, canvasMediaPath, { cookie: loginAdmin.cookie, method: "PUT", headers: { "Content-Type": "image/png" }, body: Buffer.from("canvas-media-v2") });
        assert.equal(changedCanvasMedia.data.media.version, 2);
        assert.notEqual(changedCanvasMedia.data.media.sha256, uploadedCanvasMedia.data.media.sha256);
        const otherAccountIndex = await request(baseUrl, "/api/media-index", { cookie: imageCookie });
        assert.ok(otherAccountIndex.data.entries.every((entry) => entry.ownerId === imageUser.id));
    }

    assert.equal((await request(baseUrl, "/api/canvas", { cookie: restrictedCookie })).status, 403);
    const proxyPath = `/api/ai/${channelId}/v1/images/generations`;
    const imageBody = JSON.stringify({ model: "image-model", prompt: "ok", response_format: "b64_json" });
    assert.equal((await request(baseUrl, proxyPath, { cookie: restrictedCookie, headers: { "X-Infinite-Canvas-Model": "image-model" }, body: imageBody })).status, 403);
    assert.equal((await request(baseUrl, proxyPath, { cookie: imageCookie, body: imageBody })).status, 403);
    assert.equal((await request(baseUrl, proxyPath, { cookie: imageCookie, headers: { "X-Infinite-Canvas-Model": "another-model" }, body: imageBody })).status, 400);
    assert.equal((await request(baseUrl, `/api/ai/${channelId}/v1/files`, { cookie: imageCookie, headers: { "X-Infinite-Canvas-Model": "image-model" }, body: imageBody })).status, 403);

    const generated = await request(baseUrl, proxyPath, { cookie: imageCookie, headers: { "X-Infinite-Canvas-Model": "image-model" }, body: imageBody });
    assert.equal(generated.status, 200);
    assert.equal(upstreamRequests.at(-1).authorization, "Bearer upstream-secret");
    assert.equal(upstreamRequests.at(-1).url, "/v1/images/generations");
    assert.equal(JSON.parse(upstreamRequests.at(-1).body).response_format, "b64_json");

    const grokBody = JSON.stringify({
        model: "grok-video-3",
        prompt: "@img1 make the subject move",
        ratio: "16:9",
        resolution: "720P",
        duration: 6,
        images: ["data:image/png;base64,aW1hZ2U="],
    });
    const grokCreated = await request(baseUrl, `/api/ai/${grokChannelId}/v2/videos/generations`, {
        cookie: loginAdmin.cookie,
        headers: { "X-Infinite-Canvas-Model": "grok-video-3" },
        body: grokBody,
    });
    assert.equal(grokCreated.status, 200);
    assert.equal(upstreamRequests.at(-1).authorization, "Bearer grok-upstream-secret");
    assert.equal(upstreamRequests.at(-1).url, "/v2/videos/generations");
    assert.deepEqual(JSON.parse(upstreamRequests.at(-1).body).images, ["data:image/png;base64,aW1hZ2U="]);
    assert.equal(upstreamRequests.at(-1).headers.accept, "application/json");
    assert.equal(upstreamRequests.at(-1).headers["user-agent"], "Python/3.11 aiohttp/3.13.5");
    assert.equal(upstreamRequests.at(-1).headers["content-length"], String(Buffer.byteLength(grokBody)));
    assert.equal(upstreamRequests.at(-1).headers["transfer-encoding"], undefined);
    assert.equal(upstreamRequests.at(-1).headers["sec-fetch-mode"], undefined);

    const grokPolled = await request(baseUrl, `/api/ai/${grokChannelId}/v2/videos/generations/grok%3Atask-id`, {
        cookie: loginAdmin.cookie,
        method: "GET",
        headers: { "X-Infinite-Canvas-Model": "grok-video-3" },
    });
    assert.equal(grokPolled.status, 200);
    assert.match(upstreamRequests.at(-1).url, /^\/v2\/videos\/generations\/grok(?::|%3A)task-id$/);

    const grokLegacyRoute = await request(baseUrl, `/api/ai/${grokChannelId}/v1/videos`, {
        cookie: loginAdmin.cookie,
        headers: { "X-Infinite-Canvas-Model": "grok-video-3" },
        body: grokBody,
    });
    assert.equal(grokLegacyRoute.status, 403);

    const minimaxBody = JSON.stringify({ model: "MiniMax-H3", content: [{ type: "text", text: "a calm sea" }], resolution: "2K", duration: 5, ratio: "16:9" });
    const minimaxCreated = await request(baseUrl, `/api/ai/${minimaxChannelId}/v2/video_generation`, {
        cookie: loginAdmin.cookie,
        headers: { "X-Infinite-Canvas-Model": "MiniMax-H3" },
        body: minimaxBody,
    });
    assert.equal(minimaxCreated.status, 200);
    assert.equal(upstreamRequests.at(-1).authorization, "Bearer minimax-upstream-secret");
    assert.equal(upstreamRequests.at(-1).url, "/v2/video_generation");
    assert.equal(JSON.parse(upstreamRequests.at(-1).body).model, "MiniMax-H3");

    const minimaxPolled = await request(baseUrl, `/api/ai/${minimaxChannelId}/v2/query/video_generation/minimax_task-id`, {
        cookie: loginAdmin.cookie,
        method: "GET",
        headers: { "X-Infinite-Canvas-Model": "MiniMax-H3" },
    });
    assert.equal(minimaxPolled.status, 200);
    assert.equal(upstreamRequests.at(-1).url, "/v2/query/video_generation/minimax_task-id");

    const minimaxLegacyRoute = await request(baseUrl, `/api/ai/${minimaxChannelId}/v1/videos`, {
        cookie: loginAdmin.cookie,
        headers: { "X-Infinite-Canvas-Model": "MiniMax-H3" },
        body: minimaxBody,
    });
    assert.equal(minimaxLegacyRoute.status, 403);

    const submittedTask = await request(baseUrl, `/api/image-tasks/${channelId}/generations`, {
        cookie: imageCookie,
        headers: { "X-Infinite-Canvas-Model": "image-model" },
        body: imageBody,
    });
    assert.equal(submittedTask.status, 202);
    assert.equal(submittedTask.data.task.status, "queued");
    const taskId = submittedTask.data.task.id;
    let backgroundTask;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        backgroundTask = await request(baseUrl, `/api/image-tasks/${taskId}`, { cookie: imageCookie });
        if (backgroundTask.data.task?.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(backgroundTask.data.task.status, "succeeded");
    assert.equal(backgroundTask.data.task.phase, "persisted");
    assert.equal(backgroundTask.data.task.deliveryStatus, "pending");
    assert.equal(backgroundTask.data.task.media.length, 1);
    assert.equal(backgroundTask.data.task.media[0].bytes, mockPng.length);
    assert.equal(backgroundTask.data.task.media[0].mimeType, "image/png");
    assert.equal(backgroundTask.data.task.media[0].sha256, crypto.createHash("sha256").update(mockPng).digest("hex"));
    const backgroundResult = await request(baseUrl, `/api/image-tasks/${taskId}/result`, { cookie: imageCookie });
    assert.equal(backgroundResult.status, 200);
    assert.equal(backgroundResult.data.data[0].storageKey, backgroundTask.data.task.media[0].storageKey);
    const taskMedia = await request(baseUrl, backgroundResult.data.data[0].url, { cookie: imageCookie });
    assert.equal(taskMedia.status, 200);
    assert.equal(taskMedia.headers.get("x-file-sha256"), backgroundTask.data.task.media[0].sha256);
    const ack = await request(baseUrl, `/api/image-tasks/${taskId}/ack`, { cookie: imageCookie, body: JSON.stringify({ metrics: { clientElapsedMs: 25 } }) });
    assert.equal(ack.status, 200);
    assert.equal(ack.data.task.deliveryStatus, "delivered");
    assert.ok(ack.data.task.clientAckAt);
    const repeatedAck = await request(baseUrl, `/api/image-tasks/${taskId}/ack`, { cookie: imageCookie, body: JSON.stringify({ metrics: { clientElapsedMs: 99 } }) });
    assert.equal(repeatedAck.data.task.clientAckAt, ack.data.task.clientAckAt);

    const base64Task = await request(baseUrl, `/api/image-tasks/${channelId}/generations`, {
        cookie: imageCookie,
        headers: {
            "X-Infinite-Canvas-Model": "image-model",
            "X-Infinite-Canvas-Context": Buffer.from(JSON.stringify({ surface: "workbench", kind: "image" })).toString("base64url"),
        },
        body: JSON.stringify({ model: "image-model", prompt: "base64", response_format: "b64_json" }),
    });
    assert.equal(base64Task.status, 202);
    let base64TaskState;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        base64TaskState = await request(baseUrl, `/api/image-tasks/${base64Task.data.task.id}`, { cookie: imageCookie });
        if (base64TaskState.data.task?.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(base64TaskState.data.task.status, "succeeded");
    assert.match(base64TaskState.data.task.media[0].url, /^\/api\/workbench\/image\/files\//);
    assert.equal((await request(baseUrl, base64TaskState.data.task.media[0].url, { cookie: imageCookie })).status, 200);
    const generatedMediaIndex = await request(baseUrl, "/api/media-index", { cookie: imageCookie });
    const generatedMediaEntry = generatedMediaIndex.data.entries.find((entry) => entry.storageKey === base64TaskState.data.task.media[0].storageKey);
    assert.equal(generatedMediaEntry.scope, "workbench-image");
    assert.equal(generatedMediaEntry.sha256, base64TaskState.data.task.media[0].sha256);
    assert.equal(generatedMediaEntry.version, 1);
    assert.equal((await request(baseUrl, `/api/image-tasks/${taskId}`, { cookie: loginAdmin.cookie })).status, 404);

    const multipartBoundary = "----WebKitFormBoundaryAbCdEf123";
    const multipartBody = [
        `--${multipartBoundary}`,
        'Content-Disposition: form-data; name="model"',
        "",
        "image-model",
        `--${multipartBoundary}`,
        'Content-Disposition: form-data; name="prompt"',
        "",
        "edit this image",
        `--${multipartBoundary}--`,
        "",
    ].join("\r\n");
    const edited = await request(baseUrl, `/api/ai/${channelId}/v1/images/edits`, {
        cookie: loginAdmin.cookie,
        headers: {
            "Content-Type": `multipart/form-data; boundary=${multipartBoundary}`,
            "X-Infinite-Canvas-Model": "image-model",
        },
        body: multipartBody,
    });
    assert.equal(edited.status, 200);
    assert.equal(upstreamRequests.at(-1).url, "/v1/images/edits");
    assert.match(upstreamRequests.at(-1).body, new RegExp(multipartBoundary));

    const failed = await request(baseUrl, proxyPath, {
        cookie: imageCookie,
        headers: { "X-Infinite-Canvas-Model": "image-model" },
        body: JSON.stringify({ model: "image-model", prompt: "fail" }),
    });
    assert.equal(failed.status, 500);

    const usersAfterProxy = await request(baseUrl, "/api/admin/users", { cookie: loginAdmin.cookie });
    const chargedUser = usersAfterProxy.data.users.find((user) => user.id === imageUser.id);
    assert.equal(chargedUser.credits, 4);
    assert.equal(chargedUser.usage.image, 3);
    assert.equal(chargedUser.usage.creditsSpent, 6);

    const uploaded = await request(baseUrl, "/api/files/upload?kind=image&ext=png", {
        cookie: imageCookie,
        headers: { "Content-Type": "image/png" },
        body: Buffer.from("not-a-real-image"),
    });
    assert.equal(uploaded.status, 200);
    assert.match(uploaded.data.path, new RegExp(`^users/${imageUser.id}/images/`));
    assert.ok(!uploaded.data.path.includes("image_user"));

    const invalidAsset = await request(baseUrl, "/api/assets?kind=image&ext=html", {
        cookie: imageCookie,
        headers: { "Content-Type": "text/html" },
        body: Buffer.from("<script>alert(1)</script>"),
    });
    assert.equal(invalidAsset.status, 400);

    const workbenchHtml = await request(baseUrl, "/api/workbench/image/files/image%3Atest", {
        cookie: imageCookie,
        method: "PUT",
        headers: { "Content-Type": "text/html" },
        body: Buffer.from("<script>alert(1)</script>"),
    });
    assert.equal(workbenchHtml.status, 415);

    const channelWithoutDefaultModel = await request(baseUrl, `/api/admin/channels/${channelId}`, {
        cookie: loginAdmin.cookie,
        method: "PATCH",
        body: JSON.stringify({ models: [] }),
    });
    assert.equal(channelWithoutDefaultModel.status, 200);
    const settingsAfterModelRemoval = await request(baseUrl, "/api/admin/settings", { cookie: loginAdmin.cookie });
    assert.equal(settingsAfterModelRemoval.data.settings.defaultModels.image, "");

    const logout = await request(baseUrl, "/api/auth/logout", { cookie: imageCookie, method: "POST" });
    assert.equal(logout.status, 200);
    assert.equal((await request(baseUrl, "/api/auth/me", { cookie: imageCookie })).status, 401);
});
