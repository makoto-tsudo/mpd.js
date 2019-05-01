'use strict'

const net = require('net')
const os = require('os')
const EventEmitter = require('events').EventEmitter
const assert = require('assert')
const debug = require('debug')(require('../package.json').name)

const { isError, MPDError } = require('./error')
const {
  isString,
  isNonEmptyString,
  escapeArg,
  parseList,
  parseNestedList,
  parseObject,
  normalizeKeys,
  autoparseValues
} = require('./parsers')

const { Command } = require('./command')

const MPD_SENTINEL = /^(OK|ACK|list_OK)(.*)$/m
const OK_MPD = /^OK MPD /

const defaultConfig = {
  host: 'localhost',
  port: 6600
}

class MPDClient extends EventEmitter {
  constructor (config) {
    super()
    this._config = config
    this._promiseQueue = []
    this._buf = ''
    this._idleevts = {}

    // bind to this client
    this.disconnect = this.disconnect.bind(this)
    this._receive = this._receive.bind(this)
    this._handleIdling = this._handleIdling.bind(this)
    this._triggerIdleEvents = this._triggerIdleEvents.bind(this)
  }

  static connect (config) {
    if (!config || typeof config !== 'object') {
      config = defaultConfig
    }

    // allow tilde shortcuts if connecting to a socket
    if (isString(config.path) && config.path.startsWith('~')) {
      config.path = config.path.replace(/^~/, os.homedir())
    }

    return finalizeClientConnection(
      new MPDClient(config), net.connect(config))
  }

  async sendCommand (command) {
    assert.ok(this.idling)
    const promise = this._enqueuePromise()
    this.stopIdling()
    this.send(command)
    this.setupIdling()
    return promise
  }

  async sendCommands (commandList) {
    const cmd = 'command_list_begin\n' +
      commandList.join('\n') +
      '\ncommand_list_end'
    return this.sendCommand(cmd)
  }

  stopIdling () {
    if (!this.idling) {
      return
    }
    this.idling = false
    this.send('noidle')
  }

  setupIdling () {
    if (this.idling) {
      debug('already idling')
      return
    }
    this.idling = true
    this._enqueuePromise().then(this._handleIdling)
    this.send('idle')
  }

  send (data) {
    if (!this.socket.writable) {
      throw new MPDError('Not connected', 'ENOTCONNECTED')
    }
    debug('sending %s', data)
    this.socket.write(data + '\n')
  }

  disconnect () {
    return new Promise((resolve) => {
      if (this.socket && this.socket.destroyed) {
        return resolve()
      }

      let _resolve = () => {
        if (resolve) {
          resolve()
          resolve = null
        }
      }

      this.socket.once('close', _resolve)
      this.socket.once('end', _resolve)

      this.socket.end()
      setTimeout(() => this.socket.destroy(), 16)
    })
  }

  _enqueuePromise () {
    return new Promise((resolve, reject) =>
      this._promiseQueue.push({ resolve, reject }))
  }

  _resolve (msg) { this._promiseQueue.shift().resolve(msg) }
  _reject (err) { this._promiseQueue.shift().reject(err) }

  _receive (data) {
    let matched
    this._buf += data
    while ((matched = this._buf.match(MPD_SENTINEL)) !== null) {
      let msg = this._buf.substring(0, matched.index)
      let line = matched[0]
      let code = matched[1]
      let desc = matched[2]

      code !== 'ACK'
        ? this._resolve(msg)
        : this._reject(new MPDError(desc))

      this._buf = this._buf.substring(msg.length + line.length + 1)
    }
  }

  _handleIdling (msg) {
    // store events and trigger with delay,
    // either a problem with MPD (not likely)
    // or this implementation; same events are
    // triggered multiple times (especially mixer)
    if (isNonEmptyString(msg)) {
      let msgs = msg.split('\n').filter(s => s.length > 9)
      for (let msg of msgs) {
        let name = msg.substring(9)
        this._idleevts[name] = true
      }
    }
    if (this._promiseQueue.length === 0) {
      this.idling = false
      this.setupIdling()
    }
    clearTimeout(this._idleevtsTID)
    this._idleevtsTID = setTimeout(this._triggerIdleEvents, 16)
  }

  _triggerIdleEvents () {
    for (let name in this._idleevts) {
      debug('triggering %s', name)
      this.emit(`system-${name}`)
      this.emit('system', name)
    }
    this._idleevts = {}
  }
}

/**
 * check that we're connected to MPD
 * and check for password requirements
 */
const finalizeClientConnection = (client, socket) =>
  new Promise((resolve, reject) => {
    socket.setEncoding('utf8')
    socket.on('error', reject)

    let protoVersion
    let idleCheckTimeout
    let password = isNonEmptyString(client._config.password)
      ? client._config.password
      : false

    const finalize = () => {
      debug('preparing client')

      Object.defineProperty(
        client,
        'PROTOCOL_VERSION',
        { get: () => socket.destroyed ? undefined : protoVersion }
      )

      if (password) {
        delete client._config.password
      }

      socket.removeListener('data', onData)
      socket.on('data', client._receive)
      socket.on('close', () => {
        debug('close')
        client.emit('close')
      })

      client.socket = socket

      client.setupIdling()
      resolve(client)
    }

    const onData = data => {
      // expected MPD proto response
      if (!MPD_SENTINEL.test(data)) {
        debug('invalid server response %s', data)
        reject(new MPDError('Unexpected MPD service response',
          'INVALIDMPDSERVICE', `got: '${data}'`))
        return
      }

      // initial response with proto version
      if (OK_MPD.test(data) && !protoVersion) {
        protoVersion = data.split(OK_MPD)[1]
        debug('connected to MPD server, proto version: %s', protoVersion)
        // check for presence of the password
        if (password) {
          debug('sending password')
          socket.write(`password ${escapeArg(password)}\n`)
          return
        }
      }

      // check if there was an error (password / idle)
      const error = isError(data)
      if (error) {
        reject(error)
        socket.destroy()
        return
      }

      // do we need to test with the idle?
      if (!idleCheckTimeout) {
        debug('idle check')
        // set idle to test for the error for
        // in case MPD requires a password but
        // has not been set
        socket.write('idle\n')
        // idle does not respond, so if there
        // was no error, disable idle to get
        // the response
        idleCheckTimeout = setTimeout(() => {
          socket.write('noidle\n')
        }, 100)

        return
      }

      finalize()
    }

    socket.on('data', onData)
  })

MPDClient.MPDError = MPDError
MPDClient.Command = Command

MPDClient.cmd = Command.cmd
MPDClient.parseList = parseList
MPDClient.parseNestedList = parseNestedList
MPDClient.parseObject = parseObject
MPDClient.normalizeKeys = normalizeKeys
MPDClient.autoparseValues = autoparseValues

module.exports = MPDClient