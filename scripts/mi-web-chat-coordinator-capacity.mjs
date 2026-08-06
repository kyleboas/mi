// Coordinator capacity accounting for iMessage v2. It lives in its own module
// so restart accounting can be tested directly against real worker records.

const terminalStatuses = ['complete', 'completed', 'done', 'error', 'stopped'];

// Only a non-terminal record is genuinely active work. A retained completed
// record may still be useful for history and deduplication, but it must never
// reserve capacity.
export function coordinatorRecordIsActive(worker) {
  const status = String(worker?.status || '').toLowerCase();
  return Boolean(worker) && !terminalStatuses.includes(status);
}

export function coordinatorRecordReserves(worker) {
  return Boolean(worker?.coordinator) && coordinatorRecordIsActive(worker);
}

export function createCoordinatorCapacity({ globalLimit, threadLimit }) {
  let activeCount = 0;
  const threadCounts = new Map();

  const capacity = {
    get activeCount() { return activeCount; },
    threadCount(threadId) { return threadCounts.get(threadId) || 0; },
    reset() {
      activeCount = 0;
      threadCounts.clear();
    },
    // Restart adoption. Genuinely active coordinators keep their reservation so
    // behavior stays fail-closed across a restart; every other retained record
    // is explicitly marked unreserved so release accounting cannot drift.
    adopt(worker) {
      if (!worker?.coordinator) return false;
      if (!coordinatorRecordIsActive(worker)) {
        worker.coordinatorReserved = false;
        return false;
      }
      worker.coordinatorReserved = true;
      activeCount += 1;
      threadCounts.set(worker.threadId, (threadCounts.get(worker.threadId) || 0) + 1);
      return true;
    },
    reserve(threadId) {
      if (activeCount >= globalLimit) return false;
      const current = threadCounts.get(threadId) || 0;
      if (current >= threadLimit) return false;
      activeCount += 1;
      threadCounts.set(threadId, current + 1);
      return true;
    },
    release(worker) {
      if (!worker?.coordinator || !worker.coordinatorReserved) return false;
      worker.coordinatorReserved = false;
      activeCount = Math.max(0, activeCount - 1);
      const current = threadCounts.get(worker.threadId) || 0;
      if (current <= 1) threadCounts.delete(worker.threadId);
      else threadCounts.set(worker.threadId, current - 1);
      return true;
    },
  };
  return capacity;
}
