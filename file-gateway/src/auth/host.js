import { httpError } from "../lib/errors.js";

export function verifyHostRequest(req, hostApiKey) {
  if (!hostApiKey) {
    return;
  }

  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const apiKey = req.headers["x-gateway-api-key"] || bearerToken;

  if (apiKey !== hostApiKey) {
    throw httpError(401, "Host API key is required");
  }
}
