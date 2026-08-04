import assert from "node:assert/strict";
import test from "node:test";

import { isArkSeedreamChannel, prepareSeedreamRequest, seedreamUpstream } from "./seedream-routing.mjs";

const ark = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3" };
const t8 = { baseUrl: "https://ai.t8star.org/v1" };

function editBody(model = "doubao-seedream-5-0-pro-260628") {
    const boundary = "seedream-routing-test";
    const body = Buffer.from([
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n保留构图，调整色彩\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n`,
        `--${boundary}--\r\n`,
    ].join(""));
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

test("dedicated Seedream route always targets Ark generations", () => {
    const input = editBody();
    const prepared = prepareSeedreamRequest({ action: "edits", model: "doubao-seedream-5-0-pro-260628", requestContentType: input.contentType }, input.body);
    const payload = JSON.parse(prepared.body.toString("utf8"));
    assert.equal(prepared.contentType, "application/json");
    assert.equal(payload.image, "data:image/png;base64,UE5HREFUQQ==");
    assert.equal(seedreamUpstream(ark).url, "https://ark.cn-beijing.volces.com/api/v3/images/generations");
});

test("future Seedream model names are accepted only on Ark", () => {
    assert.equal(isArkSeedreamChannel(ark, "doubao-seedream-6-0-260999"), true);
    assert.equal(isArkSeedreamChannel(t8, "doubao-seedream-6-0-260999"), false);
});

test("dedicated route rejects a non-Ark base URL", () => {
    assert.throws(() => seedreamUpstream(t8), /Ark/);
});
