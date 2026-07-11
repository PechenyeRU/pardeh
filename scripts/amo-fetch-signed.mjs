// Fetch the AMO-signed xpi of an unlisted version and save it locally.
//
// Recovery path for releases where `web-ext sign` gave up waiting for AMO
// approval: the upload survives on AMO, so once a reviewer (or the auto
// approver) signs it, this script can pull the signed file down.
//
//   AMO_API_KEY=... AMO_API_SECRET=... \
//     node scripts/amo-fetch-signed.mjs <version> <outfile>
//
// Exit codes: 0 downloaded, 2 usage, 3 version not on AMO, 4 not signed yet.

import crypto from "node:crypto";
import fs from "node:fs";

const GUID = "pardeh@e2e-encryption.bale.ai";
const [version, outFile] = process.argv.slice(2);
const apiKey = process.env.AMO_API_KEY;
const apiSecret = process.env.AMO_API_SECRET;

if (!version || !outFile || !apiKey || !apiSecret) {
  console.error("usage: AMO_API_KEY=.. AMO_API_SECRET=.. node amo-fetch-signed.mjs <version> <outfile>");
  process.exit(2);
}

// AMO wants a fresh short-lived HS256 JWT on every request.
function jwt() {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ iss: apiKey, jti: crypto.randomUUID(), iat: now, exp: now + 240 });
  const sig = crypto.createHmac("sha256", apiSecret).update(`${head}.${payload}`).digest("base64url");
  return `${head}.${payload}.${sig}`;
}

async function get(url) {
  const res = await fetch(url, { headers: { Authorization: `JWT ${jwt()}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

let page = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(GUID)}/versions/?filter=all_with_unlisted&page_size=50`;
let entry = null;
while (page && !entry) {
  const body = await (await get(page)).json();
  entry = body.results.find((v) => v.version === version) || null;
  page = body.next;
}

if (!entry) {
  console.error(`version ${version} is not on AMO`);
  process.exit(3);
}

const file = entry.file ?? entry.files?.[0];
console.log(`version ${version}: file status "${file.status}"`);
if (file.status !== "public") {
  console.error("not signed yet — still waiting on AMO approval");
  process.exit(4);
}

const download = await get(file.url);
fs.writeFileSync(outFile, Buffer.from(await download.arrayBuffer()));
console.log(`saved ${outFile} (${fs.statSync(outFile).size} bytes)`);
