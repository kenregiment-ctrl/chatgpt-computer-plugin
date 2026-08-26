import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ComputerClient } from "./client/computer-client.js";
import {
  actionOperationSchema,
  approveAutonomousSchema,
  approveOperationSchema,
  cancelOperationSchema,
  codeBlockOperationSchema,
  editOperationSchema,
  inspectListSchema,
  inspectReadSchema,
  executeTaskSchema,
  messageSchema,
  monitorAutonomousSchema,
  monitorIdSchema,
  operationEventsSchema,
  operationIdSchema,
  sshOperationSchema,
  startTaskSchema,
  steerAutonomousSchema,
  taskIdSchema,
  workspaceIdSchema,
  writeOperationSchema,
} from "./schemas/tools.js";

function result<T extends Record<string, unknown>>(value: T) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

const operationOutputSchema = {
  operation_id: z.string(),
  workspace_id: z.string(),
  kind: z.enum(["WRITE_FILE", "EDIT_FILE", "RUN_ACTION", "RUN_CODE_BLOCK", "SSH_EXECUTE"]),
  state: z.string(),
  approval_id: z.string().nullable(),
  result: z.record(z.string(), z.unknown()),
  error_code: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  finished_at: z.number().nullable(),
  replayed: z.boolean().optional(),
};

/**
 * Register only ChatGPT-planned durable workspace tools.
 *
 * No tool here accepts a CPTR model ID, starts a CPTR task, invokes the CPTR
 * OpenAI-compatible gateway, or delegates planning to an autonomous monitor.
 */
export function createMcpServer(client: ComputerClient): McpServer {
  const server = new McpServer({ name: "chatgpt-computer-plugin", version: "0.2.0" });
  const legacyFallbackEnabled = process.env.CPTR_LEGACY_FALLBACK_ENABLED === "true";

  server.registerTool(
    "cptr_list_workspaces",
    {
      title: "List authorized CPTR workspaces",
      description: "Use this to discover CPTR workspaces available to the user before direct inspection or coding.",
      inputSchema: {},
      outputSchema: { workspaces: z.array(z.record(z.string(), z.unknown())) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => result(await client.listWorkspaces()),
  );

  server.registerTool(
    "cptr_get_workspace",
    {
      title: "Get an authorized CPTR workspace",
      description: "Use this to inspect the metadata of a single authorized workspace.",
      inputSchema: workspaceIdSchema,
      outputSchema: { workspace_id: z.string(), name: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace_id }) => result(await client.getWorkspace(workspace_id)),
  );

  server.registerTool(
    "cptr_inspect_list",
    {
      title: "List files in an authorized workspace",
      description:
        "Use this to inspect one directory before coding. Results are bounded and cursor-paginated; it cannot access paths outside the selected workspace.",
      inputSchema: inspectListSchema,
      outputSchema: {
        workspace_id: z.string(),
        path: z.string(),
        entries: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            size: z.number().nullable(),
            modified: z.string().nullable(),
          }),
        ),
        next_cursor: z.number().nullable(),
        truncated: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => result(await client.inspectFiles(input)),
  );

  server.registerTool(
    "cptr_inspect_read",
    {
      title: "Read a workspace file with a revision",
      description:
        "Use this to inspect source code before editing. Record the returned revision and supply it to a later mutation so CPTR can reject stale writes.",
      inputSchema: inspectReadSchema,
      outputSchema: {
        workspace_id: z.string(),
        path: z.string(),
        content: z.string(),
        revision: z.string(),
        start_line: z.number(),
        end_line: z.number(),
        total_lines: z.number(),
        size: z.number(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => result(await client.inspectFile(input)),
  );

  server.registerTool(
    "cptr_create_file_operation",
    {
      title: "Create a durable versioned file write",
      description:
        "Use only when the user explicitly asks ChatGPT to create or replace a file. Supply the revision returned by cptr_inspect_read, or MISSING for a new file, and reuse the idempotency key only when retrying this exact logical write.",
      inputSchema: writeOperationSchema,
      outputSchema: operationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => result(await client.createWriteOperation(input)),
  );

  server.registerTool(
    "cptr_create_edit_operation",
    {
      title: "Create a durable exact file edit",
      description:
        "Use only when the user explicitly asks ChatGPT to edit code. Read the file first, send its revision, and supply an exact unique target. CPTR rejects stale or ambiguous mutations.",
      inputSchema: editOperationSchema,
      outputSchema: operationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => result(await client.createEditOperation(input)),
  );

  server.registerTool(
    "cptr_run_workspace_action",
    {
      title: "Request a durable structured workspace action",
      description:
        "Use only when the user explicitly asks ChatGPT to validate code. This accepts a named action, not an arbitrary command; CPTR may reject it until a deployment-configured isolated executor is available.",
      inputSchema: actionOperationSchema,
      outputSchema: operationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => result(await client.runWorkspaceAction(input)),
  );

  server.registerTool(
    "cptr_run_code_block",
    {
      title: "Request a sandboxed workspace code block",
      description:
        "Use only when the user explicitly asks ChatGPT to execute the supplied code in the workspace. The operation is durable, requires approval, runs only through the deployment-configured isolated sandbox runner, and never uses CPTR's agent model or host shell.",
      inputSchema: codeBlockOperationSchema,
      outputSchema: operationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => result(await client.runCodeBlock(input)),
  );

  server.registerTool(
    "cptr_run_ssh_operation",
    {
      title: "Request an approved SSH profile operation",
      description:
        "Use only when the user explicitly asks ChatGPT to run a named, administrator-configured SSH profile action. The operation is durable, approval-gated, strict-host-key checked, and CPTR does not reveal SSH credentials or free-form remote shell access to ChatGPT.",
      inputSchema: sshOperationSchema,
      outputSchema: operationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input) => result(await client.runSshOperation(input)),
  );

  server.registerTool(
    "cptr_get_direct_operation",
    {
      title: "Get a durable direct operation",
      description: "Use this to inspect the current lifecycle state and bounded result of a direct workspace operation.",
      inputSchema: operationIdSchema,
      outputSchema: operationOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ operation_id }) => result(await client.getDirectOperation(operation_id)),
  );

  server.registerTool(
    "cptr_get_direct_operation_events",
    {
      title: "Get bounded direct-operation events",
      description: "Use this to inspect a cursor-paginated lifecycle and output event stream for a durable direct operation.",
      inputSchema: operationEventsSchema,
      outputSchema: {
        operation_id: z.string(),
        events: z.array(
          z.object({
            event_id: z.string(),
            event_type: z.string(),
            state: z.string().nullable(),
            payload: z.record(z.string(), z.unknown()),
            created_at: z.number(),
          }),
        ),
        next_cursor: z.string().nullable(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => result(await client.getDirectOperationEvents(input)),
  );

  server.registerTool(
    "cptr_cancel_direct_operation",
    {
      title: "Cancel a durable direct operation",
      description:
        "Use only when the user explicitly asks ChatGPT to stop the identified operation. Reuse the idempotency key only to retry this exact cancellation request.",
      inputSchema: cancelOperationSchema,
      outputSchema: operationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => result(await client.cancelDirectOperation(input)),
  );

  server.registerTool(
    "cptr_approve_direct_operation",
    {
      title: "Approve or reject one pending direct operation",
      description:
        "Use only when the user explicitly approves or rejects the specific pending operation. Approval is durable and bound to that operation; it cannot be inferred from a request flag.",
      inputSchema: approveOperationSchema,
      outputSchema: operationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input) => result(await client.approveDirectOperation(input)),
  );

  server.registerTool(
    "cptr_get_diff",
    {
      title: "Get a workspace Git diff",
      description: "Use this to inspect the current Git diff in an authorized workspace after a direct operation.",
      inputSchema: workspaceIdSchema,
      outputSchema: { diff: z.unknown().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace_id }) => result(await client.getDiff(workspace_id)),
  );

  // Legacy compatibility fallback is opt-in. The default ChatGPT surface has
  // no model-backed CPTR planning or agent-loop tools.
  if (legacyFallbackEnabled) {
    server.registerTool(
    "cptr_legacy_start_task",
    {
      title: "Legacy fallback: start a CPTR agent task",
      description: "Use only when the user explicitly requests the legacy CPTR agent workflow or durable direct operations cannot perform the requested capability.",
      inputSchema: startTaskSchema,
      outputSchema: { id: z.string(), status: z.string(), model_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => result(await client.legacyStartTask(input)),
  );
  server.registerTool(
    "cptr_legacy_execute_task",
    {
      title: "Legacy fallback: execute a CPTR agent task",
      description: "Use only as an explicit fallback to the pre-existing CPTR agent workflow; this is not the default ChatGPT-controlled coding path.",
      inputSchema: executeTaskSchema,
      outputSchema: { task_id: z.string(), status: z.string(), output: z.string(), completed: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => result(await client.legacyExecuteTask(input)),
  );
  server.registerTool(
    "cptr_legacy_monitor_autonomous",
    {
      title: "Legacy fallback: start CPTR autonomous monitoring",
      description: "Use only when the user explicitly requests the legacy autonomous CPTR monitor instead of ChatGPT tool orchestration.",
      inputSchema: monitorAutonomousSchema,
      outputSchema: { monitor_id: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => result(await client.legacyCreateAutonomous(input)),
  );
  server.registerTool(
    "cptr_legacy_get_task",
    {
      title: "Legacy fallback: get CPTR task",
      description: "Read a legacy CPTR task status when the explicit fallback workflow is in use.",
      inputSchema: taskIdSchema,
      outputSchema: { id: z.string(), status: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ task_id }) => result(await client.legacyGetTask(task_id)),
  );
  server.registerTool(
    "cptr_legacy_get_task_output",
    {
      title: "Legacy fallback: get CPTR task output",
      description: "Read output from an already started legacy CPTR task.",
      inputSchema: taskIdSchema,
      outputSchema: { task_id: z.string(), status: z.string(), content: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ task_id }) => result(await client.legacyGetTaskOutput(task_id)),
  );
  server.registerTool(
    "cptr_legacy_send_task_message",
    {
      title: "Legacy fallback: steer CPTR task",
      description: "Send a follow-up only when the user explicitly steers an existing legacy CPTR task.",
      inputSchema: messageSchema,
      outputSchema: { task_id: z.string(), message_id: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ task_id, content }) => result(await client.legacySendMessage(task_id, content)),
  );
  server.registerTool(
    "cptr_legacy_cancel_task",
    {
      title: "Legacy fallback: cancel CPTR task",
      description: "Cancel an existing legacy CPTR task only when the user explicitly requests it.",
      inputSchema: taskIdSchema,
      outputSchema: { id: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ task_id }) => result(await client.legacyCancelTask(task_id)),
  );
  server.registerTool(
    "cptr_legacy_get_autonomous",
    {
      title: "Legacy fallback: get autonomous monitor",
      description: "Inspect a legacy autonomous monitor when the explicit fallback workflow is in use.",
      inputSchema: monitorIdSchema,
      outputSchema: { monitor_id: z.string(), status: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ monitor_id }) => result(await client.legacyGetAutonomous(monitor_id)),
  );
  server.registerTool(
    "cptr_legacy_get_autonomous_events",
    {
      title: "Legacy fallback: get monitor events",
      description: "Inspect the events of a legacy autonomous monitor.",
      inputSchema: monitorIdSchema,
      outputSchema: { monitor_id: z.string(), events: z.array(z.unknown()) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ monitor_id }) => result(await client.legacyGetAutonomousEvents(monitor_id)),
  );
  server.registerTool(
    "cptr_legacy_get_autonomous_evidence",
    {
      title: "Legacy fallback: get monitor evidence",
      description: "Inspect evidence for a legacy autonomous monitor.",
      inputSchema: monitorIdSchema,
      outputSchema: { monitor_id: z.string(), evidence: z.array(z.unknown()) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ monitor_id }) => result(await client.legacyGetAutonomousEvidence(monitor_id)),
  );
  server.registerTool(
    "cptr_legacy_steer_autonomous",
    {
      title: "Legacy fallback: steer autonomous monitor",
      description: "Steer a legacy autonomous monitor only when the user explicitly requests it.",
      inputSchema: steerAutonomousSchema,
      outputSchema: { monitor_id: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ monitor_id, content }) => result(await client.legacySteerAutonomous(monitor_id, content)),
  );
  server.registerTool(
    "cptr_legacy_cancel_autonomous",
    {
      title: "Legacy fallback: cancel autonomous monitor",
      description: "Cancel a legacy autonomous monitor only when the user explicitly requests it.",
      inputSchema: monitorIdSchema,
      outputSchema: { monitor_id: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ monitor_id }) => result(await client.legacyCancelAutonomous(monitor_id)),
  );
  server.registerTool(
    "cptr_legacy_approve_autonomous",
    {
      title: "Legacy fallback: approve autonomous monitor step",
      description: "Approve or reject a legacy autonomous monitor step only with explicit user authorization.",
      inputSchema: approveAutonomousSchema,
      outputSchema: { monitor_id: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ monitor_id, approval_id, approved }) => result(await client.legacyApproveAutonomous(monitor_id, approval_id, approved)),
  );

  }

  return server;
}
