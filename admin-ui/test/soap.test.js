import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSoapClient, SoapError } from '../src/soap.js';

// Stands in for ac-worldserver's gSOAP endpoint. `handler` gets (req, res, body).
async function withServer(handler, run) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(createSoapClient({ host: '127.0.0.1', port, user: 'svc', pass: 'pw', timeoutMs: 1000 }), port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const okResponse = (result) => `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:AC">
<SOAP-ENV:Body><ns1:executeCommandResponse><result>${result}</result></ns1:executeCommandResponse></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

const faultResponse = (faultstring) => `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
<SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>SOAP-ENV:Client</faultcode><faultstring>${faultstring}</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

test('a successful command returns its output', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(okResponse('Connected players: 2. Characters in world: 2.'));
  }, async (soap) => {
    const result = await soap.executeCommand('server info');
    assert.equal(result.ok, true);
    assert.equal(result.output, 'Connected players: 2. Characters in world: 2.');
  });
});

test('the command is sent HTTP Basic authenticated in a urn:AC envelope', async () => {
  await withServer((req, res, body) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('svc:pw').toString('base64')}`);
    assert.match(body, /xmlns:ns1="urn:AC"/);
    assert.match(body, /<command>server info<\/command>/);
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(okResponse('ok'));
  }, async (soap) => { await soap.executeCommand('server info'); });
});

// A password could contain & or <. Sending it unescaped produces malformed XML,
// which gSOAP rejects with a fault that looks like an application error.
test('XML metacharacters in the command are escaped and decoded back', async () => {
  await withServer((req, res, body) => {
    assert.match(body, /<command>account create bob a&amp;b&lt;c<\/command>/);
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(okResponse('made &amp; done &lt;ok&gt;'));
  }, async (soap) => {
    const result = await soap.executeCommand('account create bob a&b<c');
    assert.equal(result.output, 'made & done <ok>');
  });
});

// ACSoap.cpp:84-101 -- wrong or missing credentials. Operator error: the service
// account is wrong, missing, or was demoted.
test('HTTP 401 becomes a distinct auth error', async () => {
  await withServer((req, res) => { res.writeHead(401); res.end(); }, async (soap) => {
    await assert.rejects(() => soap.executeCommand('server info'), (err) => {
      assert.ok(err instanceof SoapError);
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 401);
      return true;
    });
  });
});

// ACSoap.cpp:103-107 -- credentials are valid but gmlevel < 3. A different fix
// from a 401, so a different kind.
test('HTTP 403 becomes a distinct forbidden error', async () => {
  await withServer((req, res) => { res.writeHead(403); res.end(); }, async (soap) => {
    await assert.rejects(() => soap.executeCommand('server info'),
      (err) => err.kind === 'forbidden' && err.status === 403);
  });
});

// ACSoap.cpp:140 -- the command ran and failed. faultstring holds the command's
// own output, which is what the user needs to read.
test('a SOAP Fault surfaces the faultstring as a user-level message', async () => {
  await withServer((req, res) => {
    res.writeHead(500, { 'content-type': 'text/xml' });
    res.end(faultResponse('Account already exists.'));
  }, async (soap) => {
    await assert.rejects(() => soap.executeCommand('account create papa x'), (err) => {
      assert.equal(err.kind, 'fault');
      assert.equal(err.message, 'Account already exists.');
      return true;
    });
  });
});

test('a fault with no parseable faultstring still yields a fault error', async () => {
  await withServer((req, res) => { res.writeHead(500); res.end('garbage'); }, async (soap) => {
    await assert.rejects(() => soap.executeCommand('x'), (err) => err.kind === 'fault');
  });
});

test('a hung worldserver becomes a timeout error, not a hung request', async () => {
  await withServer((req, res) => { /* never responds */ }, async (soap) => {
    await assert.rejects(() => soap.executeCommand('server info'), (err) => err.kind === 'timeout');
  });
});

test('a refused connection becomes an unreachable error', async () => {
  const soap = createSoapClient({ host: '127.0.0.1', port: 1, user: 'u', pass: 'p', timeoutMs: 1000 });
  await assert.rejects(() => soap.executeCommand('server info'), (err) => err.kind === 'unreachable');
});

test('a 200 that is not a recognisable envelope is a protocol error', async () => {
  await withServer((req, res) => { res.writeHead(200); res.end('<html>hello</html>'); }, async (soap) => {
    await assert.rejects(() => soap.executeCommand('server info'), (err) => err.kind === 'protocol');
  });
});

test('an empty command is refused before a request is made', async () => {
  const soap = createSoapClient({ host: '127.0.0.1', port: 1, user: 'u', pass: 'p' });
  await assert.rejects(() => soap.executeCommand('  '), (err) => err.kind === 'protocol');
});
