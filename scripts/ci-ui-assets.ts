import { verifyUiAssets } from './ci-desktop-install-smoke.ts';
import { ciRoot, environmentRecord, saveReport } from './ci-workspace.ts';

// Reuse the installed-byte checks against the frontend build before spending
// time on native compilation. This command never installs or starts anything.
try {
  const ui = verifyUiAssets(ciRoot, ciRoot);
  await saveReport('ui-assets', { status: 'passed', environment: environmentRecord(), ...ui });
  console.log(`Frontend assets verified: ${ui.brands} referenced original brand images.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Frontend asset verification failed');
  process.exitCode = 1;
}
