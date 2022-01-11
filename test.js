module.exports = async function testSetup (fuzzModule) {
  const { operations, validation } = await fuzzModule()
  return {
    executor: makeExecutor(operations),
    validators: validation
  }
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
