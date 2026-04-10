import { clientConfig } from "./runtime/config";

(async () => {
  const root = document.getElementById("app");

  if (!root) {
    throw new Error("App root not found.");
  }

  const { GameShell } = await import("./game-shell");
  const shell = new GameShell(root, clientConfig);
  await shell.start();
})();
