/**
 * RSA key pair management for ActivityPub actors.
 *
 * Each team actor gets a unique RSA-2048 key pair for HTTP Signatures.
 * Keys are generated lazily on first access and stored as PEM files.
 */

import { dirname } from "@std/path";
import { getSparqStore } from "./registry.ts";

export interface KeyPair {
  privateKey: CryptoKey;
  publicKeyPem: string;
  keyId: string;
}

const ALGO: RsaHashedKeyGenParams = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

function keysDir(teamSlug: string): string {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  return `${home}/.porter/activitypub/${teamSlug}`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

function wrapPem(type: string, b64: string): string {
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`;
}

function unwrapPem(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s/g, "");
}

async function exportPublicPem(key: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", key);
  return wrapPem("PUBLIC KEY", arrayBufferToBase64(spki));
}

async function exportPrivatePem(key: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key);
  return wrapPem("PRIVATE KEY", arrayBufferToBase64(pkcs8));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const b64 = unwrapPem(pem);
  const buf = base64ToArrayBuffer(b64);
  return crypto.subtle.importKey("pkcs8", buf, ALGO, false, ["sign"]);
}

/** Import an RSA public key from a PEM string. */
export async function importPublicKey(pem: string): Promise<CryptoKey> {
  const b64 = unwrapPem(pem);
  const buf = base64ToArrayBuffer(b64);
  return crypto.subtle.importKey("spki", buf, ALGO, true, ["verify"]);
}

async function generateAndStore(teamSlug: string, keyId: string): Promise<KeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    ALGO,
    true,
    ["sign", "verify"],
  );

  const publicPem = await exportPublicPem(keyPair.publicKey);
  const privatePem = await exportPrivatePem(keyPair.privateKey);

  const dir = keysDir(teamSlug);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/public.pem`, publicPem);
  await Deno.writeTextFile(`${dir}/private.pem`, privatePem);

  const privateKey = await importPrivateKey(privatePem);

  return { privateKey, publicKeyPem: publicPem, keyId };
}

const cache = new Map<string, KeyPair>();

/**
 * Get or create an RSA key pair for a team actor.
 *
 * Keys are cached in memory and persisted to disk. On first call,
 * checks for existing PEM files; if none exist, generates a new pair.
 */
export async function getOrCreateKeyPair(
  teamSlug: string,
  baseUrl: string,
): Promise<KeyPair> {
  const keyId = `${baseUrl}/ap/actors/${teamSlug}#main-key`;

  const cached = cache.get(teamSlug);
  if (cached) return cached;

  const sparq = getSparqStore();
  if (sparq) {
    const pems = sparq.getKeyPems(teamSlug);
    if (pems) {
      const privateKey = await importPrivateKey(pems.privatePem);
      const pair: KeyPair = { privateKey, publicKeyPem: pems.publicPem, keyId };
      cache.set(teamSlug, pair);
      return pair;
    }
    const keyPair = await crypto.subtle.generateKey(ALGO, true, ["sign", "verify"]);
    const publicPem = await exportPublicPem(keyPair.publicKey);
    const privatePem = await exportPrivatePem(keyPair.privateKey);
    await sparq.storeKeyPems(teamSlug, publicPem, privatePem);
    const privateKey = await importPrivateKey(privatePem);
    const pair: KeyPair = { privateKey, publicKeyPem: publicPem, keyId };
    cache.set(teamSlug, pair);
    return pair;
  }

  const dir = keysDir(teamSlug);
  try {
    const privatePem = await Deno.readTextFile(`${dir}/private.pem`);
    const publicPem = await Deno.readTextFile(`${dir}/public.pem`);
    const privateKey = await importPrivateKey(privatePem);
    const pair: KeyPair = { privateKey, publicKeyPem: publicPem, keyId };
    cache.set(teamSlug, pair);
    return pair;
  } catch {
    const pair = await generateAndStore(teamSlug, keyId);
    cache.set(teamSlug, pair);
    return pair;
  }
}

/** Clear the in-memory key cache. Used in tests. */
export function resetKeyCache(): void {
  cache.clear();
}
