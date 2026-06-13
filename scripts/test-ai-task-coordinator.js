const assert = require('assert')
const { createAiTaskCoordinator } = require('../electron/aiTaskCoordinator')

async function main() {
  const coordinator = createAiTaskCoordinator()
  const events = []
  let running = 0
  let maximumRunning = 0

  const task = (name, delay) => coordinator.run(name, async () => {
    running += 1
    maximumRunning = Math.max(maximumRunning, running)
    events.push(`start:${name}`)
    await new Promise(resolve => setTimeout(resolve, delay))
    events.push(`end:${name}`)
    running -= 1
  })

  await Promise.all([
    task('embedding', 20),
    task('dino', 5),
    task('tagging', 1),
  ])

  assert.strictEqual(maximumRunning, 1, 'Only one AI task may run at once.')
  assert.deepStrictEqual(events, [
    'start:embedding', 'end:embedding',
    'start:dino', 'end:dino',
    'start:tagging', 'end:tagging',
  ])
  assert.deepStrictEqual(coordinator.status(), { active: null, queued: [] })
  console.log('AI task coordinator passed: embedding, DINO, and tagging run FIFO one at a time.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
