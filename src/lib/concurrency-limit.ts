/**
 * Builds a limiter that runs at most `slots` tasks at once, queuing the rest
 * FIFO. A task's slot is released in `finally`, so a task that throws or
 * rejects still frees it for the next one queued.
 */
export function createConcurrencyLimit(slots: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const queue: Array<() => void> = [];

  function next(): void {
    if (running >= slots) return;
    const dequeued = queue.shift();
    if (dequeued === undefined) return;
    running++;
    dequeued();
  }

  return function run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        work()
          .then(resolve, reject)
          .finally(() => {
            running--;
            next();
          });
      });
      next();
    });
  };
}
