import { loadDemoConfig } from "@tokenized-deposit/shared";
import { createCoreGatewayApp } from "./app.js";

const config = loadDemoConfig();
const app = createCoreGatewayApp();

app.listen(config.coreGateway.port, config.coreGateway.host, () => {
  console.log(
    `core-gateway listening on http://${config.coreGateway.host}:${config.coreGateway.port}`,
  );
});
