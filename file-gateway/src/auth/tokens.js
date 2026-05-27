import { createHmac, timingSafeEqual } from "node:crypto";
import { httpError } from "../lib/errors.js";

export function createTokenService(tokenSecret) {
  return {
    signToken(payload) {
      const encodedPayload = base64url(JSON.stringify(payload));
      const signature = hmac(encodedPayload, tokenSecret);
      return `${encodedPayload}.${signature}`;
    },

    verifyRequestToken(req, requestUrl, fileId) {
      const authHeader = req.headers.authorization || "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
      const token = bearerToken || requestUrl.searchParams.get("access_token");

      if (!token) {
        throw httpError(401, "Access token is required");
      }

      const claims = verifyToken(token, tokenSecret);
      if (claims.fileId !== fileId) {
        throw httpError(403, "Token file does not match request file");
      }
      return claims;
    },

    verifyToken(token) {
      return verifyToken(token, tokenSecret);
    }
  };
}

function verifyToken(token, tokenSecret) {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw httpError(401, "Invalid token");
  }

  const [encodedPayload, signature] = parts;
  const expected = hmac(encodedPayload, tokenSecret);
  if (!safeEqual(signature, expected)) {
    throw httpError(401, "Invalid token signature");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw httpError(401, "Invalid token payload");
  }

  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw httpError(401, "Token expired");
  }

  if (!payload.fileId || !payload.userId || !payload.userName || !payload.permission) {
    throw httpError(401, "Token missing required claims");
  }

  return payload;
}

function hmac(value, tokenSecret) {
  return createHmac("sha256", tokenSecret).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return timingSafeEqual(aBuffer, bBuffer);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}
