import { sillyTool } from "./tools/sillyTool.js";

type Tool = {
    name: string,
    description: string,
    execute(args: any): string;
};

const tools: Record<string, Tool> = {
    [sillyTool.name]: sillyTool
};

export async function executeTool(name: string, args: any): Promise<string> {
    const tool = tools[name];

    if (!tool) {
    throw new Error(`executeTool is not implemented for tool "${name}"`);
    }

    return tool.execute(args);
}
