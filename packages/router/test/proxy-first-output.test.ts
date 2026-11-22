// The router notes when the first piece of an answer reaches the client, so the dashboard can show
// the writing speed apart from the wait before it.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { watchFirstOutput } from "../src/proxy.ts";

async function serve(handler: (res: http.ServerResponse) => Promise<void>): Promise<void> {
  const server = http.createServer((_req, res) => void handler(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/" }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject);
  });
  server.close();
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the first text content_block_delta marks the first output, not message_start, pings or thinking", async () => {
  let watched: { at: () => number | undefined } | undefined;
  let before = 0, after = 0;
  await serve(async (res) => {
    watched = watchFirstOutput(res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse("message_start", { type: "message_start" }));
    res.write(Buffer.from(sse("ping", { type: "ping" })));
    // A thinking summary streams while the model still thinks: not the start of the writing.
    res.write(sse("content_block_delta", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }));
    await pause(60);
    assert.equal(watched.at(), undefined, "nothing of the answer yet");
    before = Date.now();
    res.write(Buffer.from(sse("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })));
    after = Date.now();
    await pause(30);
    res.write(sse("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "!" } }));
    res.end(sse("message_stop", { type: "message_stop" }));
  });
  const at = watched!.at();
  assert.ok(at !== undefined && at >= before && at <= after, `first output at ${at}, written between ${before} and ${after}`);
});

test("a response that never writes an answer has no first output", async () => {
  let watched: { at: () => number | undefined } | undefined;
  await serve(async (res) => {
    watched = watchFirstOutput(res);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "no" } }));
  });
  assert.equal(watched!.at(), undefined);
});

test("a tool call's first argument delta marks the first output", async () => {
  let watched: { at: () => number | undefined } | undefined;
  await serve(async (res) => {
    watched = watchFirstOutput(res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse("content_block_start", { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } }));
    assert.equal(watched.at(), undefined);
    res.end(sse("content_block_delta", { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } }));
  });
  assert.notEqual(watched!.at(), undefined);
});
