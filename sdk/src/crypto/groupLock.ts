export type GroupLockPriority = 'urgent' | 'normal' | 'background'

type QueueTask<T> = {
  fn: () => Promise<T>
  priority: GroupLockPriority
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

type GroupQueue = {
  running: boolean
  urgent: QueueTask<unknown>[]
  normal: QueueTask<unknown>[]
  background: QueueTask<unknown>[]
}

const queues = new Map<string, GroupQueue>()

function getOrCreateQueue(groupId: string): GroupQueue {
  const existing = queues.get(groupId)
  if (existing) {
    return existing
  }

  const created: GroupQueue = {
    running: false,
    urgent: [],
    normal: [],
    background: []
  }

  queues.set(groupId, created)
  return created
}

function nextTask(queue: GroupQueue): QueueTask<unknown> | undefined {
  return queue.urgent.shift() ?? queue.normal.shift() ?? queue.background.shift()
}

function maybeCleanupQueue(groupId: string, queue: GroupQueue): void {
  if (
    !queue.running &&
    queue.urgent.length === 0 &&
    queue.normal.length === 0 &&
    queue.background.length === 0
  ) {
    queues.delete(groupId)
  }
}

function runNext(groupId: string): void {
  const queue = queues.get(groupId)
  if (!queue || queue.running) {
    return
  }

  const task = nextTask(queue)
  if (!task) {
    maybeCleanupQueue(groupId, queue)
    return
  }

  queue.running = true

  void task.fn()
    .then(task.resolve, task.reject)
    .finally(() => {
      const current = queues.get(groupId)
      if (!current) {
        return
      }

      current.running = false
      runNext(groupId)
      maybeCleanupQueue(groupId, current)
    })
}

export function withGroupLock<T>(
  groupId: string,
  fn: () => Promise<T>,
  priority: GroupLockPriority = 'normal'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const queue = getOrCreateQueue(groupId)
    const task: QueueTask<T> = {
      fn,
      priority,
      resolve,
      reject
    }

    queue[priority].push(task as QueueTask<unknown>)
    runNext(groupId)
  })
}
