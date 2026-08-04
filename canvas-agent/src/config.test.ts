import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Agent 凭据目录和配置文件只对当前用户可读写", async (t) => {
    const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-config-"));
    const originalHome = process.env.HOME;
    process.env.HOME = temporaryHome;
    t.after(() => {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        fs.rmSync(temporaryHome, { recursive: true, force: true });
    });

    const config = await import(`./config.ts?test=${Date.now()}`);
    config.saveConfig({ url: "http://127.0.0.1:17371", token: "secret-token" });

    assert.equal(fs.statSync(config.CONFIG_DIR).mode & 0o777, 0o700);
    assert.equal(fs.statSync(config.CONFIG_FILE).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(config.CONFIG_FILE, "utf8")).token, "secret-token");
});
