export const sillyTool = {
    name: "Silly Tool",
    description: "Just for funzies",
    execute(args: any): string {
        return `This is the string that's silly! ${args}`
    }
}