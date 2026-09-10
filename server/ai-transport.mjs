import { Agent } from "undici";

export function createAiDispatcher(timeoutMs) {
    // AbortSignal alone does not override Undici's five-minute I/O deadlines.
    return new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs, connect: { timeout: 60_000 } });
}
