import { isNodeQueueCandidate, type NodeQueueSnapshot } from '../shared/node-queue.ts';

export type NodeHealthState = 'normal' | 'unknown' | 'congested' | 'resource_anomaly' | 'stalled';
export type NodeHealthThresholds = {
  maximumWaiting: number;
  congestionWaiting: number;
  congestionAgeMilliseconds: number;
  stalledMilliseconds: number;
  sampleFreshMilliseconds: number;
  maximumSampleGapMilliseconds: number;
  sustainedLoadMilliseconds: number;
  highLoadPercent: number;
};

/** Conservative operational thresholds, not estimates of model speed or completion time. */
export const defaultNodeHealthThresholds: NodeHealthThresholds = {
  maximumWaiting: 1000,
  congestionWaiting: 100,
  congestionAgeMilliseconds: 60 * 60_000,
  stalledMilliseconds: 5 * 60_000,
  sampleFreshMilliseconds: 20_000,
  maximumSampleGapMilliseconds: 20_000,
  sustainedLoadMilliseconds: 2 * 60_000,
  highLoadPercent: 95,
};
export type NodeHealthResourceSample = {
  sampledAt: string;
  cpuPercent: number | null;
  gpuPercent: number | null;
};
export type NodeHealthAssessment = {
  state: NodeHealthState;
  accepting: boolean;
  reason: 'capacity_reached' | 'receiving_disabled' | null;
  waitingCount: number;
  oldestWaitingMilliseconds: number | null;
  updatedAt: string;
};

export class NodeHealthMonitor {
  readonly thresholds: NodeHealthThresholds;
  private readonly clock: () => number;
  private sample: NodeHealthResourceSample | null = null;
  private highSince: number | null = null;
  private highSamples = 0;

  constructor(options: { clock?: () => number; thresholds?: Partial<NodeHealthThresholds> } = {}) {
    this.clock = options.clock || Date.now;
    this.thresholds = { ...defaultNodeHealthThresholds, ...options.thresholds };
    if (
      Object.values(this.thresholds).some((value) => !Number.isFinite(value) || value <= 0) ||
      this.thresholds.highLoadPercent > 100
    )
      throw new Error('Node 健康阈值无效。');
  }

  observeResource(sample: NodeHealthResourceSample) {
    const at = Date.parse(sample.sampledAt);
    const now = this.clock();
    const validMetric = (metric: number | null) =>
      metric === null || (Number.isFinite(metric) && metric >= 0 && metric <= 100);
    if (
      !Number.isFinite(at) ||
      at > now + 1000 ||
      !validMetric(sample.cpuPercent) ||
      !validMetric(sample.gpuPercent)
    )
      return;
    const previousAt = this.sample ? Date.parse(this.sample.sampledAt) : null;
    if (previousAt !== null && at <= previousAt) return;
    const high = [sample.cpuPercent, sample.gpuPercent].some(
      (value) => value !== null && value >= this.thresholds.highLoadPercent,
    );
    if (!high) {
      this.highSince = null;
      this.highSamples = 0;
    } else if (
      this.highSince === null ||
      previousAt === null ||
      at - previousAt > this.thresholds.maximumSampleGapMilliseconds
    ) {
      this.highSince = at;
      this.highSamples = 1;
    } else this.highSamples++;
    this.sample = { ...sample };
  }

  assess(input: {
    queue: NodeQueueSnapshot;
    availableSlots: number;
    executionPaused: boolean;
    /** False only for an explicit receive policy, never inferred from executionPaused. */
    receiving?: boolean;
    lastDispatchProgressAt: string | null;
  }): NodeHealthAssessment {
    const now = this.clock();
    const waiting = input.queue.entries.filter((entry) =>
      ['waiting', 'held'].includes(entry.state),
    );
    const oldest = waiting.length
      ? Math.max(0, ...waiting.map((entry) => now - Date.parse(entry.createdAt)))
      : null;
    const sampleAt = this.sample ? Date.parse(this.sample.sampledAt) : null;
    const fresh = sampleAt !== null && now - sampleAt <= this.thresholds.sampleFreshMilliseconds;
    const metricsKnown = this.sample?.cpuPercent !== null || this.sample?.gpuPercent !== null;
    let state: NodeHealthState = fresh && metricsKnown ? 'normal' : 'unknown';
    if (
      fresh &&
      this.highSince !== null &&
      this.highSamples >= 2 &&
      sampleAt! - this.highSince >= this.thresholds.sustainedLoadMilliseconds
    )
      state = 'resource_anomaly';
    if (
      waiting.length >= this.thresholds.congestionWaiting &&
      (oldest || 0) >= this.thresholds.congestionAgeMilliseconds
    )
      state = 'congested';
    const candidates = waiting.filter(isNodeQueueCandidate);
    const progressAt = input.lastDispatchProgressAt
      ? Date.parse(input.lastDispatchProgressAt)
      : null;
    if (
      !input.queue.paused &&
      !input.executionPaused &&
      input.availableSlots > 0 &&
      candidates.some(
        (entry) =>
          now - Math.max(Date.parse(entry.createdAt), progressAt || 0) >=
          this.thresholds.stalledMilliseconds,
      )
    )
      state = 'stalled';
    const reason =
      input.receiving === false
        ? 'receiving_disabled'
        : waiting.length >= this.thresholds.maximumWaiting
          ? 'capacity_reached'
          : null;
    return {
      state,
      accepting: reason === null,
      reason,
      waitingCount: waiting.length,
      oldestWaitingMilliseconds: oldest,
      updatedAt: new Date(now).toISOString(),
    };
  }
}
