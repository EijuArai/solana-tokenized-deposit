import { loadDemoConfig } from "@tokenized-deposit/shared";
import { createOrchestratorApp } from "./app.js";

const config = loadDemoConfig();
const app = createOrchestratorApp();

app.listen(config.orchestrator.port, config.orchestrator.host, () => {
  console.log(
    `orchestrator listening on http://${config.orchestrator.host}:${config.orchestrator.port}`,
  );
});
