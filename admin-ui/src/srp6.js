import { createHash, timingSafeEqual } from 'node:crypto';

// SRP6.cpp:25-28. N is written there as a reversed hex string handed to a
// little-endian BigNumber, which reads back as this big-endian value.
const N = BigInt('0x894B645E89E1535BBDAD5B8B290650530801B18EBFBF5E8FAB3C82872A3E9BB7');
const G = 7n;

export const SALT_LENGTH = 32;
export const VERIFIER_LENGTH = 32;

// BigNumber defaults to littleEndian=true on both the way in (BigNumber.h:38 ->
// BN_lebin2bn) and the way out (BigNumber.h:123 -> BN_bn2lebinpad), so every
// conversion between a number and the DB's BINARY(32) columns is
// least-significant-byte-first.
function bytesToBigIntLE(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n << 8n) | BigInt(bytes[i]);
  }
  return n;
}

function bigIntToBytesLE(value, length) {
  const out = Buffer.alloc(length);
  let n = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

// Callers of the C++ side must pass both fields through Utf8ToUpperOnlyLatin
// first (SRP6.h:43,46). Account names are [A-Za-z0-9] and passwords are ASCII
// (both enforced at creation), so plain toUpperCase() is equivalent here.
export function calculateVerifier(username, password, salt) {
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_LENGTH) {
    throw new TypeError(`salt must be a ${SALT_LENGTH}-byte Buffer`);
  }
  const inner = createHash('sha1')
    .update(`${username.toUpperCase()}:${password.toUpperCase()}`, 'utf8')
    .digest();
  const x = bytesToBigIntLE(createHash('sha1').update(salt).update(inner).digest());
  return bigIntToBytesLE(modPow(G, x, N), VERIFIER_LENGTH);
}

export function checkLogin(username, password, salt, verifier) {
  if (!Buffer.isBuffer(verifier) || verifier.length !== VERIFIER_LENGTH) return false;
  let computed;
  try {
    computed = calculateVerifier(username, password, salt);
  } catch {
    return false;
  }
  return timingSafeEqual(computed, verifier);
}
