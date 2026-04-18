import { handleEmailCommand } from "./command.js";
import type { Tool } from "../types.js";
import { getStringArg } from "../shared/args.js";

export const emailCommandTool: Tool = {
    name: "email.command",
    description: "Execute explicit email commands.",
    async execute(args, context) {
        const content = getStringArg(args, "content");
        if (!content) {
            return {
                success: false,
                reason: "Missing email command content."
            };
        }

        if (!context.actorId || !context.bus) {
            return {
                success: false,
                reason: "Email command execution is not configured."
            };
        }

        return {
            success: true,
            result: await handleEmailCommand({
                actorId: context.actorId,
                bus: context.bus,
                content,
                conversationId: context.conversationId ?? "",
                persistence: context.persistence
            })
        };
    }
};
