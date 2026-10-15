// Browser-safe twin of kdf.mjs (no Buffer).
import * as fee from 'filecoin-encryption-envelope'

export async function deriveKey(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, baseKey, fee.constants.KEY_SIZE * 8)
  return new Uint8Array(bits)
}
export async function keyFromInfo(info, password) {
  const { kdf, iterations, salt } = info.appMetadata ?? {}
  if (kdf !== 'pbkdf2-sha256' || typeof salt !== 'string' || typeof iterations !== 'number' || iterations > 10_000_000) throw new Error('missing or unsupported key derivation parameters')
  return deriveKey(password, Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), iterations)
}
