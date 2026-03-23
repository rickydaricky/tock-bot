#!/bin/bash
# Test a dry-run booking and save the screenshot
curl -s -X POST localhost:3000/book \
  -H 'Content-Type: application/json' \
  -d '{"restaurant":"lazybearsf","dates":["2026-04-29"],"partySize":2,"time":"17:00","dryRun":true}' \
  > /tmp/tock-response.json

node -e '
const r = JSON.parse(require("fs").readFileSync("/tmp/tock-response.json","utf-8"));
console.log(JSON.stringify({success:r.success, date:r.bookedDate, time:r.bookedTime, error:r.error}, null, 2));
if (r.screenshots && r.screenshots.length > 0) {
  r.screenshots.forEach((s, i) => {
    const f = "/tmp/tock-screenshot-" + i + ".png";
    require("fs").writeFileSync(f, Buffer.from(s, "base64"));
    console.log("Saved: " + f);
  });
}
'
