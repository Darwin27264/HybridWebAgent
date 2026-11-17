/**
 * Unified E2E Test Runner for Ofln-Scout
 * Orchestrates execution across all 4 tiers:
 * - Tier 1: Isolated Happy-Path Functional Tests (Features 1-10)
 * - Tier 2: Boundary & Corner Cases (Boundary 1-10)
 * - Tier 3: Cross-Feature Pairwise Interactions
 * - Tier 4: Realistic Application End-to-End Scenarios
 *
 * Usage:
 *   npx tsx tests/e2e/runner.ts
 *   npx tsx tests/e2e/runner.ts --tier=1
 *   npx tsx tests/e2e/runner.ts --filter=SQLite
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { clearSuites, runAllSuites, SuiteSummary } from './harness';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const args = process.argv.slice(2);
  const tierArg = args.find(a => a.startsWith('--tier='));
  const filterArg = args.find(a => a.startsWith('--filter='));
  const specOnly = args.includes('--spec-only') || args.includes('--spec');
  const testOnly = args.includes('--test-only');

  const requestedTier = tierArg ? tierArg.split('=')[1] : null;
  const suiteFilter = filterArg ? filterArg.split('=')[1] : undefined;

  console.log('\n============================================================');
  console.log('       Ofln-Scout End-to-End 4-Tier Verification Suite      ');
  console.log('============================================================\n');

  const tierSummaries: Record<string, SuiteSummary> = {};
  let overallFailed = 0;
  let overallPassed = 0;
  let overallTotal = 0;
  const startTime = Date.now();

  const tiersToRun = [
    {
      id: '1',
      name: 'Tier 1: Isolated Features',
      files: ['./tier1-features.test', './tier1-features.spec', './tier1-browser-enhancement.spec'],
    },
    {
      id: '2',
      name: 'Tier 2: Boundary & Corner Cases',
      files: ['./tier2-boundary.test', './tier2-boundary.spec', './tier2-browser-enhancement.spec'],
    },
    {
      id: '3',
      name: 'Tier 3: Pairwise Combinations',
      files: ['./tier3-pairwise.test', './tier3-combinations.spec', './tier3-browser-enhancement.spec'],
    },
    {
      id: '4',
      name: 'Tier 4: Realistic E2E Scenarios',
      files: ['./tier4-scenarios.test', './tier4-scenarios.spec', './tier4-browser-enhancement.spec'],
    },
  ].filter(t => !requestedTier || t.id === requestedTier);

  for (const tier of tiersToRun) {
    console.log(`\n\x1b[1m\x1b[35m=== Executing ${tier.name} ===\x1b[0m`);
    clearSuites();

    // Determine files to import based on flags and file existence
    let candidateFiles = tier.files;
    if (specOnly) {
      candidateFiles = candidateFiles.filter(f => f.endsWith('.spec'));
    } else if (testOnly) {
      candidateFiles = candidateFiles.filter(f => f.endsWith('.test'));
    }

    let loadedCount = 0;
    for (const f of candidateFiles) {
      const tsPath = path.resolve(__dirname, `${f.replace(/^\.\//, '')}.ts`);
      if (fs.existsSync(tsPath)) {
        await import(f);
        loadedCount++;
      }
    }

    if (loadedCount === 0) {
      console.log(`  \x1b[33m[WARN] No test or spec files found for ${tier.name}\x1b[0m`);
      continue;
    }

    const summary = await runAllSuites(suiteFilter);
    tierSummaries[tier.id] = summary;
    overallTotal += summary.total;
    overallPassed += summary.passed;
    overallFailed += summary.failed;
  }

  const totalDuration = Date.now() - startTime;

  console.log('\n============================================================');
  console.log('                   E2E TEST RUN SUMMARY                     ');
  console.log('============================================================');

  for (const [tierId, summary] of Object.entries(tierSummaries)) {
    const statusColor = summary.failed === 0 ? '\x1b[32m✔ PASS\x1b[0m' : '\x1b[31m✖ FAIL\x1b[0m';
    console.log(
      ` Tier ${tierId}: ${statusColor} | Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | (${summary.durationMs}ms)`
    );
  }

  console.log('------------------------------------------------------------');
  console.log(
    ` Total Tests:  ${overallTotal}\n` +
    ` Passed:       \x1b[32m${overallPassed}\x1b[0m\n` +
    ` Failed:       ${overallFailed > 0 ? `\x1b[31m${overallFailed}\x1b[0m` : '0'}\n` +
    ` Total Time:   ${totalDuration}ms\n` +
    ` Final Status: ${overallFailed === 0 ? '\x1b[32m✔ ALL SUITES PASSED\x1b[0m' : '\x1b[31m✖ TESTS FAILED\x1b[0m'}`
  );
  console.log('============================================================\n');

  if (overallFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal Runner Error:', err);
  process.exit(1);
});
