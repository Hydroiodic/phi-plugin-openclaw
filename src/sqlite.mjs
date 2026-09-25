// Redis-shaped storage backed by Node's built-in SQLite.
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export class SqliteStore {
  /** @type {Map<string, import('node:sqlite').StatementSync>} */
  #statements = new Map()
  #closed = false
  #transactionDepth = 0

  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    try {
      if (file !== ':memory:') fs.chmodSync(file, 0o600)
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS entries (key TEXT UNIQUE NOT NULL, value TEXT, expires REAL, kind TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS scores (key TEXT NOT NULL REFERENCES entries(key) ON DELETE CASCADE,
          member TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY(key, member));
        CREATE INDEX IF NOT EXISTS scores_order ON scores(key, score, member);
        CREATE INDEX IF NOT EXISTS entries_expiry ON entries(expires) WHERE expires IS NOT NULL;`)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /** @param {string} sql */
  #statement(sql) {
    if (this.#closed) throw new Error('SQLite store is closed')
    let statement = this.#statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement
  }
  /** @param {unknown} value */
  #text(value, label = 'key') {
    if (typeof value !== 'string') throw new TypeError(`Invalid ${label}: expected a string`)
    return value
  }
  /** @param {unknown} value @param {string} label */
  #integer(value, label, minimum = Number.MIN_SAFE_INTEGER) {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) throw new TypeError(`Invalid ${label}`)
    const result = Number(value)
    if (!Number.isSafeInteger(result) || result < minimum) throw new TypeError(`Invalid ${label}`)
    return result
  }
  /** @param {unknown} value @param {string} label */
  #number(value, label, finite = true) {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) throw new TypeError(`Invalid ${label}`)
    const result = Number(value)
    if (Number.isNaN(result) || (finite && !Number.isFinite(result))) throw new TypeError(`Invalid ${label}`)
    return result
  }
  /** @param {string} key @param {string} [kind] */
  #entry(key, kind) {
    this.#text(key)
    this.#statement('DELETE FROM entries WHERE key=? AND expires<=?').run(key, Date.now())
    const entry = this.#statement('SELECT value,expires,kind FROM entries WHERE key=?').get(key)
    if (entry && kind && entry.kind !== kind) throw new TypeError('WRONGTYPE')
    return entry
  }
  close() {
    if (this.#closed) return
    this.db.close()
    this.#closed = true
    this.#statements.clear()
  }
  clean() {
    this.#statement('DELETE FROM entries WHERE expires<=?').run(Date.now())
  }
  /** @template T @param {() => T} fn @returns {T} */
  transaction(fn) {
    if (this.#closed) throw new Error('SQLite store is closed')
    if (typeof fn !== 'function' || fn.constructor.name === 'AsyncFunction')
      throw new TypeError('SQLite transactions require a synchronous callback')
    const depth = this.#transactionDepth++,
      savepoint = `phi_transaction_${depth}`
    try {
      this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
      try {
        const value = fn()
        if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value && typeof value.then === 'function') {
          // Do not leave a returned, rejected Promise unobserved when rejecting
          // unsupported asynchronous transaction callbacks.
          Promise.resolve(value).catch(() => {})
          throw new TypeError('SQLite transactions require a synchronous callback')
        }
        this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT')
        return value
      } catch (error) {
        this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
        throw error
      }
    } finally {
      this.#transactionDepth--
    }
  }
  /** @param {string} key */
  async get(key) {
    const value = this.#entry(key, 'string')?.value
    return value == null ? null : String(value)
  }
  /** @param {string} key @param {unknown} value @param {{PX?:number, EX?:number}} options */
  async set(key, value, options = {}) {
    this.#text(key)
    if (!options || typeof options !== 'object' || Array.isArray(options) || (options.PX !== undefined && options.EX !== undefined))
      throw new TypeError('Invalid expiry options')
    const duration = options.PX !== undefined ? options.PX : options.EX === undefined ? undefined : options.EX * 1000
    const expires = duration === undefined ? null : Date.now() + duration
    if (duration !== undefined && (!Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(expires)))
      throw new TypeError('Invalid expiry')
    this.transaction(() => {
      this.#statement('DELETE FROM entries WHERE key=?').run(key)
      this.#statement("INSERT INTO entries(key,value,expires,kind) VALUES(?,?,?,'string')").run(key, String(value), expires)
    })
    return 'OK'
  }
  /** @param {...(string|string[])} keys */
  async del(...keys) {
    const names = keys.flat().map(key => this.#text(key))
    this.clean()
    return this.transaction(() =>
      names.reduce((n, key) => n + Number(this.#statement('DELETE FROM entries WHERE key=?').run(key).changes), 0),
    )
  }
  async keys(pattern = '*') {
    this.#text(pattern, 'pattern')
    this.clean()
    return this.#statement('SELECT key FROM entries WHERE key GLOB ? ORDER BY rowid')
      .all(pattern)
      .map(row => String(row.key))
  }
  async scan(cursor = 0, { MATCH = '*', COUNT = 100 } = {}) {
    const position = this.#integer(cursor, 'cursor', 0),
      limit = Math.min(10000, this.#integer(COUNT, 'count', 1))
    this.#text(MATCH, 'pattern')
    this.clean()
    // Stable rowid cursor: deleting a returned batch must not skip the next batch.
    const rows = this.#statement('SELECT rowid,key FROM entries WHERE rowid>? AND key GLOB ? ORDER BY rowid LIMIT ?').all(
      position,
      MATCH,
      limit + 1,
    )
    const batch = rows.slice(0, limit)
    return { cursor: rows.length > limit ? Number(batch.at(-1)?.rowid) : 0, keys: batch.map(row => String(row.key)) }
  }
  /** @param {string} key */
  async ttl(key) {
    const row = this.#entry(key)
    return !row ? -2 : row.expires === null ? -1 : Math.max(0, Math.ceil((Number(row.expires) - Date.now()) / 1000))
  }
  /** @param {string} key @param {{score:number, value:string}} item */
  async zAdd(key, { score, value }) {
    score = this.#number(score, 'score')
    this.#text(value, 'member')
    return this.transaction(() => {
      this.#entry(key, 'zset')
      this.#statement("INSERT OR IGNORE INTO entries(key,kind) VALUES(?,'zset')").run(key)
      const exists = this.#statement('SELECT 1 FROM scores WHERE key=? AND member=?').get(key, value)
      this.#statement('INSERT INTO scores VALUES(?,?,?) ON CONFLICT(key,member) DO UPDATE SET score=excluded.score').run(key, value, score)
      return exists ? 0 : 1
    })
  }
  /** @param {string} key @param {string} value */
  async zRem(key, value) {
    this.#text(value, 'member')
    return this.transaction(() => {
      this.#entry(key, 'zset')
      const changed = Number(this.#statement('DELETE FROM scores WHERE key=? AND member=?').run(key, value).changes)
      this.#statement("DELETE FROM entries WHERE key=? AND kind='zset' AND NOT EXISTS(SELECT 1 FROM scores WHERE key=?)").run(key, key)
      return changed
    })
  }
  /** @param {string} key @param {string} value */
  async zScore(key, value) {
    this.#text(value, 'member')
    this.#entry(key, 'zset')
    const score = this.#statement('SELECT score FROM scores WHERE key=? AND member=?').get(key, value)?.score
    return score == null ? null : Number(score)
  }
  /** @param {string} key */
  async zCard(key) {
    this.#entry(key, 'zset')
    return Number(this.#statement('SELECT COUNT(*) AS n FROM scores WHERE key=?').get(key)?.n)
  }
  /** @param {string} key @param {number} min @param {number} max */
  async zCount(key, min, max) {
    min = this.#number(min, 'minimum score', false)
    max = this.#number(max, 'maximum score', false)
    this.#entry(key, 'zset')
    return Number(this.#statement('SELECT COUNT(*) AS n FROM scores WHERE key=? AND score>=? AND score<=?').get(key, min, max)?.n)
  }
  /** @param {string} key @param {string} value */
  async zRank(key, value) {
    this.#text(value, 'member')
    this.#entry(key, 'zset')
    const entry = this.#statement('SELECT score FROM scores WHERE key=? AND member=?').get(key, value)
    if (!entry) return null
    return Number(
      this.#statement('SELECT COUNT(*) AS n FROM scores WHERE key=? AND (score<? OR (score=? AND member<?))').get(
        key,
        entry.score,
        entry.score,
        value,
      )?.n,
    )
  }
  /** @param {string} key @param {number} start @param {number} stop @param {string} [mode] */
  async zRange(key, start, stop, mode) {
    start = this.#integer(start, 'range start')
    stop = this.#integer(stop, 'range stop')
    if (mode !== undefined && mode !== 'WITHSCORES') throw new TypeError('Invalid range mode')
    this.#entry(key, 'zset')
    const size = Number(this.#statement('SELECT COUNT(*) AS n FROM scores WHERE key=?').get(key)?.n)
    start = start < 0 ? Math.max(0, size + start) : start
    stop = stop < 0 ? size + stop : Math.min(stop, size - 1)
    if (stop < start || start >= size) return []
    const rows = this.#statement('SELECT member,score FROM scores WHERE key=? ORDER BY score,member LIMIT ? OFFSET ?').all(
      key,
      stop - start + 1,
      start,
    )
    return mode === 'WITHSCORES' ? rows.flatMap(row => [String(row.member), String(row.score)]) : rows.map(row => String(row.member))
  }
}
