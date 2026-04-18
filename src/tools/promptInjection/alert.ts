import type { Tool } from "../types.js";
import { getStringArg } from "../shared/args.js";

export const promptInjectionAlertTool: Tool = {
    name: "prompt_injection.alert",
    description: "Record a suspected prompt injection attempt.",
    execute(args) {
        const perpetrator = getStringArg(args, "perpetrator") ?? "unknown user";
        const description = getStringArg(args, "description") ?? "No description provided.";

        return {
            success: true,
            result: `Prompt injection alert recorded for ${perpetrator}: ${description}`
        };
    }
};
