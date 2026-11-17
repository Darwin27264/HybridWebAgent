import type { StuckReason } from '@ofln-scout/shared';

export type { StuckReason };

export interface LoopDetectorOptions {
  threshold?: number; // Default: 3 consecutive cycles
  tolerance?: number; // Default: 5px
}

export interface CycleTelemetry {
  y: number;
  viewportHeight: number;
  scrollHeight: number;
  candidateCount: number;
  novelCount: number;
}

export interface LoopDetectionResult {
  isStagnant: boolean;
  stuckReason?: StuckReason;
  consecutiveEmptyCycles: number;
}

/**
 * Returns true if the viewport has reached or exceeded the bottom boundary
 * of the document within the specified pixel tolerance.
 */
export function isAtBottomOfPage(
  y: number,
  viewportHeight: number,
  scrollHeight: number,
  tolerance = 5
): boolean {
  if (scrollHeight <= 0) return false;
  return y + viewportHeight >= scrollHeight - tolerance;
}

/**
 * Returns true if the scroll position has not meaningfully changed between cycles.
 */
export function isScrollStatic(currY: number, prevY: number, tolerance = 5): boolean {
  return Math.abs(currY - prevY) <= tolerance;
}

/**
 * Tracks consecutive crawling cycles to detect browser stagnation, bottom of page,
 * zero novelty loops, repetitive scroll actions, and empty selector conditions.
 */
export class LoopDetector {
  public readonly threshold: number;
  public readonly tolerance: number;

  private _consecutiveEmptyCycles = 0;
  private _consecutiveEmptySelectorCycles = 0;
  private _consecutiveStaticScrollCycles = 0;
  private _totalCandidatesSeen = 0;
  private _prevY?: number;

  constructor(options: LoopDetectorOptions = {}) {
    this.threshold = options.threshold ?? 3;
    this.tolerance = options.tolerance ?? 5;
  }

  public get consecutiveEmptyCycles(): number {
    return this._consecutiveEmptyCycles;
  }

  public reset(): void {
    this._consecutiveEmptyCycles = 0;
    this._consecutiveEmptySelectorCycles = 0;
    this._consecutiveStaticScrollCycles = 0;
    this._totalCandidatesSeen = 0;
    this._prevY = undefined;
  }

  public recordCycle(telemetry: CycleTelemetry): LoopDetectionResult {
    const { y, viewportHeight, scrollHeight, candidateCount, novelCount } = telemetry;

    this._totalCandidatesSeen += candidateCount;

    // 1. Static scroll check
    const isStatic = this._prevY !== undefined && isScrollStatic(y, this._prevY, this.tolerance);
    if (isStatic) {
      this._consecutiveStaticScrollCycles++;
    } else {
      this._consecutiveStaticScrollCycles = 0;
    }

    // 2. Empty selector tracking
    if (candidateCount === 0) {
      this._consecutiveEmptySelectorCycles++;
    } else {
      this._consecutiveEmptySelectorCycles = 0;
    }

    // 3. Zero novelty tracking
    if (novelCount === 0) {
      this._consecutiveEmptyCycles++;
    } else {
      this._consecutiveEmptyCycles = 0;
    }

    // Update prevY
    this._prevY = y;

    // Check bottom boundary
    const isBottom = isAtBottomOfPage(y, viewportHeight, scrollHeight, this.tolerance);

    // Stagnation evaluation
    if (this._consecutiveEmptyCycles >= this.threshold) {
      let stuckReason: StuckReason;

      if (isBottom && (y > 0 || candidateCount > 0 || this._totalCandidatesSeen > 0)) {
        stuckReason = 'bottom_of_page';
      } else if (this._consecutiveEmptySelectorCycles >= this.threshold) {
        stuckReason = 'selector_empty';
      } else if (isStatic || this._consecutiveStaticScrollCycles >= this.threshold) {
        stuckReason = 'repeated_actions';
      } else {
        stuckReason = 'no_new_items';
      }

      return {
        isStagnant: true,
        stuckReason,
        consecutiveEmptyCycles: this._consecutiveEmptyCycles
      };
    }

    return {
      isStagnant: false,
      consecutiveEmptyCycles: this._consecutiveEmptyCycles
    };
  }
}
