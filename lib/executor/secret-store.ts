// Encryption for API keys the user configures in Configurações → Conexões de IA (see ApiConnectionRecord).
// The machine key itself lives only in .dev.vars (gitignored, mode 0600, generated the same way as the
// executor's own bearer token — see executor/main.ts) and never leaves this computer. This module owns only
// the cipher; it never reads or writes files, so it is testable without touching disk.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SecretBox = { iv: string; tag: string; data: string };

/** A fresh 32-byte key for AES-256-GCM, base64-encoded for storage in .dev.vars. */
export function randomMachineKeyB64(): string {
  return randomBytes(32).toString("base64");
}

export function parseMachineKeyB64(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("AYLA_SECRET_KEY inválida: precisa ser uma chave de 32 bytes em base64.");
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string): SecretBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function decryptSecret(key: Buffer, box: SecretBox): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  const data = Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
  return data.toString("utf8");
}

export const serializeBox = (box: SecretBox): string => JSON.stringify(box);
export const parseBox = (text: string): SecretBox => JSON.parse(text) as SecretBox;

export const last4 = (key: string) => key.slice(-4);
