const { performance } = require('perf_hooks');

const baseUrl = new URL(process.env.AUDIT_BASE_URL || 'http://127.0.0.1:3000');
const paths = String(process.env.AUDIT_PATHS || '/,/f/blabla').split(',').map((value) => value.trim()).filter(Boolean);
const p95BudgetMs = Math.max(10, Number(process.env.HTTP_P95_BUDGET_MS) || 250);
const samples = Math.max(10, Number(process.env.HTTP_AUDIT_SAMPLES) || 30);
const failures = [];
const pass = (label) => console.log(`OK  ${label}`);
const fail = (label) => { failures.push(label); console.error(`KO  ${label}`); };

function validateHeaders(response) {
  const csp = response.headers.get('content-security-policy') || '';
  const checks = [
    ['CSP default-src', csp.includes("default-src 'self'")],
    ['CSP object-src', csp.includes("object-src 'none'")],
    ['CSP frame-ancestors', csp.includes("frame-ancestors 'none'")],
    ['protection MIME', response.headers.get('x-content-type-options') === 'nosniff'],
    ['protection clickjacking', response.headers.get('x-frame-options') === 'DENY'],
    ['politique de référent', response.headers.get('referrer-policy') === 'strict-origin-when-cross-origin'],
    ['politique de permissions', Boolean(response.headers.get('permissions-policy'))],
    ['signature Express masquée', !response.headers.has('x-powered-by')],
  ];
  if (baseUrl.protocol === 'https:') {
    checks.push(['HSTS', /max-age=\d+/.test(response.headers.get('strict-transport-security') || '')]);
  }
  for (const [label, valid] of checks) valid ? pass(label) : fail(label);
}

(async () => {
  let headersValidated = false;
  for (const pathname of paths) {
    const timings = [];
    for (let index = 0; index < samples + 5; index += 1) {
      const startedAt = performance.now();
      const response = await fetch(new URL(pathname, baseUrl), {
        headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'gzip, br' },
        redirect: 'manual',
      });
      const body = await response.arrayBuffer();
      if (response.status >= 400 || !body.byteLength) {
        fail(`${pathname} répond ${response.status} avec ${body.byteLength} octet(s)`);
        break;
      }
      if (!headersValidated) {
        validateHeaders(response);
        headersValidated = true;
      }
      if (index >= 5) timings.push(performance.now() - startedAt);
    }
    if (!timings.length) continue;
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.50)];
    const p95 = timings[Math.floor(timings.length * 0.95)];
    console.log(`${pathname} : p50=${p50.toFixed(2)} ms, p95=${p95.toFixed(2)} ms`);
    if (p95 <= p95BudgetMs) pass(`${pathname} sous le budget p95 de ${p95BudgetMs} ms`);
    else fail(`${pathname} dépasse le budget p95 (${p95.toFixed(2)} ms)`);
  }
})().catch((error) => fail(`audit HTTP impossible : ${error.message}`)).finally(() => {
  if (failures.length) {
    console.error(`${failures.length} contrôle(s) HTTP en échec.`);
    process.exitCode = 1;
  } else console.log('Tous les contrôles HTTP sont validés.');
});
