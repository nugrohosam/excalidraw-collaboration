import { createServer } from "node:http";
import { createTokenService } from "./auth/tokens.js";
import { readConfig } from "./config.js";
import { createHttpHandler } from "./http/routes.js";
import { attachRealtimeServer } from "./realtime/socket.js";
import { createStorage } from "./storage/index.js";

const config = readConfig();
const tokenService = createTokenService(config.tokenSecret);
const storage = createStorage(config);
const server = createServer(createHttpHandler({ config, storage, tokenService }));

attachRealtimeServer(server, {
  allowedOrigins: config.allowedOrigins,
  maxBodyBytes: config.maxBodyBytes,
  tokenService
});

await storage.init();

server.listen(config.port, () => {
  console.log(`file-gateway listening on :${config.port}`);
});
