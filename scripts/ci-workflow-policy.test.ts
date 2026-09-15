import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ciRoot } from './ci-workspace.ts';

const load = (name: string) => parse(readFileSync(join(ciRoot, '.github/workflows', name), 'utf8'));
const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
const candidateCondition = compact(`
  github.repository == 'rivloom/rivloom-desktop' &&
  ((github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||
   (github.event_name == 'push' && startsWith(github.ref, 'refs/tags/ci-v')) ||
   (github.event_name == 'workflow_run' &&
   github.event.workflow_run.conclusion == 'success' &&
   github.event.workflow_run.event == 'push' &&
   github.event.workflow_run.head_branch == 'main' &&
   github.event.workflow_run.head_repository.full_name == github.repository))
`);

// Deliberately review the small, explicit workflow set. New privileged workflows
// must update this policy instead of silently acquiring publication access.
function audit(name: string, workflow: any) {
  assert(!('pull_request_target' in workflow.on), 'Privileged PR trigger');
  assert.equal(workflow.permissions.contents, 'read');
  assert(Object.values(workflow.permissions).every((value) => value === 'read'));
  assert(!JSON.stringify(workflow.env ?? {}).includes('secrets.'), 'Workflow-level secret');
  const release = name === 'windows-candidate.yml';
  const inventory = name === 'r2-inventory.yml';
  if (release) {
    assert.deepEqual(Object.keys(workflow.on).sort(), [
      'push',
      'workflow_dispatch',
      'workflow_run',
    ]);
    assert.equal(compact(workflow.jobs.candidate.if), candidateCondition, 'Candidate trust gate');
    assert.deepEqual(Object.keys(workflow.jobs).sort(), [
      'candidate',
      'publish',
      'updater',
      'website-download',
    ]);
    assert.equal(workflow.jobs.publish.needs, 'candidate');
    assert.deepEqual(workflow.jobs['website-download'].needs, ['candidate', 'publish']);
    assert.deepEqual(workflow.jobs.updater.needs, ['candidate', 'publish', 'website-download']);
    for (const job of ['publish', 'website-download', 'updater'])
      assert(
        !/always\s*\(|!\s*cancelled\s*\(/.test(workflow.jobs[job].if ?? ''),
        'Cannot bypass failed prerequisites',
      );
  } else if (inventory) {
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.deepEqual(Object.keys(workflow.jobs), ['inventory']);
    assert.equal(
      workflow.jobs.inventory.if,
      "github.repository == 'rivloom/rivloom-desktop' && github.ref == 'refs/heads/main'",
    );
  } else {
    assert(
      ['ci.yml', 'windows-services.yml', 'lan-regression.yml'].includes(name),
      'Unreviewed workflow',
    );
    assert.deepEqual(Object.keys(workflow.on).sort(), [
      'pull_request',
      'push',
      'workflow_dispatch',
    ]);
    assert(!JSON.stringify(workflow).includes('secrets.'), 'PR workflow secret');
  }
  for (const [id, job] of Object.entries(workflow.jobs) as [string, any][]) {
    const permissions = job.permissions ?? workflow.permissions;
    for (const [scope, value] of Object.entries(permissions))
      assert(
        value === 'read' ||
          value === 'none' ||
          (release && id === 'publish' && scope === 'contents' && value === 'write'),
        'Unexpected write permission',
      );
    assert(!JSON.stringify(job.env ?? {}).includes('secrets.'), 'Job-level secret');
    if (release && (id === 'candidate' || id === 'publish'))
      assert(
        !JSON.stringify(job).includes('secrets.'),
        'Build/publication cannot access deployment secrets',
      );
    assert.equal(job['runs-on'], 'windows-2022', 'Use disposable hosted runners');
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      assert(
        /^actions\/[\w-]+@[a-f0-9]{40}$/.test(step.uses),
        'Actions must use reviewed commit pins',
      );
      assert(!step.uses.startsWith('actions/cache@'), 'Shared cache crosses trust boundary');
      if (step.uses.startsWith('actions/checkout@')) {
        assert.equal(step.with['persist-credentials'], false);
        if (release) assert.equal(step.with.ref, '${{ env.RIVLOOM_CANDIDATE_SHA }}');
      }
      if (step.uses.startsWith('actions/download-artifact@')) {
        assert(release, 'Unreviewed artifact execution');
        assert(
          /^\$\{\{ needs\.(candidate|publish)\.outputs\.artifact-id \}\}$/.test(
            step.with['artifact-ids'],
          ),
          'Artifact must come from this run',
        );
        assert.equal(step.with['digest-mismatch'], 'error');
        assert(!('run-id' in step.with) && !('repository' in step.with) && !('name' in step.with));
      }
    }
  }
}

test('public workflows preserve PR isolation, release provenance and action pins', () => {
  for (const name of readdirSync(join(ciRoot, '.github/workflows'))) audit(name, load(name));
});

test('workflow policy rejects privileged PRs, leaked secrets and unpinned actions', () => {
  const mutate = (change: (workflow: any) => void) => {
    const workflow = load('ci.yml');
    change(workflow);
    assert.throws(() => audit('ci.yml', workflow));
  };
  mutate((w) => {
    w.on.pull_request_target = {};
  });
  mutate((w) => {
    w.jobs.build.permissions = { contents: 'write' };
  });
  mutate((w) => {
    w.jobs.build.steps[0].env = { KEY: '${{ secrets.KEY }}' };
  });
  mutate((w) => {
    w.jobs.build.steps[0].uses = 'actions/checkout@main';
  });
  mutate((w) => {
    w.jobs.build.steps[0].with['persist-credentials'] = true;
  });
});

test('workflow policy rejects bypassed release gates and artifacts from another run', () => {
  const mutate = (change: (workflow: any) => void) => {
    const workflow = load('windows-candidate.yml');
    change(workflow);
    assert.throws(() => audit('windows-candidate.yml', workflow));
  };
  mutate((w) => {
    w.jobs.candidate.if = 'true';
  });
  mutate((w) => {
    w.jobs.publish.needs = [];
  });
  mutate((w) => {
    w.jobs.updater.if = 'always()';
  });
  mutate((w) => {
    w.jobs.publish.steps.find((s: any) => s.uses?.startsWith('actions/download-artifact@')).with[
      'run-id'
    ] = '123';
  });
  mutate((w) => {
    w.jobs.candidate.steps[0].with.ref = 'main';
  });
});
