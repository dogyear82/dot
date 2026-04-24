import { buildApp } from "./server.js";
import { loadSettings } from "./config.js";

const settings = loadSettings();
const app = buildApp(settings);

app.listen(settings.port, settings.host, () => {
  console.log(`dot-mcp listening on http://${settings.host}:${settings.port}`);
});

