function createAiTaskCoordinator() {
  let active = null
  const queue = []

  function drain() {
    if (active || queue.length === 0) return
    const next = queue.shift()
    active = next.name
    let released = false
    next.resolve(() => {
      if (released) return
      released = true
      active = null
      drain()
    })
  }

  function acquire(name) {
    return new Promise(resolve => {
      queue.push({ name, resolve })
      drain()
    })
  }

  async function run(name, task) {
    const release = await acquire(name)
    try {
      return await task()
    } finally {
      release()
    }
  }

  return {
    acquire,
    run,
    status: () => ({ active, queued: queue.map(item => item.name) }),
  }
}

module.exports = { createAiTaskCoordinator }
