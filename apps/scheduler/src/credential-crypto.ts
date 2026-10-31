import {createDecipheriv} from "node:crypto";

/** Shared by runtime and offline validation; never formats secret input in errors. */
export function parseCredentialMasterKey(raw: string): Buffer {
  const value = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (!value || key.length !== 32) throw new Error("Invalid credential master key");
  return key;
}

export function decryptCredentialWithKey(key: Buffer, encrypted: {ciphertext: string; nonce: string; auth_tag: string}): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.auth_tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
