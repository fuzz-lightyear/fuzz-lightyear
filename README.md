# fuzz-lightyear
fuzz-lightyear is a fuzzing framework and CLI tool that makes it easy to test complex systems with async behavior using a simplified model as a reference.

When given the simplest possible reference implementation of your program, fuzz-lightyear will apply random operations to both your actual implementation and your reference implementation, performing validation steps along the way to ensure they're always in sync.

If random operations ever lead to a failure, fuzz-lightyear will first attempt to shorten your test by removing as many operations as possible, then it will generate a failing [`tape`](https://github.com/substack/tape) test for you. It also provides a handful of CLI commands for executing/managing these test cases.

### Examples
We've used fuzz-lightyear internally to find bugs in a handful of tricky data structures. Check out how we used in it in:
1. [The upcoming bitfield for Hypercore](https://github.com/mafintosh/bitbase/tree/fuzz-based)
2. [A distributed trie implementation](https://github.com/mafintosh/mock-trie)

### Installation
`npm i fuzz-lightyear -g`

### Making a Fuzzer
Writing a target module that can be fuzzed with fuzz-lightyear involves writing a Node module that exports a single function that returns an object of the form:

`rng` is a random number generator as defined by [fuzzbuzz](https://github.com/mafintosh/fuzzbuzz)
`opts` is a copy of your `fuzzing.config.js`

```js
module.exports = async function fuzz (rng, opts) {
  // Set up your fuzzing state here, which will be accessible as closure state in your operations/validators.
  // The fuzzing state can be whatever you like.
  const fuzzingState = { ... }
  return {
    operations,
    validation,
    cleanup
  }
}
```

#### `operations`
Define the set of operations that you'd like to perform during fuzzing. This object must have the following form:
```js
{
  (operation name): {
    inputs: () => {
      return [] // Returns an array of inputs that will be passed to the operation.
    },
    operation: async (...inputs) => {
      // Mutate your fuzzing state according to the given inputs.
      // (The state is in the outer operations function scope here).
    }
  }
}
```
It's important that the input function be defined separately from the operation itself so that fuzz-lightyear can trace inputs over time. When a failing test is discovered, code generation uses these inputs.

As an example, here's what a simple kv-store `operations` object might return, if you're only testing `put` operations:
```js
module.exports = async function fuzz (rng, opts) {
  const state = {
    actual: ...,
    reference: ...
  }
  const operations = {
    put: {
      inputs: () => {
        // Generate a random key/value pair using the random number generator.
        return [keyFromRng(rng), valueFromRng(rng)]
      },
      operation: async (key, value) => {
        state.reference.put(key, value)
        await state.actual.put(key, value)
      }
    }
  }

  // Define your validators/cleanup here

  return {
    operations,
    validaton,
    cleanup
  }
}
```

#### `validation`
After a series of random operations (defined above) are performed on your fuzzing state, fuzz-lightyear will run a set of validation functions. If there's a mismatch, the validators are expected to throw errors. 

The validation process is split into tests and validators: tests are intended to be simple comparisons between the two objects, while the validators are more complicated flows that call test functions one or more times.

We define the tests separately in order to simplify code generation (the test functions will be imported by the generated test cases).

Your `validation` object must contain `tests` and `validators` sub-objects:
```js
{
  tests: {
    (your test name): async (...testArgs) => {
      // Compare the actual and reference objects, using testArgs as inputs.
      // If the comparison is invalid, throw an error.
    }
  },
  validators: {
    (your validator name): {
      operation: async (test) => {
        // Your validation logic that calls test one or more times.
      },
      test: 'name of the test above'
    }
  }
}
```

Continuing the kv-store example from above, here's what a simple validator that compares lots of random keys/values might look like:
```js
module.exports = async function fuzz (rng, opts) {
  const state = {
    actual: ...,
    reference: ...
  }

  // Operations from above go here

  const validation = {
    tests: {
      async sameValues (path) {
        const referenceVal = state.reference.get(path)
        const actualVal = await state.actual.get(path)
        if (referenceVal !== actualVal) throw new Error(`Values do not match for key: ${key}`)
      }
    },
    validators: {
      manyRandomKeys: {
        operation: async (test) {
          for (let i = 0; i < opts.numRandomKeys; i++) {
            const key = keyFromRng(rng)
            await test(key)
          }
        },
        test: 'sameValues'
      }
    }
  }

  return {
    operations,
    validaton,
    cleanup
  }
}

async function validation (state, rng, opts = {}) {
  return {
  }
}
```

#### `cleanup`

Your fuzzing module can also export an async `cleanup` function that will be called at the end of each fuzzing iteration. This is useful if your fuzzing state contains resources that need to be closed.

### Working with Generated Tests
When fuzz-lightyear finds a failure, it will attempt to generate a short test case for you. These tests are assigned unique hashes based on the operations that were performed and the validator that failed, then they're saved in a `test/autogenerated/failing/test-(hash).js` file.

You can either run these tests directly from the CLI using the `fuzz failing` command, or you can import the test cases in a Node repl to do manual testing on the reference/actual objects. The tests export a handful of helper functions:
```js
module.exports = {
  async runTest () { ... },     // Run the test case manually.
  runTapeTest () { ... },       // Run the tape test case.
  async getObjects () { ... },  // Returns the `reference` and `actual` objects in their pre-validation states.
  config: { ... }               // The fuzzing configuration that was used when this test was generated.
}
```

### Configuration
fuzz-lightyear expects your target module to contain a `fuzzing.config.js` file, which has a few required fields, and can have many additional user-defined fields:
```js
{
  seedPrefix: 'some-seed', // The prefix that will be prepended to every iteration-specific seed.
  seedNumber: 0,           // An iteration-specific seed number that's appended to the prefix.
  seed: 'some-seed0',      // A complete seed that will be used for the first iteration.
  randomSeed: false,       // Use a completely random seed instead of incrementing seedNumber
  numIterations: 2000,     // The number of fuzzing iterations to perform.
  numOperations: 10        // The number of operations to perform per iterations.
  shortening: {
    iterations: 1e6        // The maximum number of shortening iterations (larger means a shorter test case).
  },
  inputs: {
    // User-defined options related to input generation.
  },
  operations: {
    (operation name): {
      enabled: true,  // If enabled, this operation will be performed during fuzzing.
      weight: 1       // Defines how frequently this should run, relative to other ops.
    },
    ...
  },
  validation: {
    (validator name): {
      enabled: true,  // If enabled, this validator will run during validation.
      // Other user-defined validator opts can be defined here.
    }
  }
}
```

### CLI Usage
The `fuzz` command provides a list of operations for executing the fuzzer, and for managing generated test cases:

#### `fuzz run`
Perform fuzz testing.

If executed without arguments, `fuzz run` expects the current working directory to contain `fuzzing.js` and `fuzzing.config.js` files. You can also specify these with CLI arguments:
```
--config ./fuzzing.config.js // The path to the fuzzing config file.
--module ./fuzzing.js        // The path to the fuzzing module. 
```

The following additional configuration options can be overriden with CLI arguments:
```
--iterations 2000 // The number of fuzzing iterations to perform.
--opererations 10 // The number of random operations to perform per iteration.
--seed 0          // The starting seed number (this will be incremented after each iteration).
--debug false     // Enable debug logging
--print false     // Only print failing test cases (do not record them as autogenerated tests).
```

#### `fuzz regression`
Run all previously-failing tests (those which have been moved from `tests/autogenerated/failing` to `tests/autogenerated/fixed`)

#### `fuzz failing`
Run all currently-failing tests in `tests/autogenerated/failing`.

#### `fuzz fix`
Move any passing tests in `tests/autogenerated/failing` to `tests/autogenerated/fixed`

#### `fuzz clean`
Remove any untracked tests in `test/autogenerated/failing`. This is useful when you find failures that were due to reference bugs.

### License
MIT

### Sponsors
This project was kindly sponsored by NearForm.
