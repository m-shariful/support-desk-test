import { ProviderClient } from "../src/provider-client.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

async function createTestServer(handler, t) {
  const server = createServer(handler);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test("ProviderClient classifies HTTP 503 as definitely not accepted", async (t) => {
  const baseUrl = await createTestServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Explicitly rejected" }));
  }, t);

  const provider = new ProviderClient(baseUrl);

  await assert.rejects(
    provider.send({
      clientRef: "attempt-503",
      ticketId: 101,
      body: "Test message",
    }),
    (error) => error.kind === "not_accepted",
  );
});

test("ProviderClient classifies HTTP 504 as uncertain", async (t) => {
  const baseUrl = await createTestServer((_req, res) => {
    res.writeHead(504, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Delivery result unavailable" }));
  }, t);

  const provider = new ProviderClient(baseUrl);

  await assert.rejects(
    provider.send({
      clientRef: "attempt-504",
      ticketId: 101,
      body: "Test message",
    }),
    (error) => error.kind === "unknown",
  );
});

test("ProviderClient looks up the exact encoded clientRef", async (t) => {
  const expectedRef = "attempt/with spaces?and&symbols";
  let receivedUrl;

  const baseUrl = await createTestServer((req, res) => {
    receivedUrl = new URL(req.url, "http://localhost");

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        state: "delivered",
        providerMessageId: "provider-message-123",
        count: 1,
      }),
    );
  }, t);

  const provider = new ProviderClient(baseUrl);
  const result = await provider.lookup(expectedRef);

  assert.equal(receivedUrl.searchParams.get("clientRef"), expectedRef);
  assert.equal(result.state, "delivered");
  assert.equal(result.providerMessageId, "provider-message-123");
  assert.equal(result.count, 1);
});

test("ProviderClient treats an unsuccessful lookup as an error", async (t) => {
  const baseUrl = await createTestServer((_req, res) => {
    res.writeHead(503);
    res.end("Lookup unavailable");
  }, t);

  const provider = new ProviderClient(baseUrl);

  await assert.rejects(
    provider.lookup("attempt-lookup-failure"),
    /Lookup unavailable/,
  );
});
