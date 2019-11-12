const p = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const test = require('tape')
const deepmerge = require('deepmerge')
const FuzzBuzz = require('fuzzbuzz')

const consts = require('./consts')
const defaults = require('./defaults')

class TraceExecutor {
  constructor (trace, operations, debug) {
    this._trace = trace
    this.operations = operations
    this.debug = debug
  }

  get trace () {
    return this._trace
  }

  async _exec (inputs, op) {
    // TODO: hack to prevent saturating the event loop (so ctrl+c exits)
    await new Promise(resolve => setImmediate(resolve))
    if (!inputs) inputs = op.inputs()
    await op.operation(...inputs)
    return inputs
  }

  async pushAndExecute (name) {
    const op = this.operations[name]
    const inputs = await this._exec(null, op)
    if (this.debug) this.debug(`executing ${name}(${JSON.stringify(inputs)})`)
    this._trace.push({ inputs, name, op })
  }

  async replay () {
    for (const { inputs, name } of this._trace) {
      await this._exec(inputs, this.operations[name])
    }
  }
}

class GenericFuzzer extends EventEmitter {
  constructor (userFunctions, opts = {}) {
    super()
    this.opts = opts
    this.seed = this.opts.seed
    this.seedNumber = this.opts.seedNumber
    this.fuzzer = new FuzzBuzz({
      seed: this.seed + this.seedNumber,
      debugging: this.opts.debug,
      validate: this.validate.bind(this)
    })

    this.rng = this.fuzzer.randomInt.bind(this.fuzzer)
    this.debug = this.fuzzer.debug.bind(this.fuzzer)

    this._userFunctions = userFunctions

    this.actual = null
    this.reference = null
    this.state = null
    this.operations = null
    this.validation = null
    this.executor = null
  }

  _wrapOperation (name) {
    return async () => {
      await this.executor.pushAndExecute(name)
      this.emit('progress')
    }
  }

  async _setup () {
    const { actual, reference, state } = await this._userFunctions.setup()
    const operations = this._userFunctions.operations(reference, actual, this.rng, this.opts)
    const validation = this._userFunctions.validation(reference, actual, this.rng, this.opts)
    return { actual, reference, state, operations, validation }
  }

  async setup () {
    const { actual, reference, state, operations, validation } = await this._setup()
    this.actual = actual
    this.reference = reference
    this.state = state
    this.operations = operations
    this.validation = validation
    this.executor = new TraceExecutor([], this.operations, this.debug)

    for (const name of Object.keys(this.operations)) {
      const operation = this.operations[name]
      const config = this.opts.operations[name]
      if (!config) {
        console.warn(`Skipping operation ${name} because it does not have a valid configuration`)
        continue
      } else if (!config.enabled) {
        this.debug(`Skipping operation ${name} because it is disabled.`)
        continue
      }
      this.fuzzer.add(config.weight, this._wrapOperation(name))
    }
  }

  async run () {
    try {
      await this.fuzzer.run(this.opts.numOperations)
    } catch (err) {
      console.log('Found a failure. Attempting to shorten the test case...')
      throw await this.shorten(err)
    }
  }

  async _test (testName, testFunc, testArgs) {
    try {
      await testFunc(...testArgs)
    } catch (err) {
      err[consts.TestArgs] = testArgs
      err[consts.TestName] = testName
      err[consts.Description] = err.message
      err[consts.LongDescription] = err.longDescription
      err[consts.TestFunction] = test
      err[consts.Config] = this.opts
      err[consts.FuzzError] = true
      throw err
    }
  }

  async shorten (err) {
    this.debug(`attempting to shorten the trace with a maximum of ${this.opts.shortening.iterations} mutations`)
    const testName = err[consts.TestName]
    const testArgs = err[consts.TestArgs]

    var shortestTrace = [ ...this.executor.trace ]
    var numShortenings = 0
    var numIterations = 0
    var error = err

    const stack = shortestTrace.map((_, i) => { return { i, trace: shortestTrace } })

    while (stack.length && numIterations < this.opts.shortening.iterations) {
      const { i, trace } = stack.pop()
      if (!trace.length) continue

      const nextTrace = [ ...trace ]
      nextTrace.splice(i, 1)

      const { actual, reference, state, operations, validation } = await this._setup()
      const executor = new TraceExecutor(nextTrace, operations)
      const test = validation.tests[testName]

      await executor.replay()

      try {
        await this._test(testName, test, testArgs)
      } catch (err) {
        if (nextTrace.length < shortestTrace.length) {
          stack.push(...nextTrace.map((_, i) => { return { i, trace: nextTrace } }))
          shortestTrace = nextTrace
          numShortenings++
          error = err
        }
      }
      numIterations++
    }

    this.debug(`shortened the trace by ${numShortenings} operations`)
    err[consts.Trace] = shortestTrace
    return err
  }

  async validate () {
    if (!this.validation.validators) return
    const self = this

    for (const name of Object.keys(this.validation.validators)) {
      const opts = this.opts.validation[name]
      if (!opts.enabled) continue

      const validator = this.validation.validators[name]
      const test = this.validation.tests[validator.test]
      var testArgs = null

      const wrappedTest = function () {
        testArgs = arguments
        self.debug(`in validator ${name}, testing ${validator.test}(${JSON.stringify([...testArgs])})`)
        return test(...arguments)
      }
      try {
        this.debug(`validating with validator: ${name}`)
        await validator.operation(wrappedTest)
      } catch (err) {
        err[consts.TestArgs] = testArgs
        err[consts.TestName] = validator.test
        err[consts.Description] = err.message
        err[consts.LongDescription] = err.longDescription
        err[consts.TestFunction] = test
        err[consts.Config] = this.opts
        err[consts.FuzzError] = true
        err[consts.Trace] = this.executor.trace
        throw err
      }
    }
  }
}

function create (userFunctions, userConfig) {
  const opts = deepmerge(defaults, userConfig)
  const seedPrefix = opts.randomSeed ? crypto.randomBytes(16).toString('hex') : opts.seedPrefix
  const seedNumber = (opts.seedNumber !== undefined) ? opts.seedNumber : 0
  var events = new EventEmitter()

  return { events, run }

  async function run () {
    for (let i = 0; i < opts.numIterations; i++) {
      const fuzzer = new GenericFuzzer(userFunctions, {
        ...userConfig,
        seed: seedPrefix,
        seedNumber: seedNumber + i
      })
      await fuzzer.setup()
      events.emit('progress')
      await fuzzer.run()
    }
  }
}

module.exports = {
  GenericFuzzer,
  create
}
