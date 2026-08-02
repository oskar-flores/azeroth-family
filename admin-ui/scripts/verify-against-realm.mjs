// Confirms the Node SRP6 implementation reproduces a verifier that a real
// AzerothCore realm generated. Not part of `npm test` — it needs a live realm.
//
//   node scripts/verify-against-realm.mjs <username> <password> <saltHex> <verifierHex>
//
// Get the two hex values with:
//   docker exec -i ac-database sh -c \
//     'mysql -u root -p"$MYSQL_ROOT_PASSWORD" acore_auth -N -B \
//        -e "SELECT HEX(salt), HEX(verifier) FROM account WHERE username = UPPER(\"<username>\");"'
import { calculateVerifier } from '../src/srp6.js';

const [username, password, saltHex, verifierHex] = process.argv.slice(2);
if (!username || !password || !saltHex || !verifierHex) {
  console.error('usage: node scripts/verify-against-realm.mjs <username> <password> <saltHex> <verifierHex>');
  process.exit(2);
}

const salt = Buffer.from(saltHex.trim(), 'hex');
const expected = Buffer.from(verifierHex.trim(), 'hex');
const actual = calculateVerifier(username, password, salt);

console.log('expected (from realm):', expected.toString('hex').toUpperCase());
console.log('actual   (from node): ', actual.toString('hex').toUpperCase());

if (actual.equals(expected)) {
  console.log('\nMATCH — byte order is correct, continue with Task 2.');
  process.exit(0);
}

const reversed = Buffer.from(actual).reverse();
console.error('\nMISMATCH.');
console.error(reversed.equals(expected)
  ? 'The reversed buffer matches: flip bigIntToBytesLE/bytesToBigIntLE to big-endian in src/srp6.js.'
  : 'Neither order matches. Re-read SRP6.cpp:38-47 before writing any more code.');
process.exit(1);
