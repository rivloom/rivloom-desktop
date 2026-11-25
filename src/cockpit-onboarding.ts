import type { Bootstrap, Project } from '../shared/types.ts';

export type CockpitOnboardingState = {
  visible: boolean;
  modelReady: boolean;
  workspaceReady: boolean;
  engineReady: boolean;
  engineError: boolean;
  completedSteps: number;
  totalSteps: 2;
  activeStep: 1 | 2 | null;
};

export function cockpitOnboardingStorageKey(userID: string, nodeID: string): string {
  return `rivloom:cockpit-onboarding:dismissed:v1:${nodeID}:${userID}`;
}

/**
 * Evaluate whether the non-blocking 2-step onboarding strip should appear at the top
 * of MissionCockpit. Auto-retires as soon as both a model and a workspace folder exist,
 * and never disturbs already-configured users or explicitly dismissed sessions.
 */
export function evaluateCockpitOnboarding(input: {
  owner: boolean;
  dismissed: boolean;
  engine: Pick<Bootstrap['engine'], 'ready' | 'error' | 'models'>;
  projects: readonly Pick<Project, 'id'>[];
}): CockpitOnboardingState {
  const modelReady = input.engine.models.length > 0;
  const workspaceReady = input.projects.length > 0;
  const completedSteps = Number(modelReady) + Number(workspaceReady);
  const allComplete = modelReady && workspaceReady;
  const visible = input.owner && !input.dismissed && !allComplete;
  const activeStep: 1 | 2 | null = !modelReady ? 1 : !workspaceReady ? 2 : null;
  return {
    visible,
    modelReady,
    workspaceReady,
    engineReady: input.engine.ready,
    engineError: Boolean(input.engine.error),
    completedSteps,
    totalSteps: 2,
    activeStep,
  };
}
