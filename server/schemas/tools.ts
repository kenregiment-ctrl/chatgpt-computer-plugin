import { z } from "zod";

export const workspaceIdSchema = { workspace_id: z.string().min(1).max(200) };
export const operationIdSchema = { operation_id: z.string().min(1).max(200) };

export const inspectListSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000).default("."),
  cursor: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(200).default(100),
};

export const inspectReadSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000),
  start_line: z.number().int().min(0).max(1_000_000).default(0),
  end_line: z.number().int().min(0).max(1_000_000).default(0),
};

const idempotencyKey = z.string().min(1).max(200);

export const writeOperationSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000),
  content: z.string().max(1_000_000),
  expected_revision: z.string().min(1).max(200),
  idempotency_key: idempotencyKey,
};

export const editOperationSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000),
  target: z.string().min(1).max(1_000_000),
  replacement: z.string().max(1_000_000),
  expected_revision: z.string().min(1).max(200),
  idempotency_key: idempotencyKey,
};

export const actionOperationSchema = {
  workspace_id: z.string().min(1).max(200),
  action: z.enum(["lint", "test", "typecheck", "build"]),
  idempotency_key: idempotencyKey,
};

export const operationEventsSchema = {
  operation_id: z.string().min(1).max(200),
  cursor: z.string().min(1).max(300).optional(),
  limit: z.number().int().min(1).max(100).default(50),
};

export const cancelOperationSchema = {
  operation_id: z.string().min(1).max(200),
  idempotency_key: idempotencyKey,
  reason: z.string().max(1_000).default("cancel requested"),
};

export const approveOperationSchema = {
  operation_id: z.string().min(1).max(200),
  approved: z.boolean(),
  idempotency_key: idempotencyKey,
};


// Explicit compatibility fallback schemas. These retain the existing CPTR
// agent workflow only when durable direct operations cannot satisfy the user.
export const taskIdSchema = { task_id: z.string().min(1).max(200) };
export const monitorIdSchema = { monitor_id: z.string().min(1).max(200) };

export const startTaskSchema = {
  workspace_id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  model_id: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(200).optional(),
};

export const executeTaskSchema = {
  workspace_id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  model_id: z.string().min(1).max(500),
  wait_seconds: z.number().int().min(1).max(60).default(30),
  idempotency_key: z.string().min(1).max(200).optional(),
};

export const monitorAutonomousSchema = {
  workspace_id: z.string().min(1).max(200),
  goal: z.string().min(1).max(100_000),
  acceptance_criteria: z.array(z.string().min(1).max(10_000)).min(1).max(100),
  model_id: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(200).optional(),
};

export const messageSchema = {
  task_id: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
};

export const steerAutonomousSchema = {
  monitor_id: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
};

export const approveAutonomousSchema = {
  monitor_id: z.string().min(1).max(200),
  approval_id: z.string().min(1).max(200),
  approved: z.boolean(),
};


export const codeBlockOperationSchema = {
  workspace_id: z.string().min(1).max(200),
  language: z.enum(["python", "javascript", "typescript", "bash"]),
  code: z.string().min(1).max(200_000),
  idempotency_key: idempotencyKey,
};

export const sshOperationSchema = {
  workspace_id: z.string().min(1).max(200),
  ssh_profile: z.string().min(1).max(100),
  ssh_action: z.string().min(1).max(100),
  idempotency_key: idempotencyKey,
};
