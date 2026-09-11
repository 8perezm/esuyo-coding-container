import fs from "node:fs";
import path from "node:path";
import { exec } from "./exec.js";

/**
 * Ensure an SSH key pair exists in keyDir. Returns { private, public }.
 * The private key is created with 0600 perms when possible.
 */
export function ensureKeyPair(keyDir, keyName) {
  fs.mkdirSync(keyDir, { recursive: true });
  const privatePath = path.join(keyDir, keyName);
  const publicPath = `${privatePath}.pub`;

  if (fs.existsSync(privatePath) && fs.existsSync(publicPath)) {
    return { private: privatePath, public: publicPath };
  }

  // Generate with an empty passphrase (file on Windows; -f path must exist dir)
  exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "coding-container", "-f", privatePath]);
  try {
    fs.chmodSync(privatePath, 0o600);
  } catch {
    /* best effort on all platforms */
  }
  return { private: privatePath, public: publicPath };
}

export function readPublicKey(publicPath) {
  return fs.readFileSync(publicPath, "utf8").trim();
}
