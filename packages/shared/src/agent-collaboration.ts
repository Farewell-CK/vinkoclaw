import { randomUUID } from "node:crypto";
import type {
  AgentCollaboration,
  AgentMessage,
  CollaborationConfig,
  CollaborationPhase,
  CreateAgentCollaborationInput,
  RoleId,
  SendAgentMessageInput,
  VinkoStore
} from "./index.js";

const DEFAULT_COLLABORATION_CONFIG: CollaborationConfig = {
  maxRounds: 3,
  discussionTimeoutMs: 30 * 60 * 1000,
  requireConsensus: false,
  pushIntermediateResults: true,
  autoAggregateOnComplete: true,
  aggregateTimeoutMs: 60 * 60 * 1000
};

export class AgentCollaborationService {
  constructor(private store: VinkoStore) {}

  createCollaboration(input: CreateAgentCollaborationInput): AgentCollaboration {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    const runtimeDefaults = this.store.getRuntimeConfig().collaboration.defaultParticipants;
    const defaultParticipants: RoleId[] =
      runtimeDefaults.length > 0
        ? runtimeDefaults
        : ["product", "uiux", "frontend", "backend", "qa", "cto"];

    const defaultFacilitator: RoleId = defaultParticipants.includes("cto") ? "cto" : defaultParticipants[0] ?? "product";

    const collaboration: AgentCollaboration = {
      id,
      parentTaskId: input.parentTaskId,
      status: "active",
      participants: input.participants ?? defaultParticipants,
      facilitator: input.facilitator ?? defaultFacilitator,
      currentPhase: "classify",
      phaseResults: [],
      config: { ...DEFAULT_COLLABORATION_CONFIG, ...input.config },
      createdAt: timestamp,
      updatedAt: timestamp
    };

    if (input.sessionId !== undefined) {
      collaboration.sessionId = input.sessionId;
    }

    if (input.chatId !== undefined) {
      collaboration.chatId = input.chatId;
    }

    this.store.createAgentCollaboration(collaboration);
    this.store.createCollaborationTimelineEvent({
      collaborationId: id,
      eventType: "collaboration_started",
      message: "Collaboration started",
      roleId: collaboration.facilitator,
      taskId: collaboration.parentTaskId,
      metadata: {
        participants: collaboration.participants,
        facilitator: collaboration.facilitator
      }
    });

    return collaboration;
  }

  getCollaboration(id: string): AgentCollaboration | undefined {
    return this.store.getAgentCollaboration(id);
  }

  getCollaborationByParentTask(parentTaskId: string): AgentCollaboration | undefined {
    const collaborations = this.store.listAgentCollaborationsByParentTask(parentTaskId);
    return collaborations[0];
  }

  sendMessage(input: SendAgentMessageInput): AgentMessage {
    const message: AgentMessage = {
      id: randomUUID(),
      collaborationId: input.collaborationId,
      taskId: input.taskId,
      fromRoleId: input.fromRoleId,
      toRoleIds: input.toRoleIds,
      messageType: input.messageType,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString()
    };

    this.store.createAgentMessage(message);
    this.store.createCollaborationTimelineEvent({
      collaborationId: input.collaborationId,
      eventType:
        input.messageType === "task_assignment"
          ? "task_assigned"
          : input.messageType === "summary"
            ? "aggregation_started"
            : "status",
      message: input.content.slice(0, 500),
      roleId: input.fromRoleId,
      taskId: input.taskId,
      agentInstanceId: input.metadata?.agentInstanceId,
      metadata: {
        toRoleIds: input.toRoleIds,
        messageType: input.messageType,
        ...(input.metadata ?? {})
      }
    });

    return message;
  }

  broadcast(
    collaborationId: string,
    taskId: string,
    fromRoleId: RoleId,
    messageType: AgentMessage["messageType"],
    content: string,
    metadata?: AgentMessage["metadata"]
  ): AgentMessage {
    const collaboration = this.store.getAgentCollaboration(collaborationId);
    if (!collaboration) {
      throw new Error(`Collaboration ${collaborationId} not found`);
    }

    const input: SendAgentMessageInput = {
      collaborationId,
      taskId,
      fromRoleId,
      toRoleIds: collaboration.participants.filter((r) => r !== fromRoleId),
      messageType,
      content
    };
    if (metadata !== undefined) {
      input.metadata = metadata;
    }
    return this.sendMessage(input);
  }

  advancePhase(collaborationId: string, nextPhase: CollaborationPhase): void {
    this.store.updateAgentCollaboration(collaborationId, {
      currentPhase: nextPhase,
      updatedAt: new Date().toISOString()
    });
    this.store.createCollaborationTimelineEvent({
      collaborationId,
      eventType: "phase_changed",
      message: `Phase switched to ${nextPhase}`,
      metadata: {
        phase: nextPhase
      }
    });
  }

  recordPhaseResult(
    collaborationId: string,
    phase: string,
    roleId: RoleId,
    summary: string
  ): void {
    const collaboration = this.store.getAgentCollaboration(collaborationId);
    if (!collaboration) return;

    const phaseResults = [...collaboration.phaseResults];
    let phaseRecord = phaseResults.find((p) => p.phase === phase);

    if (!phaseRecord) {
      phaseRecord = { phase, completedBy: [], outputs: [] };
      phaseResults.push(phaseRecord);
    }

    if (!phaseRecord.completedBy.includes(roleId)) {
      phaseRecord.completedBy.push(roleId);
    }

    const existingOutput = phaseRecord.outputs.find((o) => o.roleId === roleId);
    if (existingOutput) {
      existingOutput.summary = summary;
    } else {
      phaseRecord.outputs.push({ roleId, summary });
    }

    this.store.updateAgentCollaboration(collaborationId, {
      phaseResults,
      updatedAt: new Date().toISOString()
    });
    this.store.createCollaborationTimelineEvent({
      collaborationId,
      eventType: "task_completed",
      roleId,
      message: `Role ${roleId} submitted phase result`,
      metadata: {
        phase,
        summary: summary.slice(0, 500)
      }
    });
  }

  isPhaseCompleted(collaborationId: string, phase: string): boolean {
    const collaboration = this.store.getAgentCollaboration(collaborationId);
    if (!collaboration) return false;

    const phaseRecord = collaboration.phaseResults.find((p) => p.phase === phase);
    if (!phaseRecord) return false;

    return collaboration.participants.every((p) => phaseRecord!.completedBy.includes(p));
  }

  getPhaseProgress(collaborationId: string, phase: string): {
    completed: RoleId[];
    pending: RoleId[];
  } {
    const collaboration = this.store.getAgentCollaboration(collaborationId);
    if (!collaboration) {
      return { completed: [], pending: [] };
    }

    const phaseRecord = collaboration.phaseResults.find((p) => p.phase === phase);
    if (!phaseRecord) {
      return { completed: [], pending: collaboration.participants };
    }

    return {
      completed: phaseRecord.completedBy,
      pending: collaboration.participants.filter((p) => !phaseRecord!.completedBy.includes(p))
    };
  }

  completeCollaboration(collaborationId: string): void {
    const timestamp = new Date().toISOString();
    this.store.updateAgentCollaboration(collaborationId, {
      status: "completed",
      currentPhase: "completed",
      completedAt: timestamp,
      updatedAt: timestamp
    });
    this.store.createCollaborationTimelineEvent({
      collaborationId,
      eventType: "collaboration_completed",
      message: "Collaboration completed",
      metadata: {}
    });
  }

  failCollaboration(collaborationId: string): void {
    const timestamp = new Date().toISOString();
    this.store.updateAgentCollaboration(collaborationId, {
      status: "failed",
      updatedAt: timestamp
    });
    this.store.createCollaborationTimelineEvent({
      collaborationId,
      eventType: "collaboration_failed",
      message: "Collaboration failed",
      metadata: {}
    });
  }

  listMessages(collaborationId: string): AgentMessage[] {
    return this.store.listAgentMessages(collaborationId);
  }

  listMessagesByTask(taskId: string): AgentMessage[] {
    return this.store.listAgentMessagesByTask(taskId);
  }
}
