import type { InboundMessageReceivedEvent } from "../events.js";
import type { ConversationTurnRecord, IncomingMessage } from "../types.js";

export type LlmRoute = "none" | "local" | "hosted";

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
    saveUserConversationTurn(): Promise<void>;
    publishReply(reply: string, route?: LlmRoute, recordConversationTurn?: boolean): Promise<void>;
}
