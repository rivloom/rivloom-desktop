import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cockpitOnboardingStorageKey,
  evaluateCockpitOnboarding,
} from '../src/cockpit-onboarding.ts';

test('onboarding shows 2-step guide when models or workspaces are missing and auto-retires once complete', () => {
  const empty = evaluateCockpitOnboarding({
    owner: true,
    dismissed: false,
    engine: { ready: true, error: null, models: [] },
    projects: [],
  });
  assert.equal(empty.visible, true);
  assert.equal(empty.completedSteps, 0);
  assert.equal(empty.activeStep, 1);

  const modelOnly = evaluateCockpitOnboarding({
    owner: true,
    dismissed: false,
    engine: { ready: true, error: null, models: [{ id: 'p/m', name: 'Model' }] },
    projects: [],
  });
  assert.equal(modelOnly.visible, true);
  assert.equal(modelOnly.modelReady, true);
  assert.equal(modelOnly.workspaceReady, false);
  assert.equal(modelOnly.completedSteps, 1);
  assert.equal(modelOnly.activeStep, 2);

  const folderOnly = evaluateCockpitOnboarding({
    owner: true,
    dismissed: false,
    engine: { ready: true, error: null, models: [] },
    projects: [{ id: 'proj-1' }],
  });
  assert.equal(folderOnly.visible, true);
  assert.equal(folderOnly.completedSteps, 1);
  assert.equal(folderOnly.activeStep, 1);

  // Configured existing users never see onboarding
  const ready = evaluateCockpitOnboarding({
    owner: true,
    dismissed: false,
    engine: { ready: true, error: null, models: [{ id: 'p/m', name: 'Model' }] },
    projects: [{ id: 'proj-1' }],
  });
  assert.equal(ready.visible, false);
  assert.equal(ready.completedSteps, 2);
  assert.equal(ready.activeStep, null);
});

test('onboarding hides when explicitly dismissed or for non-owner members and isolates storage keys', () => {
  const dismissed = evaluateCockpitOnboarding({
    owner: true,
    dismissed: true,
    engine: { ready: true, error: null, models: [] },
    projects: [],
  });
  assert.equal(dismissed.visible, false);

  const member = evaluateCockpitOnboarding({
    owner: false,
    dismissed: false,
    engine: { ready: true, error: null, models: [] },
    projects: [],
  });
  assert.equal(member.visible, false);

  assert.notEqual(
    cockpitOnboardingStorageKey('u1', 'n1'),
    cockpitOnboardingStorageKey('u2', 'n1'),
  );
  assert.notEqual(
    cockpitOnboardingStorageKey('u1', 'n1'),
    cockpitOnboardingStorageKey('u1', 'n2'),
  );
});
