import assert from "node:assert/strict";
import test from "node:test";
import { prepareImageDeliveryRequest } from "./image-delivery-routing.mjs";

const channel = { baseUrl: "https://ai.t8star.org/v1" };
const task = { action: "generations", model: "gpt-image-2.5-sunburst", requestContentType: "application/json" };

test("T8 Flare and Sunburst request original-image URLs without changing generation parameters", async () => {
    const payload = { model: task.model, prompt: "lighthouse", size: "2048x1152", quality: "high", response_format: "b64_json", output_format: "png", n: 1 };
    const raw = Buffer.from(JSON.stringify(payload));
    for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst-4k"]) {
        const prepared = await prepareImageDeliveryRequest({ ...task, model }, channel, raw);
        assert.deepEqual(JSON.parse(prepared.body), { ...payload, response_format: "url" });
        assert.equal(prepared.responseFormat, "url");
    }
    assert.deepEqual(JSON.parse(raw), payload);
});

test("multipart conversion preserves multiple references, masks and all image bytes", async () => {
    const form = new FormData();
    const image = new Uint8Array([0, 255, 13, 10, 45, 128, 60]);
    form.set("model", task.model);
    form.set("prompt", "reference image edit");
    form.set("size", "2048x1152");
    form.set("quality", "max");
    form.set("response_format", "b64_json");
    form.set("output_format", "png");
    form.append("image", new Blob([image], { type: "image/png" }), "first.png");
    form.append("image", new Blob([image], { type: "image/png" }), "second.png");
    form.set("mask", new Blob([image], { type: "image/png" }), "mask.png");
    const request = new Response(form);
    const prepared = await prepareImageDeliveryRequest({ ...task, action: "edits", requestContentType: request.headers.get("content-type") }, channel, Buffer.from(await request.arrayBuffer()));
    const decoded = await new Response(prepared.body, { headers: { "Content-Type": prepared.contentType } }).formData();
    assert.equal(decoded.get("response_format"), "url");
    for (const key of ["model", "prompt", "size", "quality", "output_format"]) assert.equal(decoded.get(key), form.get(key));
    assert.deepEqual(decoded.getAll("image").map((file) => file.name), ["first.png", "second.png"]);
    for (const file of [...decoded.getAll("image"), decoded.get("mask")]) {
        assert.equal(file.type, "image/png");
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), image);
    }
});

test("other channels, models and formats retain their original transport", async () => {
    const raw = Buffer.from('{"response_format":"b64_json"}');
    for (const [override, selectedChannel] of [
        [{ model: "gpt-image-2" }, channel],
        [{}, { baseUrl: "https://another-provider.example/v1" }],
        [{}, { baseUrl: "https://ai.t8star.org.example/v1" }],
        [{ action: "edits", requestContentType: "application/json" }, channel],
    ]) {
        const prepared = await prepareImageDeliveryRequest({ ...task, ...override }, selectedChannel, raw);
        assert.equal(prepared.body, raw);
        assert.equal(prepared.responseFormat, undefined);
    }
});
