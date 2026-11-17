import { requiredMigrationVersions, verifiedHistoricalMigrations, verifyDeploymentSchema } from './lib/deployment-schema.mjs';
const args = process.argv.slice(2);
const refs = args.flatMap((value, index) => value === '--project-ref' ? [args[index + 1]] : value.startsWith('--project-ref=') ? [value.slice(14)] : []);
try {
  if (refs.length !== 1) throw Error('exactly_one_explicit_project_ref_required');
  const requiredVersions = await requiredMigrationVersions(new URL('../supabase/migrations/', import.meta.url));
  const historicalProofs = await verifiedHistoricalMigrations(new URL('../supabase/migrations/', import.meta.url));
  const result = await verifyDeploymentSchema({ historicalProofs, projectRef: refs[0], accessToken: process.env.SUPABASE_ACCESS_TOKEN, requiredVersions });
  console.log(`Database preflight PASS: ${result.required} native-profile migrations present. No database changes performed.`);
} catch (error) {
  // Do not log provider response bodies, tokens or request headers.
  const code = error instanceof Error && /^(exactly_one_|explicit_supabase_|supabase_management_|invalid_|database_)/.test(error.message) ? error.message : 'database_preflight_unreachable';
  console.error(`Edge deployment stopped: ${code}`);
  process.exitCode = 1;
}
