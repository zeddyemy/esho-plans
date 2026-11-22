const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode64(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
}

export function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hash(value: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function hmacKey(secret: string) {
  if (!secret) throw new Error("Missing Worker secret");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function mac(secret: string, value: string) {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(value))));
}

export async function verifyMac(secret: string, value: string, signature: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), decode64(signature), encoder.encode(value));
}

export async function seal(secret: string, value: object) {
  const payload = base64url(encoder.encode(JSON.stringify(value)));
  return payload + "." + await mac(secret, payload);
}

export async function unseal<T>(secret: string, signed: string | undefined): Promise<T | null> {
  if (!signed || signed.length > 1800) return null;
  const [payload, signature, extra] = signed.split(".");
  if (!payload || !signature || extra !== undefined || !await verifyMac(secret, payload, signature)) return null;
  try {
    return JSON.parse(decoder.decode(decode64(payload))) as T;
  } catch {
    return null;
  }
}

async function encryptionKey(secret: string) {
  if (!secret) throw new Error("Missing Worker secret");
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(secret)), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(secret: string, token: string, linkId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(linkId) },
    await encryptionKey(secret), encoder.encode(token),
  );
  return base64url(iv) + "." + base64url(new Uint8Array(ciphertext));
}

export async function decryptToken(secret: string, encrypted: string, linkId: string) {
  const [iv, ciphertext] = encrypted.split(".");
  return decoder.decode(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode64(iv), additionalData: encoder.encode(linkId) },
    await encryptionKey(secret), decode64(ciphertext),
  ));
}
