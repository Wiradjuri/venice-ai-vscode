export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Opens after N consecutive failures and stops letting requests through until a cooldown
 * elapses, then allows exactly one half-open probe before deciding to close or re-open.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private nextRetryAt = 0;

  constructor(
    private readonly failureThreshold = 3,
    private readonly cooldownMs = 30000
  ) {}

  /** Returns true if a request may proceed, flipping open -> half-open once the cooldown elapses. */
  canRequest(): boolean {
    if (this.state !== 'open') {
      return true;
    }
    if (Date.now() >= this.nextRetryAt) {
      this.state = 'half-open';
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  onFailure(): void {
    this.consecutiveFailures++;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.nextRetryAt = Date.now() + this.cooldownMs;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getRetryAfterMs(): number {
    return Math.max(0, this.nextRetryAt - Date.now());
  }
}
