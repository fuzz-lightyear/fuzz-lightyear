module.exports = async function testSetup (modulePath) {
  const { setup, validation, operations } = require(modulePath)
  const { actual, reference, state } = await setup()
  const ops = operations(reference, actual, null)
  const validators = validation(reference, actual, null)
  const executor = makeExecutor(ops)

  return { actual, reference, state, executor, validators }
}

function makeExecutor (ops) {
  const executor = {}
  for (let name of Object.keys(ops)) {
    const op = ops[name]
    executor[name] = function () {
      return op.operation(...arguments)
    }
  }
  return executor
}
