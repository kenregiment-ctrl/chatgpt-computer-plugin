import type {
  DirectFileRead,
  DirectInspectionList,
  DirectOperation,
  DirectOperationEvents,
  DirectTaskExecution,
  GitDiff,
  Task,
  TaskOutput,
  Workspace,
} from "../types.js";

export class ComputerApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = "computer_api_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type FetchLike = typeof fetch;

type RequestOptions = { method?: string; body?: unknown };

const TERMINAL_TASK_STATUSES = new Set(["COMPLETE", "FAILED", "CANCELLED"]);
const MAX_LEGACY_OUTPUT_CHARACTERS = 20_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedOutput(output: string): { output: string; output_truncated: boolean } {
  if (output.length <= MAX_LEGACY_OUTPUT_CHARACTERS) {
    return { output, output_truncated: false };
  }
  return {
    output: `${output.slice(0, MAX_LEGACY_OUTPUT_CHARACTERS)}\n\n[Output truncated by the MCP adapter.]`,
    output_truncated: true,
  };
}

/**
 * ChatGPT-only CPTR connector client.
 *
 * This client intentionally has no OpenAI gateway, `model_id`, task-start, or
 * autonomous-agent methods. CPTR is used only as the authorized durable
 * workspace-operation control plane; ChatGPT supplies all planning.
 */
export class ComputerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: {
    baseUrl: string;
    token: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }) {
    if (!options.baseUrl.trim()) throw new Error("CPTR_BASE_URL is required");
    if (!options.token.trim()) throw new Error("CPTR_API_TOKEN is required");
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async listWorkspaces(): Promise<{ workspaces: Workspace[] }> {
    return this.requestV1("/workspaces");
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    return this.requestV1(`/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async getDiff(workspaceId: string): Promise<GitDiff> {
    return this.requestV1(`/workspaces/${encodeURIComponent(workspaceId)}/git/diff`);
  }

  async inspectFiles(input: {
    workspace_id: string;
    path?: string;
    cursor?: number;
    limit?: number;
  }): Promise<DirectInspectionList> {
    return this.requestV2(`/workspaces/${encodeURIComponent(input.workspace_id)}/inspect/list`, {
      method: "POST",
      body: {
        path: input.path ?? ".",
        cursor: input.cursor ?? 0,
        limit: input.limit ?? 100,
      },
    });
  }

  async inspectFile(input: {
    workspace_id: string;
    path: string;
    start_line?: number;
    end_line?: number;
  }): Promise<DirectFileRead> {
    return this.requestV2(`/workspaces/${encodeURIComponent(input.workspace_id)}/inspect/read`, {
      method: "POST",
      body: {
        path: input.path,
        start_line: input.start_line ?? 0,
        end_line: input.end_line ?? 0,
      },
    });
  }

  async createWriteOperation(input: {
    workspace_id: string;
    path: string;
    content: string;
    expected_revision: string;
    idempotency_key: string;
  }): Promise<DirectOperation> {
    return this.requestV2(`/workspaces/${encodeURIComponent(input.workspace_id)}/operations`, {
      method: "POST",
      body: {
        kind: "WRITE_FILE",
        path: input.path,
        content: input.content,
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
      },
    });
  }

  async createEditOperation(input: {
    workspace_id: string;
    path: string;
    target: string;
    replacement: string;
    expected_revision: string;
    idempotency_key: string;
  }): Promise<DirectOperation> {
    return this.requestV2(`/workspaces/${encodeURIComponent(input.workspace_id)}/operations`, {
      method: "POST",
      body: {
        kind: "EDIT_FILE",
        path: input.path,
        target: input.target,
        replacement: input.replacement,
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
      },
    });
  }

  async runWorkspaceAction(input: {
    workspace_id: string;
    action: "lint" | "test" | "typecheck" | "build";
    idempotency_key: string;
  }): Promise<DirectOperation> {
    return this.requestV2(`/workspaces/${encodeURIComponent(input.workspace_id)}/operations`, {
      method: "POST",
      body: {
        kind: "RUN_ACTION",
        action: input.action,
        idempotency_key: input.idempotency_key,
      },
    });
  }

  async runCodeBlock(input: {
    workspace_id: string;
    language: "python" | "javascript" | "typescript" | "bash";
    code: string;
    idempotency_key: string;
  }): Promise<DirectOperation> {
    return this.requestV2(`/workspaces/${encodeURIComponent(input.workspace_id)}/operations`, {
      method: "POST",
      body: {
        kind: "RUN_CODE_BLOCK",
        language: input.language,
        code: input.code,
        idempotency_key: input.idempotency_key,
      },
    });
  }

  async runSshOperation(input: {
    workspace_id: string;
    ssh_profile: string;
    ssh_action: string;
    idempotency_key: string;
  }): Promise<DirectOperation> {
    return this.requestV2(`/workspaces/${encodeURIComponent(input.workspace_id)}/operations`, {
      method: "POST",
      body: {
        kind: "SSH_EXECUTE",
        ssh_profile: input.ssh_profile,
        ssh_action: input.ssh_action,
        idempotency_key: input.idempotency_key,
      },
    });
  }

  async getDirectOperation(operationId: string): Promise<DirectOperation> {
    return this.requestV2(`/operations/${encodeURIComponent(operationId)}`);
  }

  async getDirectOperationEvents(input: {
    operation_id: string;
    cursor?: string;
    limit?: number;
  }): Promise<DirectOperationEvents> {
    const query = new URLSearchParams({ limit: String(input.limit ?? 50) });
    if (input.cursor) query.set("cursor", input.cursor);
    return this.requestV2(`/operations/${encodeURIComponent(input.operation_id)}/events?${query}`);
  }

  async cancelDirectOperation(input: {
    operation_id: string;
    idempotency_key: string;
    reason?: string;
  }): Promise<DirectOperation> {
    return this.requestV2(`/operations/${encodeURIComponent(input.operation_id)}/cancel`, {
      method: "POST",
      body: {
        idempotency_key: input.idempotency_key,
        reason: input.reason ?? "cancel requested",
      },
    });
  }

  async approveDirectOperation(input: {
    operation_id: string;
    approved: boolean;
    idempotency_key: string;
  }): Promise<DirectOperation> {
    return this.requestV2(`/operations/${encodeURIComponent(input.operation_id)}/approval`, {
      method: "POST",
      body: {
        approved: input.approved,
        idempotency_key: input.idempotency_key,
      },
    });
  }

  // Legacy compatibility fallback. These methods retain CPTR agent/model
  // delegation only when the default durable tool surface cannot satisfy a
  // user request. They are intentionally named `legacy*` in this client.
  async legacyStartTask(input: {
    workspace_id: string;
    prompt: string;
    model_id: string;
    idempotency_key?: string;
  }): Promise<Task> {
    return this.requestV1("/tasks", { method: "POST", body: input });
  }

  async legacyExecuteTask(input: {
    workspace_id: string;
    prompt: string;
    model_id: string;
    wait_seconds?: number;
    idempotency_key?: string;
  }): Promise<DirectTaskExecution> {
    const waitSeconds = input.wait_seconds ?? 30;
    const task = await this.legacyStartTask(input);
    const deadline = Date.now() + waitSeconds * 1_000;
    let current = task;
    while (!TERMINAL_TASK_STATUSES.has(current.status) && Date.now() < deadline) {
      await wait(Math.min(1_000, Math.max(1, deadline - Date.now())));
      current = await this.legacyGetTask(task.id);
    }
    return {
      task_id: current.id,
      workspace_id: current.workspace_id,
      status: current.status,
      ...boundedOutput(current.output ?? ""),
      error: current.error,
      completed: TERMINAL_TASK_STATUSES.has(current.status),
      wait_seconds: waitSeconds,
    };
  }

  async legacyCreateAutonomous(input: {
    workspace_id: string;
    goal: string;
    acceptance_criteria: string[];
    model_id: string;
    idempotency_key?: string;
  }): Promise<Record<string, unknown>> {
    return this.requestV1("/autonomous", { method: "POST", body: input });
  }

  async legacyGetAutonomous(monitorId: string): Promise<Record<string, unknown>> {
    return this.requestV1(`/autonomous/${encodeURIComponent(monitorId)}`);
  }

  async legacyGetAutonomousEvents(monitorId: string): Promise<Record<string, unknown>> {
    return this.requestV1(`/autonomous/${encodeURIComponent(monitorId)}/events`);
  }

  async legacyGetAutonomousEvidence(monitorId: string): Promise<Record<string, unknown>> {
    return this.requestV1(`/autonomous/${encodeURIComponent(monitorId)}/evidence`);
  }

  async legacySteerAutonomous(monitorId: string, content: string): Promise<Record<string, unknown>> {
    return this.requestV1(`/autonomous/${encodeURIComponent(monitorId)}/messages`, {
      method: "POST",
      body: { content },
    });
  }

  async legacyCancelAutonomous(monitorId: string): Promise<Record<string, unknown>> {
    return this.requestV1(`/autonomous/${encodeURIComponent(monitorId)}/cancel`, { method: "POST" });
  }

  async legacyApproveAutonomous(
    monitorId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<Record<string, unknown>> {
    return this.requestV1(`/autonomous/${encodeURIComponent(monitorId)}/approve`, {
      method: "POST",
      body: { approval_id: approvalId, approved },
    });
  }

  async legacyGetTask(taskId: string): Promise<Task> {
    return this.requestV1(`/tasks/${encodeURIComponent(taskId)}`);
  }

  async legacyGetTaskOutput(taskId: string): Promise<TaskOutput> {
    return this.requestV1(`/tasks/${encodeURIComponent(taskId)}/output`);
  }

  async legacySendMessage(taskId: string, content: string): Promise<Record<string, unknown>> {
    return this.requestV1(`/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: { content },
    });
  }

  async legacyCancelTask(taskId: string): Promise<Task> {
    return this.requestV1(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
  }

  private async requestV1<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("/api/control/v1", path, options);
  }

  private async requestV2<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("/api/control/v2", path, options);
  }

  private async request<T>(
    prefix: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${prefix}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = payload?.detail;
        const code = typeof detail?.code === "string" ? detail.code : "computer_api_error";
        const message = typeof detail === "string" ? detail : code;
        throw new ComputerApiError(response.status, message, code);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof ComputerApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ComputerApiError(504, "CPTR request timed out", "computer_api_timeout");
      }
      throw new ComputerApiError(502, "CPTR request failed", "computer_api_unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function clientFromEnvironment(env = process.env): ComputerClient {
  return new ComputerClient({
    baseUrl: env.CPTR_BASE_URL ?? "",
    token: env.CPTR_API_TOKEN ?? "",
  });
}
