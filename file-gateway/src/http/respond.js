import { httpError } from "../lib/errors.js";

export function sendJson(res, statusCode, body) {
  return send(res, statusCode, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

export function send(res, statusCode, body, contentType) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

export async function readJsonBody(req, maxBodyBytes) {
  const text = await readTextBody(req, maxBodyBytes);
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

export async function readTextBody(req, maxBodyBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw httpError(413, "Request body too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function handleCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin, allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigins.includes("*") ? "*" : origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Version, X-Gateway-Api-Key, X-Lock");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }

  return false;
}

function isOriginAllowed(origin, allowedOrigins) {
  return allowedOrigins.includes("*") || allowedOrigins.includes(origin);
}
