/**
 * Builds a limiter that runs at most `slots` tasks at once, queuing the rest
 * FIFO. A task's slot is released in `finally`, so a task that throws
 * synchronously, returns a rejected promise, or rejects asynchronously still
 * frees it for the next one queued. `Promise.resolve().then(work)` is what
 * makes the synchronous-throw case true: a queued task's `work()` runs
 * inside that `.then` callback rather than directly in this function's own
 * call stack, so a throw there becomes that promise's rejection instead of
 * escaping synchronously past the `.then`/`.finally` chain that would
 * otherwise never get attached.
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
        Promise.resolve()
          .then(work)
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
