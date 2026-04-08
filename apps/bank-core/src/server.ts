import { loadDemoConfig } from "@tokenized-deposit/shared";
import { createBankCoreApp } from "./app.js";

const config = loadDemoConfig();
const app = createBankCoreApp();

app.listen(config.bankCore.port, config.bankCore.host, () => {
  console.log(
    `bank-core listening on http://${config.bankCore.host}:${config.bankCore.port}`,
  );
});
