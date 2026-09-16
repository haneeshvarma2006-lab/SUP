/**
 * Tool contracts shared with the UI (the agent panel lists an agent's
 * capabilities, and the approval dialog explains what a tool does).
 *
 * The executable side of a tool lives on the server; this is the metadata the
 * client is allowed to know about.
 */

import type { ToolRisk } from './permissions.js';

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaNode {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

/** Public description of a tool. Safe to send to any workspace member. */
export interface ToolDescriptor {
  name: string;
  /** Grouping for the UI: `communication`, `tasks`, `memory`, `files`, ... */
  category: string;
  title: string;
  description: string;
  risk: ToolRisk;
  parameters: ToolParameterSchema;
  /** When true the tool blocks on a human approval if the workspace requires it. */
  requiresApproval: boolean;
  /**
   * Tools only the orchestrator may hold, regardless of an agent's capability
   * list — prevents a specialist from re-planning the whole objective.
   */
  orchestratorOnly: boolean;
}

/** Canonical tool names used by the built-in agent roles. */
export const TOOL_NAMES = {
  // communication
  sendMessage: 'send_message',
  askAgent: 'ask_agent',
  askHuman: 'ask_human',
  broadcastEvent: 'broadcast_event',
  returnResult: 'return_result',
  // tasks
  createTask: 'create_task',
  assignTask: 'assign_task',
  delegateTask: 'delegate_task',
  updateTask: 'update_task',
  requestReview: 'request_review',
  listTasks: 'list_tasks',
  // memory
  memorySearch: 'memory_search',
  memoryWrite: 'memory_write',
  // files
  fileWrite: 'file_write',
  fileRead: 'file_read',
  fileList: 'file_list',
  // external
  webSearch: 'web_search',
  httpRequest: 'http_request',
  codeExec: 'code_exec',
  generateDocument: 'generate_document',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
