function needsPageChrome(req) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;

  const accept = String(req.get('accept') || '').toLowerCase();
  return !accept
    || accept.includes('text/html')
    || accept.includes('application/xhtml+xml')
    || accept.includes('*/*');
}

module.exports = { needsPageChrome };
