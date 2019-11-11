# fuzz-lightyear
fuzz-lightyear is a fuzzing framework and CLI tool that makes it easy to test complex systems with async behavior using a simplified model as a reference.

When given the simplest possible reference implementation of your program, fuzz-lightyear will apply random operations to both your actual implementation and your reference implementation, performing validation steps along the way to ensure they're always in sync.

If random operations ever lead to a failure, fuzz-lightyear will first attempt to shorten your test by removing as many operations as possible, then it will generate a failing [`tape`](https://github.com/substack/tape) test for you. It also provides a handful of CLI commands for executing/managing these test cases.

### Examples
We've used fuzz-lightyear internally to find bugs in a handful of tricky data structures. Check out how we used in it in:
1. [The bitfield used in Hypercore](https://github.com/mafintosh/bitbase/tree/fuzz-based)
2. [A distributed trie implementation](https://github.com/mafintosh/mock-trie)

### Installation
`npm i fuzz-lightyear -g`

### Making a Fuzzer
Before writing a fuzzer, you should create your reference model as a class. It's assumed that your reference API mirrors the relevant portions of your actual API (those methods being fuzzed).

Writing a target module that can be fuzzed with fuzz-lightyear involves writing a Node module that exports `setup` `operations`, and `validation` functions. The functions must have the following signatures:

#### `async setup()`
Perform any necessary setup to generate your reference and actual data structures. Must return an object of the form:
```js
{ reference, actual, state }
```

`state` is an optional, user-defined object that will be passed through all operations, which you can use to store auxilliary information during testing that isn't contained in either `reference` or `actual`. It can be `null`.

#### `async operations (reference, actual, rng, opts = {})`
Define the set of operations that you'd like to perform during fuzzing. This function must return an object with keys and values of the following form:
```js
{
  (operation name): {
    inputs: () => {
      return [] // Returns an array of inputs that will be passed to the operation.
    },
    operation: async (...inputs) => {
      // Mutate the actual/reference data structures according to the given inputs.
      // (The data structures are in the outer operations function scope here).
    }
  }
}
```
It's important that the input function be defined separately from the operation itself so that fuzz-lightyear can trace inputs over time. When a failing test is discovered, code generation uses these inputs.

The `opts` argument will contain whatever options you define in the `operations` section of your `fuzzing.config.js`.

As an example, here's what a simple kv-store `operations` function might return, if you're only testing `put` operations:
```js
async function operations (reference, actual, rng, opts = {}) {
  return {
    put: {
      inputs: () => {
        // Generate a random key/value pair using the random number generator.
        return [keyFromRng(rng), valueFromRng(rng)]
      },
      operation: async (key, value) {
        reference.put(key, value)
        await actual.put(key, value)
      }
    }
  }
}
```

#### `async validation (reference, actual, rng, opts = {})`
After a series of random operations (defined above) are performed on the reference/actual objects, fuzz-lightyear will run a set of validation functions against both. If there's a mismatch, the validators are expected to throw errors. 

The validation process is split into tests and validators: tests are intended to be simple comparisons between the two objects, while the validators are more complicated flows that call test functions one or more times.

We define the tests separately in order to simplify code generation (the test functions will be imported by the generated test cases).

`validation` must return an object that specifies both tests and validators as `tests` and `validators` objects:
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
async function validation (reference, actual, rng, opts = {}) {
  return {
    tests: {
      async sameValues (path) {
        const referenceVal = reference.get(path)
        const actualVal = await actual.get(path)
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
}
```

The `opts` argument will contain whatever options you define in the `validation` section of your `fuzzing.config.js`.

#### Exports
Once you've defined your setup, operations, and validation functions. Your fuzz module must export these:
```js
module.exports = { operations, validation, setup }
```
Now you have a complete fuzzer module that you can test against using the CLI commands below.

### Working with Generated Tests

### Configuration
fuzz-lightyear expects your target module to contain a `fuzzing.config.js` file, which can contain the following options:

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
Remove any untracked 

### License
MIT

### Sponsors
This project was kindly sponsored by NearForm.
