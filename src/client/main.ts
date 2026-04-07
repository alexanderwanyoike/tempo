import { App } from "./runtime/app";
import { clientConfig } from "./runtime/config";

const root = document.getElementById("app");

if (!root) {
  throw new Error("App root not found.");
}

const app = new App(root, clientConfig);
app.start();
