type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

export class ProjectWorkLock {
  private readonly active = new Set<string>();
  private readonly queues = new Map<string, Waiter[]>();

  async runExclusive<T>(
    workspace: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire(workspace, signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  isLocked(workspace: string): boolean {
    return this.active.has(workspace);
  }

  private acquire(workspace: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new ProjectWorkAbortedError());
    if (!this.active.has(workspace)) {
      this.active.add(workspace);
      return Promise.resolve(this.releaseFor(workspace));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          const queue = this.queues.get(workspace);
          const index = queue?.indexOf(waiter) ?? -1;
          if (index >= 0) queue!.splice(index, 1);
          if (queue?.length === 0) this.queues.delete(workspace);
          reject(new ProjectWorkAbortedError());
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      const queue = this.queues.get(workspace) ?? [];
      queue.push(waiter);
      this.queues.set(workspace, queue);
    });
  }

  private releaseFor(workspace: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.queues.get(workspace);
      const next = queue?.shift();
      if (queue?.length === 0) this.queues.delete(workspace);
      if (!next) {
        this.active.delete(workspace);
        return;
      }
      if (next.signal && next.abort) {
        next.signal.removeEventListener("abort", next.abort);
      }
      next.resolve(this.releaseFor(workspace));
    };
  }
}

export class ProjectWorkAbortedError extends Error {
  constructor() {
    super("Работа над проектом остановлена");
  }
}
