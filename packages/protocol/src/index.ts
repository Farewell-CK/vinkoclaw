import { z } from "zod";

export const roleIdSchema = z.enum([
  "ceo",
  "cto",
  "product",
  "uiux",
  "frontend",
  "backend",
  "algorithm",
  "qa",
  "developer",
  "engineering",
  "research",
  "operations"
]);

export const taskSourceSchema = z.enum(["control-center", "feishu", "email", "system"]);

export const taskAttachmentSchema = z.object({
  kind: z.enum(["image", "video"]),
  url: z.string().trim().min(1),
  detail: z.enum(["auto", "low", "high"]).optional(),
  name: z.string().trim().min(1).optional()
});

export const taskMetadataSchema = z.record(z.string(), z.unknown());

export const orchestratorCreateTaskSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  source: taskSourceSchema.optional(),
  roleId: roleIdSchema.optional(),
  title: z.string().trim().min(1).optional(),
  instruction: z.string().trim().min(1),
  priority: z.number().int().min(0).max(100).optional(),
  chatId: z.string().trim().min(1).optional(),
  requestedBy: z.string().trim().min(1).optional(),
  metadata: taskMetadataSchema.optional(),
  attachments: z.array(taskAttachmentSchema).max(20).optional()
});

export const orchestratorInboundMessageSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1),
  source: taskSourceSchema.optional(),
  requestedBy: z.string().trim().min(1).optional(),
  chatId: z.string().trim().min(1).optional(),
  clientActionId: z.string().trim().min(1).max(160).optional(),
  attachments: z.array(taskAttachmentSchema).max(20).optional()
});

export const sessionActionKindSchema = z.enum(["continue", "supplement", "rerun-goalrun"]);

export const orchestratorSessionActionSchema = z.object({
  action: sessionActionKindSchema,
  actionId: z.string().trim().min(1).max(160).optional(),
  text: z.string().trim().min(1).optional(),
  source: taskSourceSchema.optional(),
  requestedBy: z.string().trim().min(1).optional(),
  chatId: z.string().trim().min(1).optional(),
  attachments: z.array(taskAttachmentSchema).max(20).optional()
});

export const orchestratorApprovalDecisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  decidedBy: z.string().trim().min(1),
  decisionNote: z.string().trim().max(4000).optional()
});

export const orchestratorTaskSplitSchema = z.object({
  requestedBy: z.string().trim().min(1).optional(),
  strategy: z.enum(["auto", "manual"]).optional(),
  maxTasks: z.number().int().min(1).max(12).optional(),
  tasks: z
    .array(
      z.object({
        roleId: roleIdSchema,
        title: z.string().trim().min(1),
        instruction: z.string().trim().min(1),
        priority: z.number().int().min(0).max(100).optional()
      })
    )
    .max(12)
    .optional()
});

export const orchestratorApprovalStepDecisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  decidedBy: z.string().trim().min(1),
  decisionNote: z.string().trim().max(4000).optional()
});

export const orchestratorApprovalEscalationSchema = z.object({
  roleId: roleIdSchema,
  requestedBy: z.string().trim().min(1).optional(),
  note: z.string().trim().max(4000).optional()
});

export const protocolMethodSchema = z.enum([
  "orchestrator.task.create",
  "orchestrator.message.inbound",
  "orchestrator.approval.decide"
]);

const methodPayloadSchemas = {
  "orchestrator.task.create": orchestratorCreateTaskSchema,
  "orchestrator.message.inbound": orchestratorInboundMessageSchema,
  "orchestrator.approval.decide": orchestratorApprovalDecisionSchema
} as const;

export const protocolEnvelopeSchema = z.object({
  method: protocolMethodSchema,
  payload: z.unknown()
});

export type OrchestratorCreateTaskInput = z.infer<typeof orchestratorCreateTaskSchema>;
export type OrchestratorInboundMessageInput = z.infer<typeof orchestratorInboundMessageSchema>;
export type SessionActionKind = z.infer<typeof sessionActionKindSchema>;
export type OrchestratorSessionActionInput = z.infer<typeof orchestratorSessionActionSchema>;
export type OrchestratorApprovalDecisionInput = z.infer<typeof orchestratorApprovalDecisionSchema>;
export type ProtocolMethod = z.infer<typeof protocolMethodSchema>;
export type ProtocolEnvelopeInput = z.infer<typeof protocolEnvelopeSchema>;
export type ProtocolPayloadByMethod = {
  "orchestrator.task.create": OrchestratorCreateTaskInput;
  "orchestrator.message.inbound": OrchestratorInboundMessageInput;
  "orchestrator.approval.decide": OrchestratorApprovalDecisionInput;
};
export type ValidatedProtocolEnvelope =
  | {
      method: "orchestrator.task.create";
      payload: OrchestratorCreateTaskInput;
    }
  | {
      method: "orchestrator.message.inbound";
      payload: OrchestratorInboundMessageInput;
    }
  | {
      method: "orchestrator.approval.decide";
      payload: OrchestratorApprovalDecisionInput;
    };

export function validateProtocolPayload<TMethod extends ProtocolMethod>(
  method: TMethod,
  payload: unknown
): ProtocolPayloadByMethod[TMethod] {
  return methodPayloadSchemas[method].parse(payload) as ProtocolPayloadByMethod[TMethod];
}

export function validateProtocolEnvelope(input: unknown): ValidatedProtocolEnvelope {
  const envelope = protocolEnvelopeSchema.parse(input);
  switch (envelope.method) {
    case "orchestrator.task.create":
      return {
        method: envelope.method,
        payload: validateProtocolPayload(envelope.method, envelope.payload)
      };
    case "orchestrator.message.inbound":
      return {
        method: envelope.method,
        payload: validateProtocolPayload(envelope.method, envelope.payload)
      };
    case "orchestrator.approval.decide":
      return {
        method: envelope.method,
        payload: validateProtocolPayload(envelope.method, envelope.payload)
      };
  }
}
