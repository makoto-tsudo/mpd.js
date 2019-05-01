'use strict'

let NORMALIZE_KEYS = true
let AUTOPARSE_VALUES = true

const { MPDError } = require('./error')

exports.isString = val => typeof val === 'string'
exports.isNumber = val => typeof val === 'number'

exports.isNonEmptyString = val =>
  exports.isString(val) && !!val.trim().length

exports.escapeArg = arg => {
  const escaped = (arg + '').replace(/"/g, '\\"')
  return `"${escaped}"`
}

exports.normalizeKeys = val => {
  if (typeof val === 'boolean') {
    NORMALIZE_KEYS = val
  }
  return NORMALIZE_KEYS
}

exports.autoparseValues = val => {
  if (typeof val === 'boolean') {
    AUTOPARSE_VALUES = val
  }
  return AUTOPARSE_VALUES
}

exports.parseList = (msg, delimiters) => msg
  .split('\n')
  .reduce((memo, line) => {
    if (line.length === 0) {
      return memo
    }

    let keyValue = line.match(/([^ ]+): (.*)/)
    if (keyValue == null) {
      throw new MPDError('Could not parse entry', 'EPARSE', line)
    }

    // eslint-disable-next-line no-unused-vars
    let [_, key, val] = keyValue

    if (NORMALIZE_KEYS) {
      key = normalizeKey(key)
    }

    if (AUTOPARSE_VALUES) {
      val = autoParse(NORMALIZE_KEYS ? key : normalizeKey(key), val)
    }

    // is new entry?
    let isNew = !memo.current
      ? true
      : memo.delims !== null
        ? memo.delims[key]
        : memo.current[key] !== undefined

    if (isNew) {
      memo.current = {}
      memo.list.push(memo.current)
    }

    // if current already has this key,
    // then make it a list of values
    if (memo.current[key] === undefined) {
      memo.current[key] = val
    } else {
      if (!(memo.current[key] instanceof Array)) {
        memo.current[key] = [memo.current[key]]
      }
      memo.current[key].push(val)
    }

    return memo
  }, {
    delims: delimiters2object(delimiters),
    current: null,
    list: []
  })
  .list

exports.parseList.by = (...delimiters) => {
  if (delimiters instanceof Array && delimiters.length === 1) {
    delimiters = delimiters[0]
  }
  delimiters = delimiters2object(delimiters)
  return msg => exports.parseList(msg, delimiters)
}

/**
 * Parse the list, first item key indicates
 * the unique key identifier, any subtiems
 * will be nested within that object:
 * artist: foo
 * album: foo
 * title: bar
 * title: fox
 * title: jumps
 * album: crazy
 * title: mind
 * artist: cactus
 * ablum: cactusalbum
 * title: bull
 * =>
 * [ { artist: 'foo',
 *     album:
 *      [ { album: 'foo',
 *          title:
 *           [ { title: 'bar' },
 *             { title: 'fox' },
 *             { title: 'jumps' },
 *             { title: 'mind' } ] },
 *        { album: 'crazy' } ] },
 *   { artist: 'cactus',
 *     ablum: [ { ablum: 'cactusalbum', title: [ { title: 'bull' } ] } ] } ]
 */
exports.parseNestedList = msg => msg
  .split('\n')
  .reduce((memo, line) => {

    if (line.length === 0) {
      return memo
    }

    let target
    const [key, val] = mpdLine2keyVal(line)
    const obj = {[key]: val}

    if (!memo.delimiter) {
      memo.delimiter = key
    }

    // is this new entry of default type
    if (memo.delimiter === key) {
      memo.objpath = [obj]
      memo.keypath = [key]
      target = memo.list
    } else {

      const kpos = memo.keypath.indexOf(key)

      // first entry of this sub type into the
      // current item
      if (kpos === -1) {
        target = []
        memo.objpath[memo.objpath.length - 1][key] = target
        memo.objpath.push(obj)
        memo.keypath.push(key)
      } else {
        target = memo.objpath[kpos - 1][key]
      }
    }

    target.push(obj)

    return memo
  }, {
    objpath: [],
    keypath: [],
    list: []
  })
  .list


exports.parseObject = msg => exports.parseList(msg)[0]

const delimiters2object = delimiters => {
  if (typeof delimiters === 'string') {
    return { [delimiters]: true }
  }
  if (delimiters instanceof Array) {
    return delimiters.reduce((delims, key) => ({ ...delims, [key]: true }), {})
  }
  if (typeof delimiters === 'object' && delimiters != null) {
    return delimiters
  }
  return null
}

const mpdLine2keyVal = line => {

  let keyValue = line.match(/([^ ]+): (.*)/)

  if (keyValue == null) {
    throw new MPDError('Could not parse entry', 'EPARSE', line)
  }

  // eslint-disable-next-line no-unused-vars
  let [_, key, val] = keyValue

  if (NORMALIZE_KEYS) {
    key = normalizeKey(key)
  }

  if (AUTOPARSE_VALUES) {
    val = autoParse(NORMALIZE_KEYS ? key : normalizeKey(key), val)
  }

  return [key, val]
}

const normalizeKey = key => key
  .toLowerCase()
  .replace(/[^a-z_]/g, '_')

const autoParse = (key, val) => {
  return VAL_PARSERS[key]
    ? VAL_PARSERS[key](val)
    : val
}

const parsers = {
  parseInt: num => {
    let val = parseInt(num)
    if (isNaN(val)) return 0
    return val
  },

  tryParseInt: num => {
    let val = parseInt(num)
    // eslint-disable-next-line eqeqeq
    return val == num
      ? val
      : num
  },

  parseFloat: num => {
    let val = parseFloat(num)
    if (isNaN(val)) return 0
    return val
  },

  parseBool: val => {
    if (val === true || val === false) { return val }

    if (val === 1) return true
    if (val === 0) return false

    if (typeof val === 'string') {
      val = val.toLowerCase().trim()
      if (val === 'true') return true
      if (val === '1') return true
      if (val === 'on') return true
      return false
    }
  },

  parseSingleFlag: val => {
    if (`${val}`.toLowerCase() === 'oneshot') {
      return 'oneshot'
    }
    return parsers.parseBool(val)
  },

  parseTime: val => {
    if (val.indexOf(':') === -1) {
      return parsers.parseInt(val)
    }
    const [elapsed, total] = val.split(':').map(parsers.parseInt)
    return { elapsed, total }
  },

  parseAudio: val => {
    const [sampleRate, bits, channels] = val
      .split(':').map(parsers.tryParseInt)
    const result = { sampleRate, bits, channels }
    if (exports.isNumber(sampleRate)) {
      const srs = parsers.toShortUnit(sampleRate)
      srs.unit += 'Hz'
      result.sample_rate_short = srs
    }

    return result
  },

  /**
   * Shorten the number using a unit (eg. 1000 = 1k)
   * @param {Number} num number to shorten
   * @param {Number} [digits=`${num}`.length] will be used with toFixed
   * @returns {module:parser~ShortUnitResult}
   */
  toShortUnit: (num, digits) => {
    if (!exports.isNumber(digits)) {
      digits = `${num}`.length
    }

    let si = [
      { value: 1, symbol: '' },
      { value: 1E3, symbol: 'k' },
      { value: 1E6, symbol: 'M' },
      { value: 1E9, symbol: 'G' },
      { value: 1E12, symbol: 'T' },
      { value: 1E15, symbol: 'P' },
      { value: 1E18, symbol: 'E' }
    ]
    var rx = /\.0+$|(\.[0-9]*[1-9])0+$/
    let ii
    for (ii = si.length - 1; ii > 0; ii--) {
      if (num >= si[ii].value) {
        break
      }
    }
    return {
      value: parsers
        .parseFloat((num / si[ii].value)
          .toFixed(digits)
          .replace(rx, '$1')),
      unit: si[ii].symbol
    }
  }

}

const VAL_PARSERS = {
  //
  // song
  //
  duration: parsers.parseFloat,
  time: parsers.parseTime,
  range: parsers.parseRange,
  track: parsers.parseFloat,
  disc: parsers.parseInt,
  originaldate: parsers.parseInt,

  //
  // playlist related meta data
  //
  prio: parsers.parseInt,
  id: parsers.parseInt,
  pos: parsers.parseInt,

  //
  // status
  //
  volume: parsers.parseInt,
  songid: parsers.parseInt,
  nextsongid: parsers.parseInt,
  playlistlength: parsers.parseInt,
  playlist: parsers.tryParseInt,
  song: parsers.parseInt,
  nextsong: parsers.parseInt,
  bitrate: parsers.parseBitrateKBPS,
  updating_db: parsers.parseInt,

  elapsed: parsers.parseFloat,
  mixrampdb: parsers.parseFloat,
  mixrampdelay: parsers.parseFloat,
  xfade: parsers.parseFloat,

  repeat: parsers.parseBool,
  random: parsers.parseBool,
  consume: parsers.parseBool,

  single: parsers.parseSingleFlag,
  audio: parsers.parseAudio,

  //
  // stats
  //
  artists: parsers.parseInt,
  albums: parsers.parseInt,
  songs: parsers.parseInt,
  uptime: parsers.parseInt,
  db_playtime: parsers.parseInt,
  db_update: parsers.parseInt,
  playtime: parsers.parseInt

}