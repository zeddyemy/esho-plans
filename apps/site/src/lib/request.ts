import type { Context } from "hono";
import { maxHtmlBytes, type AppEnv } from "./env";

export class RequestError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503, message: string) {
    super(message);
  }
}

export function sameOrigin(context: Context<AppEnv>) {
  const expected = context.get("appOrigin");
  const origin = context.req.header("Origin");
  if (origin && origin !== "null") return origin === expected;
  const referer = context.req.header("Referer");
  if (referer) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }
  // A no-referrer form navigation can send Origin: null. The browser still identifies its request site.
  return context.req.header("Sec-Fetch-Site") === "same-origin";
}

export async function jsonObject(context: Context<AppEnv>, limit = 8192) {
  if (context.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(400, "Send an application/json request.");
  }
  const body = context.req.raw.body?.getReader();
  if (!body) throw new RequestError(400, "Request body is required.");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await body.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await body.cancel().catch(() => {});
        throw new RequestError(413, "Request is too large. HTML is limited to " + maxHtmlBytes + " bytes.");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    const parsed: unknown = JSON.parse(parts.join(""));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    if (error instanceof RequestError) throw error;
  } finally {
    body.releaseLock();
  }
  throw new RequestError(400, "Send a valid JSON object.");
}

export function inputText(input: unknown, label: string, limit: number) {
  if (typeof input !== "string" || !input.trim() || input.length > limit || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new RequestError(400, label + " must be 1–" + limit + " characters without control characters.");
  }
  return input.trim();
}

export function optionalText(input: unknown, label: string, limit: number) {
  return input === undefined || input === null || input === "" ? null : inputText(input, label, limit);
}

export function requiredFormText(body: Record<string, unknown>, field: string) {
  const value = body[field];
  return typeof value === "string" ? value : "";
}
