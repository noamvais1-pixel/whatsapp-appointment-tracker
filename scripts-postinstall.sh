#!/bin/sh
# Re-applies the whatsapp-web.js fixes after every npm install:
#   PR #201850 - chat list crash ("Error: r") on current WhatsApp Web
#   PR #201923 - media sends failing with "Data passed to getter must include an id property"
#   PR #201697 - media downloads failing with a bare "t" on WhatsApp Web 2.3000.1048+ (reads from WA's own cache)
#   PR #201932 - downloadMedia hanging on expired media
cd "$(dirname "$0")/node_modules/whatsapp-web.js" || exit 0
for p in ../../patches/*.patch; do
  patch -p1 -N -s < "$p" >/dev/null 2>&1 || true
done
