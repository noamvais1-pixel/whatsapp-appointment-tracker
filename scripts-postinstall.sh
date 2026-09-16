#!/bin/sh
# Re-applies the whatsapp-web.js fix (upstream PR #201850) after every npm install.
cd "$(dirname "$0")/node_modules/whatsapp-web.js" || exit 0
patch -p1 -N -s < ../../patches/whatsapp-web.js-pr201850.patch >/dev/null 2>&1 || true
