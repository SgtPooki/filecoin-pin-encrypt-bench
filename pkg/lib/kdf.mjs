// Same KDF as PR #771 src/common/encryption.ts: PBKDF2-SHA256, 600k iterations, 16-byte salt.
import * as fee from 'filecoin-encryption-envelope'

export const PBKDF2_ITERATIONS = 600_000
export const PASSWORD = process.env.BENCH_PASSWORD ?? 'bench-password'

export async function deriveKey(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, baseKey, fee.constants.KEY_SIZE * 8)
  return new Uint8Array(bits)
}

export async function newKey(password = PASSWORD) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await deriveKey(password, salt, PBKDF2_ITERATIONS)
  return { cek, appMetadata: { kdf: 'pbkdf2-sha256', iterations: PBKDF2_ITERATIONS, salt: Buffer.from(salt).toString('base64') } }
}

export async function keyFromInfo(info, password = PASSWORD) {
  const { kdf, iterations, salt } = info.appMetadata ?? {}
  if (kdf !== 'pbkdf2-sha256' || typeof salt !== 'string' || typeof iterations !== 'number' || iterations > 10_000_000) throw new Error('missing or unsupported key derivation parameters')
  return deriveKey(password, Buffer.from(salt, 'base64'), iterations)
}
