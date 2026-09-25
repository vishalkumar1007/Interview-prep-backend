import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import express from 'express'
import cors from 'cors'
import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import cookieParser from 'cookie-parser'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const contentDir = path.join(__dirname, 'content')
const dataDir = path.join(__dirname, 'data')
fs.mkdirSync(dataDir, { recursive: true })

const db = new DatabaseSync(path.join(dataDir, 'prepbase.sqlite'))
const app = express()
const port = Number(process.env.PORT || 3000)
const jwtSecret = process.env.JWT_SECRET || 'change-this-before-production'
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173'

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(contentDir, name), 'utf8'))
}

const dsaPatterns = loadJson('dsa-patterns.json')
const dsaProblems = loadJson('dsa-problems.json')
const curriculum = loadJson('curriculum.json')
const weekPlan = loadJson('week-plan.json')
const googleProcess = loadJson('google-process.json')
const googleyness = loadJson('googleyness.json')
const goBank = loadJson('go-bank.json')
const fundamentalsBank = loadJson('fundamentals-bank.json')
const networkingBank = loadJson('networking-bank.json')
const systemDesignBank = loadJson('system-design-bank.json')
const communicationBank = loadJson('communication-bank.json')
const assessmentsDoc = loadJson('assessments.json')
const syllabus = loadJson('syllabus.json')

const TOTAL_WEEKS = weekPlan.weeks.length || 26

const bankCatalog = {
  dsa: { skill: 'DSA', patterns: dsaPatterns, items: dsaProblems },
  go: { skill: 'Go', items: goBank.items || goBank },
  fundamentals: { skill: 'Fundamentals', items: fundamentalsBank.items || fundamentalsBank },
  networking: { skill: 'Networking', items: networkingBank.items || networkingBank },
  'system-design': { skill: 'System design', items: systemDesignBank.items || systemDesignBank },
  communication: { skill: 'Communication', items: communicationBank.items || communicationBank },
}

db.exec('PRAGMA journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS profiles (
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
  );
  CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER PRIMARY KEY,
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS content_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS content_items (
    id TEXT PRIMARY KEY,
    skill TEXT NOT NULL,
    kind TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS content_assessments (
    id TEXT PRIMARY KEY,
    sort INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS content_docs (
    key TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  );
`)

function seedContent() {
  const version = 'skill-banks-v4-capacity-links-2'
  const current = db.prepare('SELECT value FROM content_meta WHERE key = ?').get('seed_version')
  if (current?.value === version) return

  db.exec('DELETE FROM content_items; DELETE FROM content_assessments; DELETE FROM content_docs;')
  const insertItem = db.prepare('INSERT INTO content_items (id, skill, kind, sort, payload) VALUES (?, ?, ?, ?, ?)')
  const insertAssess = db.prepare('INSERT INTO content_assessments (id, sort, payload) VALUES (?, ?, ?)')
  const insertDoc = db.prepare('INSERT INTO content_docs (key, payload) VALUES (?, ?)')

  const insertMany = () => {
    dsaProblems.forEach((p, i) => insertItem.run(p.id, 'DSA', 'problem', i, JSON.stringify(p)))
    dsaPatterns.forEach((p, i) => insertItem.run(`pattern:${p.id}`, 'DSA', 'pattern', i, JSON.stringify(p)))
    ;(goBank.items || []).forEach((p, i) => insertItem.run(p.id, 'Go', 'topic', i, JSON.stringify(p)))
    ;(fundamentalsBank.items || []).forEach((p, i) => insertItem.run(p.id, 'Fundamentals', 'topic', i, JSON.stringify(p)))
    ;(networkingBank.items || []).forEach((p, i) => insertItem.run(p.id, 'Networking', 'topic', i, JSON.stringify(p)))
    ;(systemDesignBank.items || []).forEach((p, i) => insertItem.run(p.id, 'System design', 'topic', i, JSON.stringify(p)))
    ;(communicationBank.items || []).forEach((p, i) => insertItem.run(p.id, 'Communication', 'topic', i, JSON.stringify(p)))
    ;(assessmentsDoc.items || []).forEach((a, i) => insertAssess.run(a.id, i, JSON.stringify(a)))
    insertDoc.run('syllabus', JSON.stringify(syllabus))
    insertDoc.run('assessments-platforms', JSON.stringify(assessmentsDoc.platforms || []))
    insertDoc.run('curriculum', JSON.stringify(curriculum))
    insertDoc.run('google-process', JSON.stringify(googleProcess))
    insertDoc.run('googleyness', JSON.stringify(googleyness))
    insertDoc.run('week-plan', JSON.stringify(weekPlan))
    db.prepare(`
      INSERT INTO content_meta (key, value, updated_at) VALUES ('seed_version', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
    `).run(version)
  }
  db.exec('BEGIN')
  try {
    insertMany()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  console.log(`Seeded content ${version}: ${dsaProblems.length} DSA + skill banks`)
}

seedContent()

try {
  db.prepare('SELECT target_level FROM profiles LIMIT 1').get()
} catch {
  db.exec(`ALTER TABLE profiles ADD COLUMN target_level TEXT NOT NULL DEFAULT 'L4'`)
}

app.use(cors({ origin: frontendOrigin, credentials: true }))
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email }
}

function signSession(user) {
  return jwt.sign({ sub: user.id }, jwtSecret, { expiresIn: '7d' })
}

function setSession(res, user) {
  res.cookie('prepbase_session', signSession(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  })
}

function requireUser(req, res, next) {
  try {
    const token = req.cookies.prepbase_session
    if (!token) throw new Error('No session')
    req.userId = Number(jwt.verify(token, jwtSecret).sub)
    next()
  } catch {
    res.status(401).json({ error: 'Please sign in to continue.' })
  }
}

function getAccount(userId) {
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId)
  if (!user) return null
  const profile = db.prepare(`
    SELECT years_experience, primary_language, target_role, target_level, start_date,
           weekly_weekday_minutes, weekly_weekend_minutes
    FROM profiles WHERE user_id = ?
  `).get(userId)
  return { user: publicUser(user), profile }
}

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

/** Sunday on or before the given date (local). Plan weeks are Sun–Sat. */
function sundayOnOrBefore(iso) {
  const d = parseDate(iso)
  return formatDate(addDays(d, -d.getDay()))
}

function daysBetween(a, b) {
  const ms = parseDate(b).getTime() - parseDate(a).getTime()
  return Math.floor(ms / (24 * 60 * 60 * 1000))
}

function weekIndexFromStart(startDate, onDate = formatDate(new Date())) {
  const planOrigin = sundayOnOrBefore(startDate)
  const days = Math.max(0, daysBetween(planOrigin, onDate))
  return Math.min(TOTAL_WEEKS - 1, Math.floor(days / 7))
}

/** Week N starts on Sunday. dayOffset 0=Sun … 5=Fri (study), 6=Sat (tests/mocks only). */
function weekStartDate(startDate, weekIndex) {
  return formatDate(addDays(parseDate(sundayOnOrBefore(startDate)), weekIndex * 7))
}

function expandWeekTasks(startDate, weekIndex, progress) {
  const week = weekPlan.weeks.find(w => w.week === weekIndex + 1) || weekPlan.weeks[0]
  const weekStart = weekStartDate(startDate, weekIndex)
  return (week.dailyTasks || []).map(task => {
    let dayOffset = Number(task.dayOffset) || 0
    let kind = task.kind
    // Enforce calendar rules even if content drifts
    if (kind === 'test' || kind === 'mock' || kind === 'assessment') {
      dayOffset = 6
    } else if (dayOffset >= 6) {
      dayOffset = 5
    }
    const date = formatDate(addDays(parseDate(weekStart), dayOffset))
    const id = `w${week.week}-d${dayOffset}-${task.idSuffix}`
    const status = progress?.tasks?.[id] || 'not_started'
    return {
      id,
      week: week.week,
      dayOffset,
      date,
      title: task.title,
      detail: task.detail,
      skill: task.skill,
      minutes: task.minutes,
      kind,
      problemIds: task.problemIds || [],
      bankItemIds: task.bankItemIds || [],
      assessmentId: task.assessmentId || null,
      status,
    }
  }).filter(t => t.date >= startDate)
}

function buildPlan(profile, progress) {
  const startDate = profile.start_date
  const today = formatDate(new Date())
  const weekIndex = weekIndexFromStart(startDate, today)
  const week = weekPlan.weeks.find(w => w.week === weekIndex + 1)
  const tasks = expandWeekTasks(startDate, weekIndex, progress)
  const todayTasks = tasks.filter(t => t.date === today)
  const backlog = []
  for (let w = 0; w <= weekIndex; w++) {
    const older = expandWeekTasks(startDate, w, progress)
    for (const t of older) {
      if (t.date < today && t.status !== 'done' && t.status !== 'skipped') backlog.push(t)
    }
  }
  const ahead = []
  const upcoming = []
  const aheadDone = []
  for (let w = 0; w < TOTAL_WEEKS; w++) {
    const future = expandWeekTasks(startDate, w, progress)
    for (const t of future) {
      if (t.date > today) {
        if (t.status === 'done') aheadDone.push(t)
        else {
          upcoming.push(t)
          if (ahead.length < 12 && w >= weekIndex && w < weekIndex + 4) ahead.push(t)
        }
      }
    }
  }
  const todayAssessments = todayTasks.filter(t => t.kind === 'test' || t.kind === 'mock' || t.kind === 'assessment')
  const endDate = formatDate(addDays(parseDate(sundayOnOrBefore(startDate)), TOTAL_WEEKS * 7 - 1))
  return {
    startDate,
    endDate,
    today,
    weekIndex: weekIndex + 1,
    totalWeeks: TOTAL_WEEKS,
    phase: week?.phase || '',
    theme: week?.theme || '',
    focus: week?.focus || '',
    weekStart: weekStartDate(startDate, weekIndex),
    weekDays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    studyDays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    assessmentDay: 'Sat',
    weekdayMinutes: profile.weekly_weekday_minutes,
    weekendMinutes: profile.weekly_weekend_minutes,
    todayTasks,
    todayAssessments,
    weekTasks: tasks,
    backlog,
    ahead,
    aheadDone: aheadDone.slice(0, 40),
    upcoming: upcoming.slice(0, 50),
    allowAhead: true,
    aiRule: syllabus.aiRule,
    roadmap: weekPlan.weeks.map(w => ({
      week: w.week,
      phase: w.phase,
      theme: w.theme,
      focus: w.focus,
    })),
  }
}

function buildScheduleIndex(startDate) {
  const byProblem = {}
  const byBankItem = {}
  for (let w = 0; w < TOTAL_WEEKS; w++) {
    const tasks = expandWeekTasks(startDate, w, { tasks: {} })
    for (const t of tasks) {
      const entry = {
        week: t.week,
        date: t.date,
        dayOffset: t.dayOffset,
        taskId: t.id,
        title: t.title,
        skill: t.skill,
      }
      for (const pid of t.problemIds || []) {
        if (!byProblem[pid]) byProblem[pid] = []
        byProblem[pid].push(entry)
      }
      for (const bid of t.bankItemIds || []) {
        if (!byBankItem[bid]) byBankItem[bid] = []
        byBankItem[bid].push(entry)
      }
    }
  }
  return { startDate, byProblem, byBankItem, totalWeeks: TOTAL_WEEKS }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.post('/api/auth/signup', async (req, res) => {
  const {
    name,
    email,
    password,
    yearsExperience = 1,
    primaryLanguage = 'Go',
    targetRole = 'Google SWE',
    targetLevel = 'L4',
    startDate = formatDate(new Date()),
    weekdayMinutes = 120,
    weekendMinutes = 240,
  } = req.body ?? {}

  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email ?? '') || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Use a name, valid email, and password of at least 8 characters.' })
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12)
    const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(
      name.trim(),
      email.trim().toLowerCase(),
      passwordHash,
    )
    const userId = Number(result.lastInsertRowid)
    db.prepare(`
      INSERT INTO profiles (user_id, years_experience, primary_language, target_role, target_level, start_date, weekly_weekday_minutes, weekly_weekend_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      Number(yearsExperience) || 1,
      primaryLanguage,
      targetRole,
      targetLevel,
      startDate,
      Number(weekdayMinutes) || 120,
      Number(weekendMinutes) || 240,
    )
    db.prepare('INSERT INTO progress (user_id, payload) VALUES (?, ?)').run(
      userId,
      JSON.stringify({
        tasks: {},
        problems: {},
        modules: {},
        bankItems: {},
        assessments: {},
        notes: {},
        weekStart: startDate,
        updatedAt: new Date().toISOString(),
      }),
    )
    const account = getAccount(userId)
    setSession(res, account.user)
    res.status(201).json(account)
  } catch (error) {
    const code = error?.code || ''
    const unique = String(code).includes('CONSTRAINT') || String(error?.message || '').includes('UNIQUE')
    res.status(unique ? 409 : 500).json({
      error: unique
        ? 'An account already exists for that email.'
        : 'Could not create the account.',
    })
  }
})

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {}
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase())
  if (!user || !(await bcrypt.compare(password ?? '', user.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' })
  }
  const account = getAccount(user.id)
  setSession(res, account.user)
  res.json(account)
})

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('prepbase_session', { path: '/' })
  res.status(204).end()
})

app.get('/api/auth/me', requireUser, (req, res) => {
  const account = getAccount(req.userId)
  if (!account) return res.status(401).json({ error: 'Account not found.' })
  res.json(account)
})

app.put('/api/profile', requireUser, (req, res) => {
  const {
    name,
    yearsExperience,
    primaryLanguage,
    targetRole,
    targetLevel,
    startDate,
    weekdayMinutes,
    weekendMinutes,
  } = req.body ?? {}
  if (!name?.trim() || !startDate) {
    return res.status(400).json({ error: 'Name and start date are required.' })
  }
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), req.userId)
  db.prepare(`
    UPDATE profiles SET
      years_experience=?, primary_language=?, target_role=?, target_level=?, start_date=?,
      weekly_weekday_minutes=?, weekly_weekend_minutes=?, updated_at=CURRENT_TIMESTAMP
    WHERE user_id=?
  `).run(
    Number(yearsExperience) || 1,
    primaryLanguage || 'Go',
    targetRole || 'Google SWE',
    targetLevel || 'L4',
    startDate,
    Number(weekdayMinutes) || 120,
    Number(weekendMinutes) || 240,
    req.userId,
  )
  res.json(getAccount(req.userId))
})

app.get('/api/progress', requireUser, (req, res) => {
  const row = db.prepare('SELECT payload, updated_at FROM progress WHERE user_id = ?').get(req.userId)
  const payload = row ? JSON.parse(row.payload) : { tasks: {}, problems: {}, modules: {}, bankItems: {}, assessments: {}, notes: {} }
  res.json({ ...payload, updatedAt: row?.updated_at })
})

app.put('/api/progress', requireUser, (req, res) => {
  const payload = req.body
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid progress payload.' })
  }
  const next = {
    tasks: payload.tasks || {},
    problems: payload.problems || {},
    modules: payload.modules || {},
    bankItems: payload.bankItems || {},
    assessments: payload.assessments || {},
    notes: payload.notes || {},
    weekStart: payload.weekStart,
    updatedAt: new Date().toISOString(),
  }
  db.prepare(`
    INSERT INTO progress (user_id, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload, updated_at=CURRENT_TIMESTAMP
  `).run(req.userId, JSON.stringify(next))
  res.json({ ok: true, ...next })
})

app.get('/api/curriculum', (_req, res) => {
  const row = db.prepare('SELECT payload FROM content_docs WHERE key = ?').get('curriculum')
  res.json(row ? JSON.parse(row.payload) : curriculum)
})

app.get('/api/dsa', (_req, res) => {
  const patterns = db.prepare("SELECT payload FROM content_items WHERE skill = 'DSA' AND kind = 'pattern' ORDER BY sort").all()
    .map(r => JSON.parse(r.payload))
  const problems = db.prepare("SELECT payload FROM content_items WHERE skill = 'DSA' AND kind = 'problem' ORDER BY sort").all()
    .map(r => JSON.parse(r.payload))
  res.json({
    patterns: patterns.length ? patterns : dsaPatterns,
    problems: problems.length ? problems : dsaProblems,
  })
})

app.get('/api/banks', (_req, res) => {
  res.json({
    skills: Object.entries(bankCatalog).map(([key, val]) => ({
      key,
      skill: val.skill,
      count: Array.isArray(val.items) ? val.items.length : 0,
    })),
  })
})

app.get('/api/banks/:skill', (req, res) => {
  const key = req.params.skill
  const bank = bankCatalog[key]
  if (!bank) return res.status(404).json({ error: 'Unknown skill bank.' })
  if (key === 'dsa') {
    return res.json({ skill: bank.skill, key, patterns: bank.patterns, items: bank.items })
  }
  const rows = db.prepare('SELECT payload FROM content_items WHERE skill = ? AND kind = ? ORDER BY sort').all(bank.skill, 'topic')
  const items = rows.length ? rows.map(r => JSON.parse(r.payload)) : bank.items
  res.json({ skill: bank.skill, key, items })
})

app.get('/api/syllabus', (_req, res) => {
  const row = db.prepare('SELECT payload FROM content_docs WHERE key = ?').get('syllabus')
  res.json(row ? JSON.parse(row.payload) : syllabus)
})

app.get('/api/assessments', (_req, res) => {
  const items = db.prepare('SELECT payload FROM content_assessments ORDER BY sort').all().map(r => JSON.parse(r.payload))
  const platformsRow = db.prepare('SELECT payload FROM content_docs WHERE key = ?').get('assessments-platforms')
  res.json({
    platforms: platformsRow ? JSON.parse(platformsRow.payload) : assessmentsDoc.platforms,
    items: items.length ? items : assessmentsDoc.items,
  })
})

app.get('/api/google-guide', (_req, res) => {
  const processRow = db.prepare('SELECT payload FROM content_docs WHERE key = ?').get('google-process')
  const gyRow = db.prepare('SELECT payload FROM content_docs WHERE key = ?').get('googleyness')
  res.json({
    process: processRow ? JSON.parse(processRow.payload) : googleProcess,
    googleyness: gyRow ? JSON.parse(gyRow.payload) : googleyness,
  })
})

app.get('/api/plan', requireUser, (req, res) => {
  const account = getAccount(req.userId)
  if (!account?.profile) return res.status(401).json({ error: 'Profile not found.' })
  const row = db.prepare('SELECT payload FROM progress WHERE user_id = ?').get(req.userId)
  const progress = row ? JSON.parse(row.payload) : { tasks: {}, problems: {} }
  const weekParam = req.query.week ? Number(req.query.week) - 1 : null
  const plan = buildPlan(account.profile, progress)
  if (weekParam != null && weekParam >= 0 && weekParam < TOTAL_WEEKS) {
    plan.weekIndex = weekParam + 1
    plan.weekStart = weekStartDate(account.profile.start_date, weekParam)
    plan.weekTasks = expandWeekTasks(account.profile.start_date, weekParam, progress)
    const week = weekPlan.weeks.find(w => w.week === weekParam + 1)
    plan.phase = week?.phase || ''
    plan.theme = week?.theme || ''
    plan.focus = week?.focus || ''
  }
  res.json(plan)
})

app.get('/api/plan/schedule', requireUser, (req, res) => {
  const account = getAccount(req.userId)
  if (!account?.profile) return res.status(401).json({ error: 'Profile not found.' })
  res.json(buildScheduleIndex(account.profile.start_date))
})

app.get('/api/plan/month', requireUser, (req, res) => {
  const account = getAccount(req.userId)
  if (!account?.profile) return res.status(401).json({ error: 'Profile not found.' })
  const row = db.prepare('SELECT payload FROM progress WHERE user_id = ?').get(req.userId)
  const progress = row ? JSON.parse(row.payload) : { tasks: {} }
  const year = Number(req.query.year) || new Date().getFullYear()
  const month = Number(req.query.month) || new Date().getMonth() + 1
  const days = []
  const start = new Date(year, month - 1, 1)
  const end = new Date(year, month, 0)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = formatDate(d)
    const planOrigin = sundayOnOrBefore(account.profile.start_date)
    const daysFromOrigin = daysBetween(planOrigin, date)
    const endDate = formatDate(addDays(parseDate(planOrigin), TOTAL_WEEKS * 7 - 1))
    if (date < account.profile.start_date || date > endDate || daysFromOrigin < 0) {
      days.push({ date, tasks: [], week: null })
      continue
    }
    const weekIndex = Math.min(TOTAL_WEEKS - 1, Math.floor(daysFromOrigin / 7))
    const tasks = expandWeekTasks(account.profile.start_date, weekIndex, progress).filter(t => t.date === date)
    days.push({ date, tasks, week: weekIndex + 1 })
  }
  res.json({ year, month, days })
})

const frontendDist = path.join(__dirname, '../frontend/dist')
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist))
  app.get(/.*/, (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')))
}

app.listen(port, () => console.log(`Prepbase API on http://localhost:${port}`))
