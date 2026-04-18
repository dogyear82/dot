import type { Logger } from "pino";

import type { ChatService } from "../chat/modelRouter.js";
import type { Persistence } from "../persistence.js";
import type { ReplyPublisher } from "./types.js";

export async function executeConversationResponse(params: {
    chatService: ChatService;
    content: string;
    conversationId: string;
    currentSpeakerLabel: string;
    logger: Logger;
    logMessage: string;
    messageId: string;
    persistence: Persistence;
    publisher: ReplyPublisher;
}): Promise<{ route: import("../chat/modelRouter.js").LlmRoute }> {
    params.publisher.saveUserConversationTurn();
    const updatedConversation = params.persistence.listRecentConversationTurns(params.conversationId, 10);
    const response = await params.chatService.generateOwnerReply({
        userMessage: params.content,
        recentConversation: updatedConversation.slice(0, -1),
        currentSpeakerLabel: params.currentSpeakerLabel
    });
    params.logger.info(
        { route: response.route, powerStatus: response.powerStatus, messageId: params.messageId },
        params.logMessage
    );
    await params.publisher.publishReply(response.reply, response.route, false);

    return { route: response.route };
}
