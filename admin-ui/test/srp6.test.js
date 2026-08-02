import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVerifier, checkLogin } from '../src/srp6.js';

// Regression vector computed from the algorithm as written in
// src/common/Cryptography/Authentication/SRP6.cpp. It locks the byte order in.
// The proof that it matches a real realm is the live check in Step 6.
const SALT = Buffer.from('000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F', 'hex');
const VERIFIER = Buffer.from('388AA0FA07B5252DB2F75C032B20FD11D63E417277A0E566CF79ACF642CEB771', 'hex');

test('calculateVerifier reproduces the known vector', () => {
  assert.deepEqual(calculateVerifier('TESTUSER', 'TESTPASS', SALT), VERIFIER);
});

test('input is uppercased, so lowercase credentials still verify', () => {
  assert.ok(checkLogin('testuser', 'testpass', SALT, VERIFIER));
});

test('a wrong password is rejected', () => {
  assert.ok(!checkLogin('TESTUSER', 'WRONGPW', SALT, VERIFIER));
});

test('a wrong username is rejected', () => {
  assert.ok(!checkLogin('OTHERUSER', 'TESTPASS', SALT, VERIFIER));
});

// BN_bn2lebinpad zero-pads. A verifier whose top byte happens to be zero must
// still be 32 bytes, or comparisons against the DB column silently fail.
test('the verifier is always 32 bytes, zero-padded', () => {
  for (let i = 0; i < 64; i++) {
    const salt = Buffer.alloc(32, i);
    assert.equal(calculateVerifier('U', 'P', salt).length, 32);
  }
});

test('a salt of the wrong length is a programming error, not a false login', () => {
  assert.throws(() => calculateVerifier('U', 'P', Buffer.alloc(16)), TypeError);
  assert.equal(checkLogin('U', 'P', Buffer.alloc(16), VERIFIER), false);
});

test('a verifier of the wrong length never verifies', () => {
  assert.equal(checkLogin('TESTUSER', 'TESTPASS', SALT, Buffer.alloc(31)), false);
});
