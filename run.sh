#!/usr/bin/env bash
# Run the storefront against the live store, after the tests.
#   bash run.sh            tests, then the dev server on 4173
#   bash run.sh --mock     tests, then the mock store on 4199 (no live store)
#   bash run.sh --test     tests only
set -euo pipefail
cd "$(dirname "$0")"

echo
echo "==> storefront client"
node test/test-storefront.js

echo "==> order lookup"
node test/test-order-api.js

echo "==> checkout"
node test/test-checkout-api.js

echo "==> language"
node test/test-nlu.js

echo "==> assistant"
node test/test-assistant.js

echo "==> browser"
if node -e "require('playwright')" >/dev/null 2>&1; then
  node test/test-ui.js
else
  echo "  skipped: playwright is not installed (npm i -D playwright to run it)"
  echo
fi

case "${1:-}" in
  --test) exit 0 ;;
  --mock) exec node test/mock-store.js ;;
  *)      exec node dev/serve.js ;;
esac
