export interface Command {
    name: string;
    description: string;
    ownerOnly?: boolean;
    matches(input: string): boolean;
    execute(input: string): Promise<string> | string;
}
