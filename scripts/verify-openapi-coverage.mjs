import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const apiRoot = path.join(root, "src/app/api/v1");
const openapiFile = path.join(root, "src/app/api/openapi.json/route.ts");
const classificationFile = path.join(root, "scripts/api-route-classification.json");
const classification = JSON.parse(fs.readFileSync(classificationFile, "utf8"));
const openapi = fs.readFileSync(openapiFile, "utf8");
const errors = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
// Correct the close brace in a separate pass to keep the regexp readable.
function normalize(file) {
  return file.slice(apiRoot.length).replace(/\\/g, "/").replace(/\/route\.ts$/, "")
    .replace(/\[([^\]]+)\]/g, (_, value) => `{${value}}`) || "/";
}
function exportedMethods(source) {
  return [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1].toLowerCase());
}
function openapiBlock(route) {
  const needle = `"${route}": {`;
  const start = openapi.indexOf(needle);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const brace = openapi.indexOf(": {", start) + 2;
  for (let i = brace; i < openapi.length; i++) {
    const ch = openapi[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return openapi.slice(brace + 1, i);
    }
  }
  return null;
}

const files = walk(apiRoot).filter((file) => file.endsWith(`${path.sep}route.ts`));
const seen = new Set();
for (const file of files) {
  const route = normalize(file);
  seen.add(route);
  const config = classification[route];
  if (!config) { errors.push(`unclassified route: ${route}`); continue; }
  if (!['public','internal'].includes(config.classification)) errors.push(`invalid classification for ${route}`);
  if (config.classification === 'internal' && !String(config.reason ?? '').trim()) errors.push(`internal route lacks reason: ${route}`);
  const block = openapiBlock(route);
  if (config.classification === 'internal' && block) errors.push(`internal route must not be published in OpenAPI: ${route}`);
  if (config.classification === 'public') {
    if (!block) { errors.push(`public route missing from OpenAPI: ${route}`); continue; }
    const methods = exportedMethods(fs.readFileSync(file, "utf8"));
    for (const method of methods) {
      if (!new RegExp(`\\b${method}\\s*:`).test(block)) errors.push(`OpenAPI method missing: ${method.toUpperCase()} ${route}`);
    }
  }
}
for (const route of Object.keys(classification)) if (!seen.has(route)) errors.push(`classification references missing route: ${route}`);
if (/\bpurpose:\s*\{\s*type:\s*"string"\s*\}/.test(openapiBlock('/calls') ?? '')) errors.push('OpenAPI /calls must not expose client-controlled legal purpose');
if (errors.length) {
  console.error(`OpenAPI coverage verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`OpenAPI coverage verified: ${files.length} /api/v1 routes classified; every public method is documented.`);
