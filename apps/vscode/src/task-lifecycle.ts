/** Track only tasks launched by this extension, by execution identity. */
export type TaskOutcome = 'running' | 'succeeded' | 'failed' | 'cancelled';
export class TaskLifecycle<T extends object> {
  private readonly active = new Map<T, string>();
  constructor(private readonly changed: (root: string, outcome: TaskOutcome) => void) {}
  start(execution: T, root: string): void {
    this.active.set(execution, root);
    this.changed(root, 'running');
  }
  end(execution: T, exitCode: number | undefined): void {
    const root = this.active.get(execution);
    if (root === undefined) return;
    this.active.delete(execution);
    if ([...this.active.values()].includes(root)) { this.changed(root, 'running'); return; }
    this.changed(root, exitCode === undefined ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed');
  }
}
