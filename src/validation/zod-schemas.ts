/**
 * Reusable Zod schemas for Alessandra agent.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// ToolErrorSchema
// ---------------------------------------------------------------------------

export const ToolErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
});

export type ToolError = z.infer<typeof ToolErrorSchema>;

// ---------------------------------------------------------------------------
// LatLngSchema
// ---------------------------------------------------------------------------

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export type LatLng = z.infer<typeof LatLngSchema>;

// ---------------------------------------------------------------------------
// PhoneSchema — Mexican number, leading +52 optional
// Accepts: +521234567890, 1234567890, 55 1234 5678, etc.
// ---------------------------------------------------------------------------

export const PhoneSchema = z.string().regex(
  /^(?:\+52\s?)?(?:\d[\s-]?){10}$/,
  "Número de teléfono inválido (se esperan 10 dígitos, código MX +52 opcional)",
);

// ---------------------------------------------------------------------------
// MessageSchema
// ---------------------------------------------------------------------------

export const MessageRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
]);

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
});

export const MessageSchema = z.object({
  id: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: z.date(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
});

export type ParsedMessage = z.infer<typeof MessageSchema>;

// ---------------------------------------------------------------------------
// FlowStateSchema
// ---------------------------------------------------------------------------

export const FlowStatusSchema = z.enum([
  "idle",
  "active",
  "waiting_user",
  "completed",
  "cancelled",
]);

export const DomainSchema = z
  .enum(["mundial", "puntos_violeta", "reportes", "fuera_alcance"])
  .nullable();

export const FlowStateSchema = z.object({
  domain: DomainSchema,
  status: FlowStatusSchema,
  slots: z.record(z.unknown()),
  currentState: z.string(),
  updatedAt: z.string(),
});

export type ParsedFlowState = z.infer<typeof FlowStateSchema>;

// ---------------------------------------------------------------------------
// FolioSchema — CUH-YYYYMMDD-NNN
// ---------------------------------------------------------------------------

export const FolioSchema = z.string().regex(
  /^CUH-\d{8}-\d{3}$/,
  "Folio inválido (formato esperado: CUH-YYYYMMDD-NNN)",
);
