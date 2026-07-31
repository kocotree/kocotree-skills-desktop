import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "../config";

export function createRandomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function hashSecret(value: string): string {
  return createHash("sha256")
    .update(`${config.tokenSecret}:${value}`)
    .digest("hex");
}

export function signValue(value: string): string {
  return createHmac("sha256", config.tokenSecret)
    .update(value)
    .digest("base64url");
}

export function verifySignature(value: string, signature: string): boolean {
  const expected = Buffer.from(signValue(value));
  const actual = Buffer.from(signature);
  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
