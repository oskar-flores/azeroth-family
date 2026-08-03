import test from 'node:test';
import assert from 'node:assert/strict';
import { soapNotice } from '../src/routes/shared.js';
import { SoapError } from '../src/soap.js';

test('soapNotice maps each SOAP error kind to actionable text', () => {
  assert.match(soapNotice(new SoapError('fault', 'Account already exists.')).text, /Account already exists\./);
  assert.match(soapNotice(new SoapError('auth', 'x', { status: 401 })).text, /SOAP_USER/);
  assert.match(soapNotice(new SoapError('forbidden', 'x', { status: 403 })).text, /GM level 3/);
  assert.match(soapNotice(new SoapError('timeout', 'x')).text, /did not answer/i);
  assert.match(soapNotice(new SoapError('unreachable', 'x')).text, /Cannot reach/i);
  assert.match(soapNotice(new SoapError('protocol', 'x')).text, /Unexpected response/i);
  for (const kind of ['fault', 'auth', 'forbidden', 'timeout', 'unreachable', 'protocol']) {
    assert.equal(soapNotice(new SoapError(kind, 'x')).kind, 'error');
  }
});
