import * as assert from "node:assert/strict";
import test from "node:test";
import { ComputerApiError, ComputerClient } from "../server/client/computer-client.js";

test("forwards the scoped token for workspace discovery without a model field", async () => {
  let seenRequest: RequestInit | undefined;
  const client = new ComputerClient({
    baseUrl: "http://cptr.test/",
    token: "secret",
    fetchImpl: async (_input, init) => {
      seenRequest = init;
      return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
    },
  });

  assert.deepEqual(await client.listWorkspaces(), { workspaces: [] });
  assert.equal((seenRequest?.headers as Record<string, string>).Authorization, "Bearer secret");
  assert.equal(String(seenRequest?.body ?? "").includes("model_id"), false);
});

test("normalizes bounded v2 API errors without exposing credentials", async () => {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async () => new Response(JSON.stringify({ detail: { code: "REVISION_CONFLICT" } }), { status: 409 }),
  });

  await assert.rejects(client.getDirectOperation("operation-1"), (error: unknown) => {
    const apiError = error as ComputerApiError;
    assert.ok(apiError instanceof ComputerApiError);
    assert.equal(apiError.status, 409);
    assert.equal(apiError.code, "REVISION_CONFLICT");
    assert.equal(apiError.message.includes("secret-token"), false);
    return true;
  });
});

test("converts durable-operation request timeouts to a bounded public error", async () => {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    timeoutMs: 1,
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  });

  await assert.rejects(client.getDirectOperation("operation-1"), (error: unknown) => {
    const apiError = error as ComputerApiError;
    assert.ok(apiError instanceof ComputerApiError);
    assert.equal(apiError.status, 504);
    assert.equal(apiError.code, "computer_api_timeout");
    return true;
  });
});

test("routes every direct coding primitive through the v2 durable operation API without model or shell fields", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
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
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), init });
      const url = String(input);
      if (url.endsWith("/inspect/list")) {
        return new Response(JSON.stringify({ workspace_id: "ws-1", path: ".", entries: [], next_cursor: null, truncated: false }), { status: 200 });
      }
      if (url.endsWith("/inspect/read")) {
        return new Response(JSON.stringify({ workspace_id: "ws-1", path: "src/a.ts", content: "export {};", revision: "sha256:one", start_line: 1, end_line: 1, total_lines: 1, size: 10 }), { status: 200 });
      }
      if (url.includes("/events?")) {
        return new Response(JSON.stringify({ operation_id: "operation-1", events: [], next_cursor: null }), { status: 200 });
      }
      return new Response(JSON.stringify(operation), { status: 200 });
    },
  });

  await client.inspectFiles({ workspace_id: "ws-1" });
  await client.inspectFile({ workspace_id: "ws-1", path: "src/a.ts" });
  await client.createWriteOperation({ workspace_id: "ws-1", path: "src/a.ts", content: "export {};", expected_revision: "sha256:one", idempotency_key: "turn-1-write" });
  await client.createEditOperation({ workspace_id: "ws-1", path: "src/a.ts", target: "{}", replacement: "{ value: 1 }", expected_revision: "sha256:one", idempotency_key: "turn-1-edit" });
  await client.runWorkspaceAction({ workspace_id: "ws-1", action: "typecheck", idempotency_key: "turn-1-typecheck" });
  await client.runCodeBlock({ workspace_id: "ws-1", language: "python", code: "print(1)", idempotency_key: "turn-1-code" });
  await client.runSshOperation({ workspace_id: "ws-1", ssh_profile: "production", ssh_action: "status", idempotency_key: "turn-1-ssh" });
  await client.getDirectOperation("operation-1");
  await client.getDirectOperationEvents({ operation_id: "operation-1" });
  await client.cancelDirectOperation({ operation_id: "operation-1", idempotency_key: "turn-1-cancel" });
  await client.approveDirectOperation({ operation_id: "operation-1", approved: true, idempotency_key: "turn-1-approve" });

  assert.deepEqual(seen.map((request) => request.url), [
    "http://cptr.test/api/control/v2/workspaces/ws-1/inspect/list",
    "http://cptr.test/api/control/v2/workspaces/ws-1/inspect/read",
    "http://cptr.test/api/control/v2/workspaces/ws-1/operations",
    "http://cptr.test/api/control/v2/workspaces/ws-1/operations",
    "http://cptr.test/api/control/v2/workspaces/ws-1/operations",
    "http://cptr.test/api/control/v2/workspaces/ws-1/operations",
    "http://cptr.test/api/control/v2/workspaces/ws-1/operations",
    "http://cptr.test/api/control/v2/operations/operation-1",
    "http://cptr.test/api/control/v2/operations/operation-1/events?limit=50",
    "http://cptr.test/api/control/v2/operations/operation-1/cancel",
    "http://cptr.test/api/control/v2/operations/operation-1/approval",
  ]);

  for (const request of seen) {
    const body = String(request.init?.body ?? "");
    assert.equal(body.includes("model_id"), false);
    assert.equal(body.includes("remote_command"), false);
    assert.equal((request.init?.headers as Record<string, string>).Authorization, "Bearer secret-token");
  }

  const writeBody = JSON.parse(String(seen[2].init?.body));
  const codeBody = JSON.parse(String(seen[5].init?.body));
  const sshBody = JSON.parse(String(seen[6].init?.body));
  assert.deepEqual(codeBody, {
    kind: "RUN_CODE_BLOCK",
    language: "python",
    code: "print(1)",
    idempotency_key: "turn-1-code",
  });
  assert.deepEqual(sshBody, {
    kind: "SSH_EXECUTE",
    ssh_profile: "production",
    ssh_action: "status",
    idempotency_key: "turn-1-ssh",
  });
  assert.deepEqual(writeBody, {
    kind: "WRITE_FILE",
    path: "src/a.ts",
    content: "export {};",
    expected_revision: "sha256:one",
    idempotency_key: "turn-1-write",
  });
});
