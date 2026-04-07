import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { serverConfig } from "./config";

const server = createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "server.ready",
      message: "Tempo server scaffold is running.",
    }),
  );

  socket.on("message", (message) => {
    socket.send(
      JSON.stringify({
        type: "echo",
        payload: message.toString(),
      }),
    );
  });
});

server.listen(serverConfig.port, () => {
  console.log(`Tempo server listening on :${serverConfig.port}`);
});
