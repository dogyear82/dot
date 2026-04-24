# Minimal Weather MCP Server Requirements

## Problem Statement

A custom AI assistant needs a small MCP server that can expose external capabilities through a standard protocol without coupling the assistant to tool-specific integrations. The immediate need is to let any MCP-compatible client call a weather tool and receive current weather data from Open-Meteo so the assistant can answer user questions about weather.

The server should remain intentionally small for v1 so it is easy to understand, containerize, operate, and extend. The initial version must implement standard MCP server discovery behavior and exactly one functional tool for weather lookup, while the internal design should make it straightforward to add new tools, prompts, and resources later without major restructuring.

## User Personas

### Primary Persona

- Developer/operator of a custom AI application who wants to connect the app to external capabilities through MCP.

### Secondary Personas

- Any MCP-compatible client or agent that can consume tools from a standards-compliant MCP server.
- Future maintainers who will add additional tools, prompts, or resources after the initial release.

## Core Use Cases

- An MCP client connects to the server over Streamable HTTP and discovers the server's supported MCP capabilities.
- An MCP client lists the tools exposed by the server and sees a weather tool available for invocation.
- An MCP client invokes the weather tool with a location input and receives normalized weather data sourced from Open-Meteo.
- An operator starts the server in a container using Podman or Docker with minimal setup.
- A maintainer adds a new MCP capability later, such as another tool or prompt, without rewriting the server's core request-handling architecture.

## Functional Requirements

- The system shall implement an MCP server accessible over Streamable HTTP.
- The system shall expose the standard MCP discovery surfaces needed for compatible clients to identify server capabilities and available endpoints.
- The system shall expose exactly one domain-specific tool in v1: a weather tool.
- The weather tool shall accept location-related input sufficient to retrieve weather from Open-Meteo.
- The weather tool shall call the Open-Meteo API to retrieve weather data.
- The weather tool shall return structured data suitable for LLM consumption rather than raw HTML or other presentation-oriented output.
- The server shall handle invalid tool inputs with explicit error responses.
- The server shall handle upstream Open-Meteo failures with explicit error responses that clients can surface or interpret.
- The server shall separate MCP protocol handling from tool implementation logic.
- The server shall organize tool registration so additional tools can be added with minimal changes outside the new tool module and its registration wiring.
- The server shall be designed so prompts and resources can be added later without requiring a fundamental redesign of the server structure.
- The system shall provide configuration for runtime concerns needed by container deployment, such as bind address and port.
- The system shall include a container build definition that allows the server to be run with Podman.
- The system shall also be runnable with Docker using the same container image definition or an equivalent compatible flow.

## Non-Functional Requirements

- The implementation shall prioritize simplicity and low operational overhead over feature breadth in v1.
- The implementation shall be small enough that a single developer can understand the codebase structure quickly.
- The server shall start reliably inside a container with a minimal runtime footprint.
- The server shall not require prompts or resources to be implemented in v1.
- The architecture shall favor maintainability and modularity so future MCP capabilities can be added incrementally.
- The server shall avoid unnecessary external dependencies beyond those needed for MCP transport, HTTP serving, and Open-Meteo integration.
- The server shall return responses quickly enough for interactive assistant use, subject to upstream Open-Meteo latency.
- The server shall log operationally useful errors for startup failures, request failures, and upstream API errors.

## Constraints

- Transport for v1 is Streamable HTTP.
- Weather provider for v1 is Open-Meteo.
- Scope for v1 is limited to standard MCP behavior plus one weather tool.
- Prompt templates are explicitly out of scope for v1.
- MCP resources are explicitly out of scope for v1.
- The server must be containerized.
- Podman is the preferred container runtime, though Docker compatibility is also required.
- The project should remain intentionally small at the start.

## Repository Structure

The repository should use a small modular layout that keeps MCP protocol handling, tool logic, and operational assets separate. The structure should make it easy to add new tools, and later add prompts and resources, without reorganizing the entire codebase.

Suggested baseline structure:

```text
.
|-- Containerfile
|-- package.json
|-- package-lock.json
|-- README.md
|-- requirements/
|   `-- minimal-weather-mcp-server.md
|-- src/
|   |-- index.ts
|   |-- config.ts
|   |-- server.ts
|   |-- tools/
|   |   `-- weather.ts
|   |-- integrations/
|   |   `-- openMeteo.ts
|   |-- models/
|   |   `-- weather.ts
|   |-- prompts/
|   `-- resources/
|-- tests/
|   |-- server.test.ts
|   |-- weatherTool.test.ts
|   `-- openMeteo.test.ts
|-- .gitignore
`-- tsconfig.json
```

Repository structure intent:

- `Containerfile` defines the preferred Podman-compatible container build.
- `package.json` defines project metadata, dependencies, and npm scripts.
- `package-lock.json` locks dependency resolution for repeatable installs and container builds.
- `README.md` explains local development, container usage, and supported MCP capabilities.
- `requirements/` stores requirements and other planning artifacts.
- `src/index.ts` is the application entrypoint.
- `src/config.ts` contains runtime configuration such as host, port, and provider-related settings.
- `src/server.ts` contains HTTP app assembly, MCP transport setup, and tool registration.
- `src/tools/` contains MCP tool logic.
- `src/integrations/` contains external service clients, starting with Open-Meteo.
- `src/models/` contains internal domain models shared across tools and integrations.
- `src/prompts/` is reserved for future MCP prompt support and may remain mostly empty in v1.
- `src/resources/` is reserved for future MCP resource support and may remain mostly empty in v1.
- `tests/` contains unit and integration tests for protocol behavior, tool behavior, and provider integration.
- `tsconfig.json` defines TypeScript compilation behavior and project type checking.

## Open Questions

- What exact weather operations should v1 support: current conditions only, forecast, or both?
- What input shape should the weather tool accept: city name, latitude/longitude, or both?
- If city names are supported, how should geocoding be handled before querying Open-Meteo?
- What response schema should be standardized for LLM consumption?
- Should the server expose only one tool method for weather, or separate methods such as current weather and forecast?
- What authentication or network controls, if any, are required when the Streamable HTTP server is deployed?
- What observability level is needed in v1 beyond basic logs, such as health endpoints or structured logging?
- What implementation language and MCP SDK should be used?
