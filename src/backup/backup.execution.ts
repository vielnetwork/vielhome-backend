/** One-shot bounds, deliberately shorter than the ten-minute request lease. */
export class ExecutionControl {
  private stopped = false;
  readonly claimDeadline: number;
  constructor(private readonly clock: () => number = Date.now) {
    this.claimDeadline = clock() + 240000;
  }
  stop(): void {
    this.stopped = true;
  }
  get stopping(): boolean {
    return this.stopped;
  }
  canClaim = (): boolean => !this.stopped && this.clock() < this.claimDeadline;
}

/** Signal handlers never verify or repair work. Forced exit leaves DB fencing intact. */
export function installTermination(control: ExecutionControl, forceExit: () => void): () => void {
  let grace: NodeJS.Timeout | undefined;
  const hard = setTimeout(() => {
    control.stop();
    forceExit();
  }, 480000);
  const stop = () => {
    control.stop();
    if (!grace) grace = setTimeout(forceExit, 30000);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return () => {
    clearTimeout(hard);
    if (grace) clearTimeout(grace);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  };
}
