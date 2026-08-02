import http from 'node:http';

export class SoapError extends Error {
  constructor(kind, message, { status, detail } = {}) {
    super(message);
    this.name = 'SoapError';
    // 'auth' | 'forbidden' | 'fault' | 'timeout' | 'unreachable' | 'protocol'
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };

const escapeXml = (value) => String(value).replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]);

// &amp; is decoded last so that "&amp;lt;" round-trips to "&lt;" rather than "<".
const unescapeXml = (value) => String(value)
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&apos;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
  .replace(/&amp;/g, '&');

// gSOAP namespaces its response elements but not consistently across versions,
// so match an optional prefix rather than hard-coding ns1:.
function firstTag(xml, tag) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`);
  const match = pattern.exec(xml);
  return match ? unescapeXml(match[1]) : null;
}

const envelope = (command) => `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:AC">
<SOAP-ENV:Body><ns1:executeCommand><command>${escapeXml(command)}</command></ns1:executeCommand></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

function post({ host, port, auth, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'text/xml; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        authorization: auth,
        soapaction: '""',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new SoapError('timeout', `worldserver did not answer within ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      reject(err instanceof SoapError
        ? err
        : new SoapError('unreachable', 'cannot reach the worldserver', { detail: err.code ?? err.message }));
    });
    req.end(body);
  });
}

export function createSoapClient({ host, port, user, pass, timeoutMs = 15000 }) {
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  return {
    async executeCommand(command) {
      if (typeof command !== 'string' || command.trim() === '') {
        throw new SoapError('protocol', 'refusing to send an empty command');
      }

      const { status, body } = await post({
        host, port, auth, body: envelope(command), timeoutMs,
      });

      // ACSoap.cpp:84-101 -- no/invalid credentials. The service account is
      // wrong, missing, or was demoted below gmlevel 3.
      if (status === 401) {
        throw new SoapError('auth', 'the worldserver rejected the SOAP credentials', { status });
      }
      // ACSoap.cpp:103-107 -- valid credentials, gmlevel below SEC_ADMINISTRATOR.
      if (status === 403) {
        throw new SoapError('forbidden', 'the SOAP account is below GM level 3', { status });
      }
      // ACSoap.cpp:140 -- the command ran and failed; faultstring is its output.
      if (status === 500) {
        const faultstring = firstTag(body, 'faultstring');
        throw new SoapError('fault', faultstring ?? 'the command failed', { status, detail: body });
      }
      if (status !== 200) {
        throw new SoapError('protocol', `unexpected HTTP ${status} from the worldserver`, { status });
      }

      const result = firstTag(body, 'result');
      if (result === null) {
        throw new SoapError('protocol', 'the worldserver returned an unrecognised response', { status, detail: body });
      }
      return { ok: true, output: result };
    },
  };
}
