import type { InboundMessageReceivedEvent } from "../events.js";
import type { ChatService, LlmRoute } from "../chat/modelRouter.js";
import type { ConversationTurnRecord, IncomingMessage } from "../types.js";

export interface PipelineContext {
    event: InboundMessageReceivedEvent;
    content: string;
    conversationId: string;
    currentSpeakerLabel: string;
    incomingMessage: IncomingMessage;
    isExplicitCommand: boolean;
    recentConversation: ConversationTurnRecord[];
}

export interface RoutingData {
    addressed: boolean;
    reason: string;
    route: MessageRoute | null;
}

export type MessageRoute =
    | {
        name: "respond";
        reason: string;
        instructions: string;
    }
    | {
        name: "execute_tool";
        toolName: string;
        reason: string;
        args: Record<string, string | number>;
    };


export interface ReplyPublisher {
    saveUserConversationTurn(): void;
    publishReply(reply: string, route?: LlmRoute, recordConversationTurn?: boolean): Promise<void>;
}

export interface ChatServiceWithOptionalAddressedness extends ChatService {
    inferAddressedToolDecision?: ChatService["inferAddressedToolDecision"];
}
