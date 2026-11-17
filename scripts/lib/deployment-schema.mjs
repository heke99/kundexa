import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// The removed remote DocuSeal service was never installed in the native profile.
// This is an explicit exclusion, not a pattern that can hide future migrations.
export const NATIVE_EXCLUDED = new Set(['202610150004_docuseal_orchestration.sql']);
export async function requiredMigrationVersions(directory) {
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql') && !NATIVE_EXCLUDED.has(name)).sort();
  const versions = files.map(name => name.match(/^(\d+)_/)?.[1]);
  if (!versions.length || versions.some(v => !v) || new Set(versions).size !== versions.length) throw Error('invalid_repository_migration_inventory');
  return versions;
}
export async function verifiedHistoricalMigrations(directory) {
  const proofs=JSON.parse(await readFile(new URL('./historical-migrations.json',import.meta.url),'utf8'));
  for(const proof of proofs) {
    if(!/^\d+$/.test(proof.deployed_version)||!/^[a-f0-9]{64}$/.test(proof.statements_sha256)||!Array.isArray(proof.files)||!proof.files.length)throw Error('invalid_historical_migration_proof');
    proof.covered_versions=[];
    for(const file of proof.files) {
      if(!/^\d+_[a-z0-9_]+\.sql$/.test(file.name))throw Error('invalid_historical_migration_file');
      const bytes=await readFile(new URL(file.name,directory));
      if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('historical_migration_source_changed');
      proof.covered_versions.push(file.name.match(/^(\d+)_/)[1]);
    }
  }
  return proofs;
}
export function deploymentInventoryQuery(proofs=[]) {
  if(!proofs.length)return 'select version from supabase_migrations.schema_migrations order by version';
  if(proofs.some(p=>!/^\d+$/.test(p.deployed_version)))throw Error('invalid_historical_migration_proof');
  const versions=proofs.map(p=>`'${p.deployed_version}'`).join(',');
  return `select version,case when version in (${versions}) then encode(sha256(convert_to(array_to_string(statements,chr(10)),'UTF8')),'hex') else null end as statements_sha256 from supabase_migrations.schema_migrations order by version`;
}
export function missingMigrationVersions(required, inventory, proofs=[]) {
  if (!Array.isArray(inventory) || inventory.some(row => !row || typeof row.version !== 'string' || !/^\d+$/.test(row.version))) throw Error('invalid_database_migration_inventory');
  const applied = new Set(inventory.map(row => row.version));
  for(const proof of proofs) {
    const row=inventory.find(r=>r.version===proof.deployed_version);
    if(row && proof.covered_versions.some(v=>required.includes(v)&&!applied.has(v))) {
      if(row.statements_sha256!==proof.statements_sha256)throw Error(`database_historical_migration_proof_mismatch:${proof.deployed_version}`);
      proof.covered_versions.forEach(v=>applied.add(v));
    }
  }
  return required.filter(version => !applied.has(version));
}
export async function verifyDeploymentSchema({ projectRef, accessToken, requiredVersions, historicalProofs = [], request = fetch }) {
  if (!/^[a-z0-9]{20}$/.test(projectRef ?? '')) throw Error('explicit_supabase_project_ref_required');
  if (!accessToken?.trim()) throw Error('supabase_management_access_token_required');
  const response = await request(`https://api.supabase.com/v1/projects/${projectRef}/database/query/read-only`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    // Catalog only. Never retrieve tenant IDs, customer data or commercial terms.
    body: JSON.stringify({ query: deploymentInventoryQuery(historicalProofs) }),
  });
  if (!response.ok) throw Error(`database_preflight_http_${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw Error('database_preflight_empty_response');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128 * 1024) throw Error('database_preflight_response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  let inventory;
  try { inventory = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw Error('invalid_database_migration_inventory'); }
  const missing = missingMigrationVersions(requiredVersions, inventory, historicalProofs);
  if (missing.length) throw Error(`database_migrations_required_before_edge_deploy:${missing.join(',')}`);
  return { required: requiredVersions.length, applied: inventory.length };
}
