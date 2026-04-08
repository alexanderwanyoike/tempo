import { App } from "./runtime/app";
import { clientConfig } from "./runtime/config";

(async () => {
  const root = document.getElementById("app");

  if (!root) {
    throw new Error("App root not found.");
  }

  const app = await App.create(root, clientConfig);
  app.start();
})();
