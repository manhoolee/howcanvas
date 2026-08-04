import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
const separator = input.indexOf(0x0a);
const metadata = JSON.parse(input.subarray(0, separator).toString("utf8"));
const body = input.subarray(separator + 1);
if (body.length !== metadata.bodyLength) throw new Error("invalid request body length");

const target = new URL(metadata.url);
const request = target.protocol === "https:" ? httpsRequest : httpRequest;
const headers = { ...metadata.headers };
if (body.length) headers["Content-Length"] = String(body.length);
const upstream = request(target, { method: metadata.method, headers }, (response) => {
    const responseChunks = [];
    response.on("data", (chunk) => responseChunks.push(chunk));
    response.on("end", () => {
        const responseBody = Buffer.concat(responseChunks);
        process.stdout.write(`${JSON.stringify({
            status: response.statusCode,
            contentType: response.headers["content-type"] || null,
            bodyLength: responseBody.length,
        })}\n`);
        process.stdout.write(responseBody);
    });
});
upstream.end(body.length ? body : undefined);
