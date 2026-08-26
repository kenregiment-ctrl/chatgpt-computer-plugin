export type Workspace = {
  workspace_id: string;
  name: string;
  path?: string;
};

export type GitDiff = Record<string, unknown>;

export type DirectInspectionList = {
  workspace_id: string;
  path: string;
  entries: Array<{
    name: string;
    type: string;
    size: number | null;
    modified: string | null;
  }>;
  next_cursor: number | null;
  truncated: boolean;
};

export type DirectFileRead = {
  workspace_id: string;
  path: string;
  content: string;
  revision: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  size: number;
};

/** A durable operation owned by the caller, not by CPTR's agent loop. */
export type DirectOperation = {
  operation_id: string;
  workspace_id: string;
  kind: "WRITE_FILE" | "EDIT_FILE" | "RUN_ACTION" | "RUN_CODE_BLOCK" | "SSH_EXECUTE";
  state:
    | "REQUESTED"
    | "WAITING_APPROVAL"
    | "QUEUED"
    | "DISPATCHING"
    | "RUNNING"
    | "CANCEL_REQUESTED"
    | "SUCCEEDED"
    | "FAILED"
    | "CANCELLED"
    | "REJECTED"
    | "ORPHANED";
  approval_id: string | null;
  result: Record<string, unknown>;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  replayed?: boolean;
};

export type DirectOperationEvents = {
  operation_id: string;
  events: Array<{
    event_id: string;
    event_type: string;
    state: string | null;
    payload: Record<string, unknown>;
    created_at: number;
  }>;
  next_cursor: string | null;
};


// Explicit compatibility fallback types. These are not used by default durable
// direct-operation tools and retain model_id only for the pre-existing CPTR
// agent workflow.
export type Task = {
  id: string;
  workspace_id: string;
  chat_id: string;
  message_id: string;
  status: string;
  prompt: string;
  model_id: string;
  output: string;
  raw_output?: unknown[];
  error?: string | null;
  created_at?: number;
  updated_at?: number;
};

export type TaskOutput = {
  task_id: string;
  status: string;
  content: string;
  raw_output?: unknown[];
};

export type DirectTaskExecution = {
  task_id: string;
  workspace_id: string;
  status: string;
  output: string;
  output_truncated: boolean;
  error?: string | null;
  completed: boolean;
  wait_seconds: number;
};
