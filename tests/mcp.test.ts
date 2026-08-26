import * as assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComputerClient } from "../server/client/computer-client.js";
import { createMcpServer } from "../server/mcp.js";

async function connectedClient(computer: ComputerClient) {
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("advertises only ChatGPT-planned durable workspace tools by default", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const { client, server } = await connectedClient(computer);
  const listed = await client.listTools();
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));

  const expected = [
    "cptr_list_workspaces",
    "cptr_get_workspace",
    "cptr_inspect_list",
    "cptr_inspect_read",
    "cptr_create_file_operation",
    "cptr_create_edit_operation",
    "cptr_run_workspace_action",
    "cptr_run_code_block",
    "cptr_run_ssh_operation",
    "cptr_get_direct_operation",
    "cptr_get_direct_operation_events",
    "cptr_cancel_direct_operation",
    "cptr_approve_direct_operation",
    "cptr_get_diff",
  ];
  assert.equal(expected.every((name) => tools.has(name)), true);
  assert.equal(tools.has("cptr_start_task"), false);
  assert.equal(tools.has("cptr_execute_task"), false);
  assert.equal(tools.has("cptr_monitor_autonomous"), false);
  assert.equal(tools.has("cptr_code_run_command"), false);
  assert.equal(tools.has("cptr_legacy_start_task"), false);
  assert.equal(tools.get("cptr_inspect_read")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_create_file_operation")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_run_workspace_action")?.annotations?.openWorldHint, false);

  for (const [name, tool] of tools) {
    if (!name.startsWith("cptr_legacy_")) {
      assert.equal(tool.inputSchema.properties?.model_id, undefined);
      assert.equal(tool.inputSchema.properties?.command, undefined);
      assert.equal(tool.inputSchema.properties?.remote_command, undefined);
    }
  }

  await client.close();
  await server.close();
});

test("invokes durable MCP operations through v2 without CPTR model or raw shell data", async () => {
  const seen: Array<{ url: string; body: string }> = [];
  const operation = {
    operation_id: "operation-1",
    workspace_id: "ws-1",
    kind: "WRITE_FILE",
    state: "SUCCEEDED",
    approval_id: null,
    result: {},
    error_code: null,
    created_at: 1,
    updated_at: 2,
    finished_at: 2,
  };
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      seen.push({ url, body: String(init?.body ?? "") });
      if (url.endsWith("/inspect/list")) {
        return new Response(
          JSON.stringify({ workspace_id: "ws-1", path: ".", entries: [], next_cursor: null, truncated: false }),
          { status: 200 },
        );
      }
      if (url.endsWith("/inspect/read")) {
        return new Response(
          JSON.stringify({ workspace_id: "ws-1", path: "src/a.ts", content: "export {};", revision: "sha256:one", start_line: 1, end_line: 1, total_lines: 1, size: 10 }),
          { status: 200 },
        );
      }
      if (url.includes("/events?")) {
        return new Response(JSON.stringify({ operation_id: "operation-1", events: [], next_cursor: null }), { status: 200 });
      }
      return new Response(JSON.stringify(operation), { status: 200 });
    },
  });
  const { client, server } = await connectedClient(computer);

  await client.callTool({ name: "cptr_inspect_list", arguments: { workspace_id: "ws-1" } });
  await client.callTool({ name: "cptr_inspect_read", arguments: { workspace_id: "ws-1", path: "src/a.ts" } });
  await client.callTool({ name: "cptr_create_file_operation", arguments: { workspace_id: "ws-1", path: "src/a.ts", content: "export {};", expected_revision: "sha256:one", idempotency_key: "turn-write" } });
  await client.callTool({ name: "cptr_create_edit_operation", arguments: { workspace_id: "ws-1", path: "src/a.ts", target: "{}", replacement: "{ value: 1 }", expected_revision: "sha256:one", idempotency_key: "turn-edit" } });
  await client.callTool({ name: "cptr_run_workspace_action", arguments: { workspace_id: "ws-1", action: "typecheck", idempotency_key: "turn-action" } });
  await client.callTool({ name: "cptr_run_code_block", arguments: { workspace_id: "ws-1", language: "python", code: "print(1)", idempotency_key: "turn-code" } });
  await client.callTool({ name: "cptr_run_ssh_operation", arguments: { workspace_id: "ws-1", ssh_profile: "production", ssh_action: "status", idempotency_key: "turn-ssh" } });
  await client.callTool({ name: "cptr_get_direct_operation", arguments: { operation_id: "operation-1" } });
  await client.callTool({ name: "cptr_get_direct_operation_events", arguments: { operation_id: "operation-1" } });
  await client.callTool({ name: "cptr_cancel_direct_operation", arguments: { operation_id: "operation-1", idempotency_key: "turn-cancel" } });
  await client.callTool({ name: "cptr_approve_direct_operation", arguments: { operation_id: "operation-1", approved: true, idempotency_key: "turn-approve" } });

  assert.equal(seen.every((request) => request.url.includes("/api/control/v2/")), true);
  assert.equal(seen.every((request) => !request.body.includes("model_id")), true);
  assert.equal(seen.every((request) => !request.body.includes("remote_command")), true);
  assert.equal(seen.some((request) => request.url.includes("/v1/chat/completions")), false);

  await client.close();
  await server.close();
});

test("registers explicitly named legacy fallback tools only when opt-in is enabled", async () => {
  const original = process.env.CPTR_LEGACY_FALLBACK_ENABLED;
  process.env.CPTR_LEGACY_FALLBACK_ENABLED = "true";
  try {
    const computer = new ComputerClient({
      baseUrl: "http://cptr.test",
      token: "test-token",
      fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    const { client, server } = await connectedClient(computer);
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    assert.equal(tools.has("cptr_legacy_start_task"), true);
    assert.notEqual(tools.get("cptr_legacy_start_task")?.inputSchema.properties?.model_id, undefined);
    await client.close();
    await server.close();
  } finally {
    if (original === undefined) delete process.env.CPTR_LEGACY_FALLBACK_ENABLED;
    else process.env.CPTR_LEGACY_FALLBACK_ENABLED = original;
  }
});
