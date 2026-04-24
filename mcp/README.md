# dot-mcp

Minimal Streamable HTTP MCP server with one Open-Meteo-backed weather tool.

## Features

- MCP over Streamable HTTP at `/mcp`
- Health check at `/health`
- One tool: `get_weather_by_city`
- Provider-driven location disambiguation using Open-Meteo geocoding results

## Run locally

```bash
npm install
npm run dev
```

The server listens on `127.0.0.1:8000` by default.

To run the compiled build:

```bash
npm run build
npm start
```

## Test

```bash
npm test
```

## Container

Build with Podman or Docker:

```bash
podman build -t dot-mcp .
podman run --rm -p 8000:8000 dot-mcp
```

## Tool behavior

`get_weather_by_city` returns one of these result variants:

- `weather_found`
- `location_ambiguous`
- `location_not_found`
- `provider_error`

When Open-Meteo returns multiple location matches, the tool passes those candidates back to the client so the AI can ask the user to clarify and retry.
If the retry includes qualifiers such as `Springfield, Missouri`, the server falls back to searching the base city and filtering Open-Meteo candidates by the qualifier text.

## Configuration

- `DOT_MCP_HOST` default: `127.0.0.1`
- `DOT_MCP_PORT` default: `8000`
- `DOT_MCP_WEATHER_SEARCH_LIMIT` default: `5`
