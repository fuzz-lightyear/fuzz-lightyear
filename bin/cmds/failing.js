const fs = require('fs')
const p = require('path')
const crypto = require('crypto')
const mkdirp = require('mkdirp')
const chalk = require('chalk')
const progress = require('cli-progress')
const { create } = require('../..')
const consts = require('../../consts')

exports.command = 'failing'
exports.desc = 'Run all failing test cases'
exports.builder = {
  module: {
    default: p.join(process.cwd(), 'fuzzing.js'),
    alias: 'm',
    description: 'Path to the module to fuzz',
    type: 'string'
  }
}
exports.handler = async function (argv) {
  const failingTestRoot = p.join(p.dirname(argv.module), 'test', 'autogenerated','failing')
  const failingTests = await new Promise((resolve, reject) => {
    fs.readdir(failingTestRoot, (err, files) => {
      if (err) return reject(err)
      return resolve(files.filter(f => f.endsWith('.js')))
    })
  })

  for (const test of failingTests) {
    require(p.join(failingTestRoot, test))
  }
}

