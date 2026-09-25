import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { createClient } from '@libsql/client'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const contentDir = path.join(__dirname, 'content')
const dataDir = path.join(__dirname, 'data')

if (!process.env.TURSO_DATABASE_URL) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const defaultUrl = `file:${path.join(dataDir, 'prepbase.sqlite')}`

export const db = createClient({
  url: process.env.TURSO_DATABASE_URL || defaultUrl,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

export async function dbGet(sql, args = []) {
  const result = await db.execute({ sql, args })
  return result.rows[0] ?? null
}

export async function dbAll(sql, args = []) {
  const result = await db.execute({ sql, args })
  return result.rows
}

export async function dbRun(sql, args = []) {
  const result = await db.execute({ sql, args })
  return {
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    changes: Number(result.rowsAffected ?? 0),
  }
}

export async function dbExec(sql) {
  await db.execute(sql)
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY,
    years_experience REAL NOT NULL DEFAULT 1,
    primary_language TEXT NOT NULL DEFAULT 'Go',
    target_role TEXT NOT NULL DEFAULT 'Google SWE',
    target_level TEXT NOT NULL DEFAULT 'L4',
    start_date TEXT NOT NULL,
    weekly_weekday_minutes INTEGER NOT NULL DEFAULT 120,
    weekly_weekend_minutes INTEGER NOT NULL DEFAULT 240,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER PRIMARY KEY,
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS content_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS content_items (
    id TEXT PRIMARY KEY,
    skill TEXT NOT NULL,
    kind TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS content_assessments (
    id TEXT PRIMARY KEY,
    sort INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS content_docs (
    key TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  )`,
]

let initPromise

export function ensureDb(seedFn) {
  if (!initPromise) {
    initPromise = (async () => {
      for (const sql of SCHEMA_STATEMENTS) {
        await dbExec(sql)
      }
      try {
        await dbGet('SELECT target_level FROM profiles LIMIT 1')
      } catch {
        await dbExec(`ALTER TABLE profiles ADD COLUMN target_level TEXT NOT NULL DEFAULT 'L4'`)
      }
      if (typeof seedFn === 'function') await seedFn()
    })()
  }
  return initPromise
}
