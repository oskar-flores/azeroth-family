import { parseCookies, SESSION_COOKIE } from '../auth.js';

// Roles are re-read from the database here, on every request, so a session
// minted before a demotion stops working immediately. Returns the user object
// or null (after sending a 403). Section route files import this.
export async function requireAdmin(request, reply, auth) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  const user = await auth.requireRole(token, 3);
  if (!user) {
    reply.code(403).type('text/html; charset=utf-8')
      .send('<p>This page needs GM level 3. <a href="/">Back</a></p>');
    return null;
  }
  return user;
}

// Maps the SOAP error taxonomy onto messages an operator can act on. A Fault is
// the command's own output and belongs in front of the user unchanged.
export function soapNotice(err) {
  switch (err.kind) {
    case 'fault':       return { kind: 'error', text: err.message };
    case 'auth':        return { kind: 'error', text: 'The worldserver rejected the SOAP service account. Check SOAP_USER / SOAP_PASS in Dokploy.' };
    case 'forbidden':   return { kind: 'error', text: 'The SOAP service account is below GM level 3. Re-run: ./scripts/admin.sh gm $SOAP_USER 3' };
    case 'timeout':     return { kind: 'error', text: 'The worldserver did not answer in time. It may be starting up or overloaded.' };
    case 'unreachable': return { kind: 'error', text: 'Cannot reach the worldserver on SOAP. Is ac-worldserver running?' };
    default:            return { kind: 'error', text: `Unexpected response from the worldserver: ${err.message}` };
  }
}
