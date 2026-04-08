import { loadDemoConfig } from "@tokenized-deposit/shared";
import { createRestApiApp } from "./app.js";

const config = loadDemoConfig();
const app = createRestApiApp();

app.listen(config.restApi.port, config.restApi.host, () => {
  console.log(
    `rest-api listening on http://${config.restApi.host}:${config.restApi.port}`,
  );
});
