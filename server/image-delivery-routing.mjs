export async function prepareImageDeliveryRequest(task, channel, body) {
    const contentType = task.requestContentType || "application/octet-stream";
    const original = { body, contentType, count: 1, provider: "compatible" };
    if (new URL(channel.baseUrl).hostname !== "ai.t8star.org" || !/^gpt-image-2\.5-(flare|sunburst)(-[124]k)?$/i.test(task.model)) return original;

    // T8's JSON image stream is much slower than its original-image CDN.
    if (task.action === "generations" && contentType.toLowerCase().startsWith("application/json")) {
        const payload = JSON.parse(body.toString("utf8"));
        return { ...original, body: Buffer.from(JSON.stringify({ ...payload, response_format: "url" })), responseFormat: "url" };
    }
    if (task.action === "edits" && contentType.toLowerCase().startsWith("multipart/form-data")) {
        const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
        form.set("response_format", "url");
        const encoded = new Response(form);
        return { ...original, body: Buffer.from(await encoded.arrayBuffer()), contentType: encoded.headers.get("content-type"), responseFormat: "url" };
    }
    return original;
}
