import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
test("monitoring authorization, source-backed generation, filters, controls and persistent worker recovery", async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "canvas-monitor-integration-"),
  );
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  let calls = 0;
  const provider = http.createServer(async (req, res) => {
    calls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    if (body.includes("test-failure")) {
      res.writeHead(500);
      res.end('{"error":"secret-prompt sk-never-export"}');
    } else res.end(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  const upstream = await listen(provider),
    probe = http.createServer(),
    port = await listen(probe);
  await new Promise((r) => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  let child,
    output = "";
  const start = async () => {
    child = spawn(process.execPath, [fileURLToPath(new URL("./index.mjs", import.meta.url))], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        NODE_ENV: "production",
        AUTH_SECRET: "integration-secret-at-least-thirty-two-chars",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "test-long-password",
        PRICE_IMAGE: "2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/api/health")).ok) return;
      } catch {}
      await sleep(50);
    }
    throw new Error(output);
  };
  t.after(async () => {
    child?.kill();
    if (child?.exitCode === null)
      await new Promise((r) => child.once("close", r));
    await new Promise((r) => provider.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  const req = async (route, cookie = "", body) => {
    const r = await fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body
          ? {
              "Content-Type": "application/json",
              ...(body.model ? { "X-Infinite-Canvas-Model": body.model } : {}),
            }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return {
      status: r.status,
      data,
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const login = async (username) =>
    (
      await req("/api/auth/login", "", {
        username,
        password: "test-long-password",
      })
    ).cookie;
  let admin = await login("admin");
  assert.ok(admin);
  const created = await req("/api/admin/users", admin, {
    username: "creator",
    password: "test-long-password",
    permissions: ["image"],
    credits: 100,
  });
  assert.equal(created.status, 200);
  const uid = created.data.user.id,
    user = await login("creator");
  assert.equal((await req("/api/admin/observability/overview")).status, 401);
  assert.equal(
    (await req("/api/admin/observability/overview", user)).status,
    403,
  );
  assert.equal(
    (
      await req("/api/admin/observability/actions", user, {
        action: "resync",
        reason: "验收",
      })
    ).status,
    403,
  );
  const ch = await req("/api/admin/channels", admin, {
    name: "test-channel",
    apiKey: "sk-local-fake-only",
    baseUrl: `http://127.0.0.1:${upstream}/v1`,
    apiFormat: "openai",
    models: [{ name: "test-image", capability: "image" }],
  });
  assert.equal(ch.status, 200);
  const cid = ch.data.channel.id;
  for (const tabId of ["tab-a", "tab-b"])
    assert.equal(
      (
        await req("/api/telemetry/heartbeat", user, {
          tabId,
          page: "/canvas/test-secret",
          visible: true,
          active: true,
        })
      ).status,
      200,
    );
  await sleep(1050);
  let live = (await req("/api/admin/observability/snapshot", admin)).data;
  assert.equal(live.online, 1);
  assert.equal(live.people[0].page, "canvas");
  const action = async (action, extra = {}) =>
    req("/api/admin/observability/actions", admin, {
      action,
      reason: "自动验收",
      ...extra,
    });
  assert.equal(
    (
      await req("/api/admin/observability/actions", admin, {
        action: "image-limit",
        value: 3,
      })
    ).status,
    400,
  );
  assert.equal((await action("image-limit", { value: 3 })).status, 200);
  assert.equal((await action("image-limit", { value: 99 })).status, 400);
  assert.equal((await action("pause-channel", { id: cid })).status, 200);
  const submit = (prompt) =>
    req(`/api/image-tasks/${cid}/generations`, user, {
      model: "test-image",
      prompt,
      n: 1,
    });
  assert.equal((await submit("success")).status, 409);
  assert.equal(calls, 0);
  assert.equal((await action("resume-channel", { id: cid })).status, 200);
  const ids = [];
  for (const prompt of ["success", "test-failure"]) {
    const r = await submit(prompt);
    assert.equal(r.status, 202);
    ids.push(r.data.task.id);
    for (let i = 0; i < 100; i++) {
      const s = await req(`/api/image-tasks/${r.data.task.id}`, user);
      if (["succeeded", "failed"].includes(s.data.task.status)) break;
      await sleep(50);
    }
  }
  await action("resync");
  let report = (await req("/api/admin/observability/overview?range=24h", admin))
    .data;
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.succeeded, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.successRate, 50);
  assert.equal(report.summary.outputs, 1);
  assert.equal(report.attempts.total, 2);
  for (const range of ["2h", "24h", "7d", "30d"])
    assert.equal(
      (
        await req(
          `/api/admin/observability/overview?range=${range}&userId=${uid}&model=test-image`,
          admin,
        )
      ).data.summary.total,
      2,
    );
  assert.equal(
    (await req("/api/admin/observability/overview?model=missing", admin)).data
      .summary.successRate,
    null,
  );
  assert.equal(
    (await req("/api/admin/observability/overview?from=bad", admin)).status,
    400,
  );
  const detail = (await req(`/api/admin/observability/tasks/${ids[0]}`, admin))
    .data;
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.task.delivered, 1);
  assert.equal(detail.task.expected, 1);
  const failure = (await req(`/api/admin/observability/tasks/${ids[1]}`, admin))
    .data;
  assert.ok(!JSON.stringify(failure).includes("secret-prompt"));
  assert.ok(!JSON.stringify(failure).includes("sk-never"));
  const exported = await req(
    "/api/admin/observability/export?range=24h",
    admin,
  );
  assert.equal(exported.status, 200);
  assert.ok(exported.data.includes(ids[0]));
  assert.equal(
    (await req("/api/admin/observability/credits", admin)).data.rows.find(
      (u) => u.id === uid,
    ).availableDifference,
    0,
  );
  assert.equal((await action("kick-user", { id: uid })).status, 200);
  assert.equal((await req("/api/auth/me", user)).status, 401);
  await action("resync");
  assert.ok(
    (
      await req("/api/admin/observability/events?entity=audit", admin)
    ).data.items.some((e) => e.action === "kick-user"),
  );
  const latencies = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const start = performance.now();
      const r = await req("/api/admin/observability/overview?range=30d", admin);
      assert.equal(r.status, 200);
      return performance.now() - start;
    }),
  );
  assert.ok(Math.max(...latencies) < 3000);
  t.diagnostic(
    `8 concurrent analytics queries max ${Math.round(Math.max(...latencies))} ms`,
  );
  child.kill();
  await new Promise((r) => child.once("close", r));
  await start();
  admin = await login("admin");
  await action("resync");
  report = (await req("/api/admin/observability/overview?range=24h", admin))
    .data;
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.outputs, 1);
  assert.equal(
    (await req("/api/admin/observability/snapshot", admin)).data.imageLimit,
    3,
  );
});
