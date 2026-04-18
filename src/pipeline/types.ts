import type { InboundMessageReceivedEvent } from "../events.js";
import type { ChatService, LlmPowerStatus, LlmRoute } from "../chat/modelRouter.js";
import type { ConversationTurnRecord, IncomingMessage, PendingConversationalToolSessionRecord } from "../types.js";

export interface PipelineContext {
    event: InboundMessageReceivedEvent;
    content: string;
    conversationId: string;
    currentSpeakerLabel: string;
    incomingMessage: IncomingMessage;
    isExplicitCommand: boolean;
    recentConversation: ConversationTurnRecord[];
}

export interface PrecomputedIntentDecision {
    route: LlmRoute;
    powerStatus: LlmPowerStatus;
    decision: import("../toolInvocation.js").ConversationalIntentDecision;
}

export interface AddressedRouteResult {
    addressed: boolean;
    addressedReason: string;
    precomputedIntentDecision: PrecomputedIntentDecision | null;
}

export interface ReplyPublisher {
    saveUserConversationTurn(): void;
    publishReply(reply: string, route?: LlmRoute, recordConversationTurn?: boolean): Promise<void>;
}

export interface ChatServiceWithOptionalAddressedness extends ChatService {
    inferAddressedToolDecision?: ChatService["inferAddressedToolDecision"];
}
