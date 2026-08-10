export interface TaskSchedulerOptions {
  maxParallel: number;
  onTaskError?: (error: unknown, task: ScheduledTask) => void;
}

interface ScheduledTask {
  id: string;
  contextKey: string;
}

export interface TaskReceipt {
  id: string;
  position: number;
  startedImmediately: boolean;
  maxParallel: number;
}

type TaskRunner = () => Promise<void> | void;

type QueuedTask = ScheduledTask & {
  run: TaskRunner;
};

export class TaskScheduler {
  private readonly queues = new Map<string, QueuedTask[]>();
  private readonly activeContexts = new Set<string>();
  private activeCount = 0;
  private nextId = 1;

  constructor(private readonly options: TaskSchedulerOptions) {
    if (!Number.isInteger(options.maxParallel) || options.maxParallel <= 0) {
      throw new Error("maxParallel must be a positive integer");
    }
  }

  enqueue(contextKey: string, run: TaskRunner, taskId?: string): TaskReceipt {
    const queue = this.getQueue(contextKey);
    const startedImmediately = this.canStart(contextKey) && queue.length === 0;
    const position = this.pendingCountForContext(contextKey) + 1;
    const task: QueuedTask = {
      id: taskId ?? `task-${this.nextId++}`,
      contextKey,
      run,
    };

    queue.push(task);
    this.drain();

    return {
      id: task.id,
      position,
      startedImmediately,
      maxParallel: this.options.maxParallel,
    };
  }

  clear(contextKey: string): number {
    const queue = this.queues.get(contextKey);
    const cleared = queue?.length ?? 0;
    this.queues.delete(contextKey);
    return cleared;
  }

  remove(contextKey: string, taskId: string): boolean {
    const queue = this.queues.get(contextKey);
    if (!queue) {
      return false;
    }

    const index = queue.findIndex((task) => task.id === taskId);
    if (index < 0) {
      return false;
    }

    queue.splice(index, 1);
    if (queue.length === 0) {
      this.queues.delete(contextKey);
    }
    return true;
  }

  hasPending(contextKey: string): boolean {
    return this.activeContexts.has(contextKey) || (this.queues.get(contextKey)?.length ?? 0) > 0;
  }

  pendingCountForContext(contextKey: string): number {
    return (this.activeContexts.has(contextKey) ? 1 : 0) + (this.queues.get(contextKey)?.length ?? 0);
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  private getQueue(contextKey: string): QueuedTask[] {
    let queue = this.queues.get(contextKey);
    if (!queue) {
      queue = [];
      this.queues.set(contextKey, queue);
    }
    return queue;
  }

  private canStart(contextKey: string): boolean {
    return this.activeCount < this.options.maxParallel && !this.activeContexts.has(contextKey);
  }

  private drain(): void {
    while (this.activeCount < this.options.maxParallel) {
      const next = this.nextStartableTask();
      if (!next) {
        return;
      }

      this.start(next.contextKey, next.task);
    }
  }

  private nextStartableTask(): { contextKey: string; task: QueuedTask } | undefined {
    for (const [contextKey, queue] of this.queues) {
      if (queue.length === 0 || this.activeContexts.has(contextKey)) {
        continue;
      }

      const task = queue.shift();
      if (queue.length === 0) {
        this.queues.delete(contextKey);
      }
      if (task) {
        return { contextKey, task };
      }
    }

    return undefined;
  }

  private start(contextKey: string, task: QueuedTask): void {
    this.activeContexts.add(contextKey);
    this.activeCount += 1;

    void Promise.resolve()
      .then(() => task.run())
      .catch((error) => {
        this.options.onTaskError?.(error, task);
      })
      .finally(() => {
        this.activeContexts.delete(contextKey);
        this.activeCount -= 1;
        this.drain();
      });
  }
}
