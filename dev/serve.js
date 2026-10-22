#!/usr/bin/env node
/* ============================================================================
 * Local dev server for the Paws and Tails storefront
 * ============================================================================
 * On pawsandtails24.com the site calls /api/<version>/graphql.json on its own
 * origin and that is the end of it. A laptop is not that origin, so this
 * server stands in: it serves the files and forwards anything under /api/ to
 * the live store, which makes the browser see one origin exactly as it will in
 * production. Nothing about the site changes to run here.
 *
 *   node dev/serve.js                  then open http://localhost:4173
 *   node dev/serve.js --port 5000
 *   node dev/serve.js --token <public storefront token>
 *
 * Every forwarded call is logged with its operation, status and timing, so you
 * can watch the catalogue being streamed rather than take it on trust.
 *
 * Checkout is NOT proxied. The bag is a real Shopify cart and its checkoutUrl
 * points at the store, so pressing Checkout here leaves for the real checkout
 * and a payment there is a real order. Use a draft or a test product.
 * ========================================================================== */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = Number(arg('port', 4173));
const UPSTREAM = arg('store', 'pawsandtails24.com');
const TOKEN = arg('token', process.env.PT_STOREFRONT_TOKEN || '');
const ROOT = path.resolve(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8'
};

function log(line) { process.stdout.write(line + '\n'); }

/* -------------------------------------------------------------- API forward */

function forward(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let op = '';
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      const m = String(parsed.query || '').match(/(?:query|mutation)\s+(\w+)/);
      op = m ? m[1] : '(anonymous)';
    } catch (e) { op = '(unparsed)'; }

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': body.length,
      'User-Agent': 'paws-and-tails-dev/1.0'
    };
    if (TOKEN) headers['X-Shopify-Storefront-Access-Token'] = TOKEN;

    const started = Date.now();
    const up = https.request({
      host: UPSTREAM,
      path: req.url,
      method: 'POST',
      headers: headers
    }, (ur) => {
      const out = [];
      ur.on('data', (c) => out.push(c));
      ur.on('end', () => {
        const buf = Buffer.concat(out);
        const ms = Date.now() - started;
        let note = '';
        try {
          const j = JSON.parse(buf.toString('utf8'));
          if (j.errors && j.errors.length) note = '  GraphQL: ' + String(j.errors[0].message).slice(0, 90);
        } catch (e) { note = '  (not JSON: ' + buf.length + ' bytes)'; }
        log(`  ${String(ur.statusCode).padEnd(3)}  ${String(ms).padStart(5)}ms  ${String(Math.round(buf.length / 102.4) / 10).padStart(6)} KB  ${op}${note}`);
        res.writeHead(ur.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(buf);
      });
    });
    up.on('error', (e) => {
      log(`  ERR         ${op}  ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: 'dev server could not reach ' + UPSTREAM + ': ' + e.message }] }));
    });
    up.end(body);
  });
}

/* ------------------------------------------------------------------ statics */

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

/* Order lookups run api/order.js here, exactly as Vercel runs it. It reads
 * SHOPIFY_SHOP and the app credentials from the environment; without them
 * it answers "not set up yet", which the track page explains. */
const orderApi = require(path.join(ROOT, 'api', 'order.js'));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(String(req.url || '/').split('?')[0]);

  if (url === '/api/order') {
    const started = Date.now();
    res.on('finish', () => log(`  ${String(res.statusCode).padEnd(3)}  ${String(Date.now() - started).padStart(5)}ms            order lookup`));
    orderApi(req, res);
    return;
  }

  if (url.startsWith('/api/')) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: 'the Storefront API takes POST' }] }));
      return;
    }
    forward(req, res);
    return;
  }

  /* Anything that is not a file is the app itself: the routes live in the
   * hash, so one page answers every address. */
  const target = url === '/' ? '/index.html' : url;
  const file = path.join(ROOT, target.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { serveFile(res, path.join(ROOT, 'index.html')); return; }
    serveFile(res, file);
  });
});

server.listen(PORT, () => {
  log('');
  log('  Paws and Tails storefront, local');
  log('  ---------------------------------------------------------------');
  log('  open          http://localhost:' + PORT);
  log('  catalogue     forwarded to https://' + UPSTREAM + '/api/...');
  log('  token         ' + (TOKEN ? 'sent with every call' : 'none (tokenless, same as production)'));
  log('  order lookup  ' + (orderApi.configured() ? 'on, reading orders from ' + process.env.SHOPIFY_SHOP : 'off (set SHOPIFY_SHOP and the app credentials to try it)'));
  log('');
  log('  Each line below is one live call to the store:');
  log('');
});
