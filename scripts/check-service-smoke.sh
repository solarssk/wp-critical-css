#!/usr/bin/env bash
# Run the real service, renderer and receiver without routing delivery through
# the runner's host gateway. The receiver shares the service's network namespace;
# only the page fetch needs public network access, with all SSRF guards intact.
set -euo pipefail

IMAGE="${1:-wp-critical-css:ci}"
CONTAINER="wpcc-e2e-$$"

trap '
  if [ "$?" -ne 0 ]; then
    docker logs "$CONTAINER" >&2 || true
    docker inspect --format "{{json .State}}" "$CONTAINER" >&2 || true
    docker exec "$CONTAINER" cat /tmp/wpcc-receiver.log >&2 || true
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
' EXIT

docker run -d --rm --init --platform linux/amd64 --name "$CONTAINER" \
  -e SHARED_SECRET=ci-e2e-test \
  -e WP_RECEIVER_URL=http://127.0.0.1:18081/receiver \
  -e ALLOWED_HOSTNAME=example.com \
  -e SWEEP_ENABLED=false \
  "$IMAGE"

docker exec -i "$CONTAINER" sh -c 'cat > /tmp/wpcc-receiver.mjs' <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ready') {
    res.end('ready');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/receiver' ||
      req.headers['x-wpcc-secret'] !== 'ci-e2e-test') {
    res.writeHead(400).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    fs.writeFileSync('/tmp/wpcc-delivery.json', body);
    res.end('{}');
  });
}).listen(18081, '127.0.0.1');
EOF
docker exec -d "$CONTAINER" sh -c 'node /tmp/wpcc-receiver.mjs > /tmp/wpcc-receiver.log 2>&1'

# Fail before enqueueing work if either endpoint is unavailable; print the
# underlying network error, not just a later "no CSS within 90 s".
docker exec -i "$CONTAINER" node --input-type=module - <<'EOF'
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
for (const url of ['http://127.0.0.1:18081/ready', 'http://127.0.0.1:3939/health']) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      if (url.endsWith('/health')) {
        assert.equal((await response.json()).status, 'ok');
      } else {
        assert.equal(await response.text(), 'ready');
      }
      break;
    } catch (error) {
      if (attempt === 30) throw error;
      await setTimeout(1000);
    }
  }
  console.log('Ready:', url);
}
const response = await fetch('http://127.0.0.1:3939/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-WPCC-Secret': 'ci-e2e-test' },
  body: JSON.stringify({ url: 'https://example.com/' }),
  signal: AbortSignal.timeout(5000),
});
assert.equal(response.status, 202, await response.text());
EOF

for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" test -s /tmp/wpcc-delivery.json; then
    docker exec "$CONTAINER" node --input-type=module -e "
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      const d = JSON.parse(fs.readFileSync('/tmp/wpcc-delivery.json', 'utf8'));
      assert.equal(d.url, 'https://example.com/');
      for (const key of ['css_mobile', 'css_desktop']) {
        assert.equal(typeof d[key], 'string');
        assert.ok(d[key].trim().length > 0, 'empty ' + key);
      }
      console.log('delivered', d.url, d.css_mobile.length + ' B mobile,', d.css_desktop.length + ' B desktop');
    "
    exit 0
  fi
  sleep 1
done
echo "::error::no CSS was delivered to the receiver within 90 s" >&2
exit 1
