#!/usr/bin/env python3
"""Isolated aiohttp transport for the Grok Video V2 provider."""

import asyncio
import json
import sys
from urllib.parse import urlsplit

import aiohttp


MAX_METADATA_BYTES = 64 * 1024


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def read_request():
    metadata_line = sys.stdin.buffer.readline(MAX_METADATA_BYTES + 1)
    if not metadata_line or len(metadata_line) > MAX_METADATA_BYTES or not metadata_line.endswith(b"\n"):
        fail("invalid request metadata")
    try:
        metadata = json.loads(metadata_line)
    except (TypeError, ValueError):
        fail("invalid request metadata JSON")

    url = str(metadata.get("url", ""))
    parsed_url = urlsplit(url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        fail("invalid upstream URL")

    method = str(metadata.get("method", "GET")).upper()
    if method not in {"GET", "POST"}:
        fail("unsupported upstream method")

    raw_headers = metadata.get("headers")
    if not isinstance(raw_headers, dict):
        fail("invalid request headers")
    headers = {}
    for name, value in raw_headers.items():
        name = str(name)
        value = str(value)
        if not name or "\r" in name or "\n" in name or "\r" in value or "\n" in value:
            fail("invalid request header")
        headers[name] = value

    try:
        body_length = int(metadata.get("bodyLength", 0))
        timeout_ms = int(metadata.get("timeoutMs", 1_200_000))
        max_response_bytes = int(metadata.get("maxResponseBytes", 256 * 1024 * 1024))
    except (TypeError, ValueError):
        fail("invalid request limits")
    if body_length < 0 or timeout_ms < 1 or max_response_bytes < 1:
        fail("invalid request limits")

    body = sys.stdin.buffer.read(body_length)
    if len(body) != body_length:
        fail("incomplete request body")
    return url, method, headers, body, timeout_ms, max_response_bytes


async def request_upstream(url, method, headers, body, timeout_ms, max_response_bytes):
    timeout = aiohttp.ClientTimeout(total=timeout_ms / 1000)
    async with aiohttp.ClientSession(timeout=timeout, auto_decompress=True) as session:
        async with session.request(
            method,
            url,
            headers=headers,
            data=body if body else None,
            allow_redirects=False,
        ) as response:
            chunks = []
            size = 0
            async for chunk in response.content.iter_chunked(64 * 1024):
                size += len(chunk)
                if size > max_response_bytes:
                    raise RuntimeError("upstream response exceeds size limit")
                chunks.append(chunk)
            return response.status, response.headers.get("Content-Type"), b"".join(chunks)


def main() -> None:
    request = read_request()
    try:
        status, content_type, body = asyncio.run(request_upstream(*request))
    except Exception as error:
        fail(f"{type(error).__name__}: {error}")
    metadata = json.dumps(
        {"status": status, "contentType": content_type, "bodyLength": len(body)},
        separators=(",", ":"),
    ).encode("utf-8")
    sys.stdout.buffer.write(metadata + b"\n" + body)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
