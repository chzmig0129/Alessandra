/**
 * Canonical shared types for Alessandra agent.
 * Keep this file free of circular imports — define all shapes locally.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export type Domain =
  | "mundial"
  | "puntos_violeta"
  | "reportes"
  | "fuera_alcance"
  | null;

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
  /** Present when role === 'tool' */
  toolCallId?: string;
  /** Present when role === 'assistant' and the message triggered tool calls */
  toolCalls?: ToolCall[];
}

// ---------------------------------------------------------------------------
// ToolCall
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON-serialisable arguments passed to the tool */
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// FlowState
// ---------------------------------------------------------------------------

/**
 * Represents the in-progress state of a domain-specific conversation flow.
 * Defined locally to avoid circular imports with @/memory/flow-state.
 */
export type FlowStatus =
  | "idle"
  | "active"
  | "waiting_user"
  | "completed"
  | "cancelled";

export interface FlowState {
  domain: Domain;
  status: FlowStatus;
  /** Accumulated slot values gathered so far */
  slots: Record<string, unknown>;
  /** Current state machine node name (domain-specific) */
  currentState: string;
  /** ISO timestamp when this flow was last updated */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// AlessandraResponse
// ---------------------------------------------------------------------------

export interface AlessandraResponse {
  text: string;
  suggestions?: string[];
  attachments?: Attachment[];
  debug?: Record<string, unknown>;
}

export interface Attachment {
  type: "image" | "document" | "link";
  url: string;
  label?: string;
}
