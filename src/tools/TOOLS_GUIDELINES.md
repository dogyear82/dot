#Tools Guidelines

Every tool for Dot should live in it's own folder under /src/tools.  For example, the reminder tool's source code and prompt .md files will be located at:

- /src/tools/reminder

## Tool Architecture

Each tool object shall have 3 public facing endpoints; name, description, and execute (function). Name and description are just strings that are hardcoded into the tool.  Execute(args: string[]):string is where the tool actual does its work, and it'll arrange it's result however it sees fit and returns it as a string back to the 
