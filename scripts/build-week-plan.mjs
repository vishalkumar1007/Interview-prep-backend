#!/usr/bin/env node
/**
 * Rebuilds content/week-plan.json from the content banks.
 *
 * The plan is generated rather than hand-written because the hand-written one
 * drifted badly: 77 of 164 curated problems were never scheduled while Two Sum
 * was scheduled 32 times, networking bank items were labelled "Go", weekday
 * load was 125 minutes against a 120-minute capacity, and several task details
 * named problems the task did not link. Everything the plan asserts is derived
 * here from the banks, so those classes of bug cannot come back silently.
 *
 * Invariants (all asserted by scripts/validate-content.mjs):
 *   - every DSA problem is introduced exactly once, in weeks 1..INTRO_WEEKS
 *   - every Go / Fundamentals / Networking / System design bank item is taught
 *     exactly once; every Communication item is rehearsed at least once
 *   - a weekday is exactly 120 minutes, Saturday is exactly 240
 *   - a task's `skill` always matches the bank its items come from
 *   - only test/mock kinds land on Saturday; only practice/learn/review on weekdays
 *   - task prose never names a problem the task does not link
 *
 * Usage: node scripts/build-week-plan.mjs [--check]
 *   --check  compute and report, but do not write files
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const contentDir = path.join(__dirname, '..', 'content')
const read = name => JSON.parse(fs.readFileSync(path.join(contentDir, name), 'utf8'))
const writeJson = (name, value) =>
  fs.writeFileSync(path.join(contentDir, name), `${JSON.stringify(value, null, 2)}\n`)

const CHECK_ONLY = process.argv.includes('--check')

/* ------------------------------------------------------------------ *
 * Shape of a week
 * ------------------------------------------------------------------ */

// Sun–Fri are study days; Saturday (6) is the only assessment day. The API
// layer enforces the same rule, so a mock placed on a weekday would be moved.
const STUDY_DAYS = [0, 1, 2, 3, 4, 5]
const REVIEW_DAY = 4 // Thursday trades its skill block for spaced DSA review
const SATURDAY = 6

const MIN_COMMS = 15
const MIN_DSA = 65
const MIN_SKILL = 40 // also the Thursday review block
const MIN_SAT_MOCK = 90
const MIN_SAT_ASSESS = 30
const MIN_SAT_TIMED = 120

const INTRO_WEEKS = 20 // all new problems are introduced by the end of week 20

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

const syllabus = read('syllabus.json')
const problems = read('dsa-problems.json')
const patterns = read('dsa-patterns.json')
const assessments = read('assessments.json').items
const banks = {
  Go: read('go-bank.json').items,
  Fundamentals: read('fundamentals-bank.json').items,
  Networking: read('networking-bank.json').items,
  'System design': read('system-design-bank.json').items,
  Communication: read('communication-bank.json').items,
}

const TOTAL_WEEKS = syllabus.horizonWeeks
const patternById = new Map(patterns.map(p => [p.id, p]))
const patternOrder = new Map(patterns.map((p, i) => [p.id, i]))
const problemById = new Map(problems.map(p => [p.id, p]))

// syllabus.phases is the single source of truth for phase ids and week ranges.
const phaseOfWeek = new Map()
for (const phase of syllabus.phases) {
  const [from, to] = phase.weeks
  for (let w = from; w <= to; w++) phaseOfWeek.set(w, phase.id)
}
for (let w = 1; w <= TOTAL_WEEKS; w++) {
  if (!phaseOfWeek.has(w)) throw new Error(`syllabus.phases does not cover week ${w}`)
}

/* ------------------------------------------------------------------ *
 * 1. DSA introduction order
 * ------------------------------------------------------------------ */

// Pattern order comes from dsa-patterns.json, which is already a teaching
// order. Inside a pattern, easy problems come before the hard ones, so the
// first contact with a pattern is never its hardest variant.
const DIFFICULTY_RANK = { Easy: 0, Medium: 1, Hard: 2 }
const introQueue = [...problems].sort((a, b) => {
  const byPattern = patternOrder.get(a.pattern) - patternOrder.get(b.pattern)
  if (byPattern !== 0) return byPattern
  const byDifficulty = DIFFICULTY_RANK[a.difficulty] - DIFFICULTY_RANK[b.difficulty]
  if (byDifficulty !== 0) return byDifficulty
  return a.id.localeCompare(b.id)
})

// Weight the intro load by phase: lighter while patterns are new, heaviest
// through trees/graphs and DP, tapering as mock volume takes over.
const PHASE_INTRO_WEIGHT = {
  foundations: 0.8,
  structures: 1.0,
  'trees-graphs': 1.2,
  advanced: 1.2,
  'interview-strength': 1.05,
  integration: 0,
  polish: 0,
}

function introQuotas(total) {
  const weights = []
  for (let w = 1; w <= INTRO_WEEKS; w++) weights.push(PHASE_INTRO_WEIGHT[phaseOfWeek.get(w)] ?? 1)
  const sum = weights.reduce((a, b) => a + b, 0)
  const raw = weights.map(w => (total * w) / sum)
  const quotas = raw.map(Math.floor)
  // Largest-remainder so the quotas sum to exactly `total`.
  let left = total - quotas.reduce((a, b) => a + b, 0)
  const byRemainder = raw
    .map((v, i) => ({ i, rem: v - Math.floor(v) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i)
  for (let k = 0; left > 0; k++, left--) quotas[byRemainder[k % quotas.length].i]++
  return quotas
}

const quotas = introQuotas(problems.length)
const introByWeek = new Map() // week -> problem[]
{
  let cursor = 0
  for (let w = 1; w <= INTRO_WEEKS; w++) {
    introByWeek.set(w, introQueue.slice(cursor, cursor + quotas[w - 1]))
    cursor += quotas[w - 1]
  }
  if (cursor !== problems.length) throw new Error('intro quotas did not consume every problem')
}

/** Split n items across the 6 study days, front-loading the remainder. */
function spreadAcrossStudyDays(items) {
  const buckets = STUDY_DAYS.map(() => [])
  items.forEach((item, i) => buckets[i % STUDY_DAYS.length].push(item))
  return buckets
}

/* ------------------------------------------------------------------ *
 * 2. Spaced review scheduler
 * ------------------------------------------------------------------ */

// Every problem carries a review count. Review slots always pull the least
// reviewed problem, preferring ones seen a week or three weeks ago (the spacing
// that actually produces recall) and breaking ties towards harder problems and
// heavier Google patterns.
const reviewState = new Map() // problemId -> { week, reviews }

function markIntroduced(problem, week) {
  reviewState.set(problem.id, { week, reviews: 0 })
}

/**
 * Pick `count` problems for a review slot. `blocked` keeps a problem from being
 * reviewed twice in one week; `allowRepeat` lifts that when the pool is simply
 * too small — in week 1 there are only six problems in existence, and a Saturday
 * that re-drills them is right, while a Saturday that promises three problems
 * and lists one is not.
 */
function pickForReview(currentWeek, count, blocked, { allowRepeat = false } = {}) {
  const rank = ([id, state]) => {
    const problem = problemById.get(id)
    const age = currentWeek - state.week
    // 1 and 3 weeks out are the sweet spots; everything older is still fair game.
    const spacing = age === 1 || age === 3 ? 0 : age === 2 ? 1 : 2
    return {
      problem,
      reviews: state.reviews,
      spacing,
      weight: patternById.get(problem.pattern)?.googleWeight ?? 3,
      difficulty: DIFFICULTY_RANK[problem.difficulty],
    }
  }
  const byPriority = (a, b) =>
    a.reviews - b.reviews ||
    a.spacing - b.spacing ||
    b.difficulty - a.difficulty ||
    b.weight - a.weight ||
    a.problem.id.localeCompare(b.problem.id)

  const entries = [...reviewState.entries()]
  const picked = entries
    .filter(([id]) => !blocked.has(id))
    .map(rank)
    .sort(byPriority)
    .slice(0, count)
    .map(c => c.problem)

  if (allowRepeat && picked.length < count) {
    const taken = new Set(picked.map(p => p.id))
    const topUp = entries
      .filter(([id]) => !taken.has(id))
      .map(rank)
      .sort(byPriority)
      .slice(0, count - picked.length)
      .map(c => c.problem)
    picked.push(...topUp)
  }

  for (const p of picked) {
    reviewState.get(p.id).reviews++
    blocked.add(p.id)
  }
  return picked
}

/* ------------------------------------------------------------------ *
 * 3. Skill bank ordering and weekly mix
 * ------------------------------------------------------------------ */

const groupOrder = {
  // Teaching order, and a real dependency chain: nothing is taught before the
  // thing it is built on. httptest lives in `http`, not `testing`, because it
  // cannot be taught before net/http exists.
  Go: [
    'basics',
    'data-types',
    'structs',
    'interfaces',
    'errors',
    'generics',
    'testing',
    'concurrency',
    'http',
    'database',
    'ops',
    'comprehension',
  ],
  Fundamentals: ['os', 'dbms', 'oop'],
  Networking: ['dns', 'tcp', 'udp', 'http', 'tls', 'lb', 'cdn', 'auth', 'reliability'],
}

function orderedBank(skill) {
  const items = banks[skill]
  const order = groupOrder[skill]
  if (!order) return [...items] // System design is already in teaching order
  const rank = t => {
    const i = order.indexOf(t)
    return i === -1 ? order.length : i
  }
  return [...items]
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item.topic) - rank(b.item.topic) || a.i - b.i)
    .map(x => x.item)
}

const skillQueues = {
  Go: orderedBank('Go'),
  Fundamentals: orderedBank('Fundamentals'),
  Networking: orderedBank('Networking'),
  'System design': orderedBank('System design'),
}

// The weekly mix of five 40-minute skill blocks, per phase. If a named queue is
// empty the allocator falls back to whichever queue is furthest behind, so no
// bank item is ever left unscheduled by a mix that stopped matching reality.
// Position in the array is the day: [Sun, Mon, Tue, Wed, Fri] (Thursday is the
// review block). Go sits at the front of every phase that teaches it, so the Go
// stream always lands on the same early-week days instead of hopping around.
// Go is front-loaded enough to finish its bank inside the interview-strength
// phase: the week 17-20 outcome ("read and debug an unfamiliar codebase aloud")
// depends on the comprehension drills, which are the last Go topic.
const PHASE_SKILL_MIX = {
  foundations: ['Go', 'Go', 'Go', 'Fundamentals', 'Networking'],
  structures: ['Go', 'Go', 'Go', 'Fundamentals', 'Networking'],
  'trees-graphs': ['Go', 'Go', 'Go', 'Fundamentals', 'System design'],
  advanced: ['Go', 'Go', 'Go', 'System design', 'Networking'],
  'interview-strength': ['Go', 'System design', 'System design', 'Fundamentals', 'Networking'],
  integration: ['System design', 'System design', 'Fundamentals', 'Networking', 'Fundamentals'],
  polish: ['System design', 'System design', 'System design', 'Fundamentals', 'Networking'],
}

const SKILL_SLOTS_PER_WEEK = STUDY_DAYS.length - 1 // Thursday is the review block
const totalSkillSlots = SKILL_SLOTS_PER_WEEK * TOTAL_WEEKS
const totalSkillItems = Object.values(skillQueues).reduce((n, q) => n + q.length, 0)
// More items than slots is fine: the surplus rides along as a second item in the
// final weeks' blocks, which are consolidation passes anyway.
const surplus = Math.max(0, totalSkillItems - totalSkillSlots)

// The surplus rides along as a second item in the very last skill blocks, which
// are consolidation passes — not spread over the early weeks, where a doubled
// block would mean two new topics in forty minutes. Inside that window the
// phase mix is ignored and the fullest bank goes first, because a doubled block
// may only pair items from one bank and the window has to drain every queue.
// The window opens with runway to spare and each block doubles only while items
// still outnumber the slots left, so the last slots cannot strand a lone item in
// a bank that has already had its turn.
const doubleFromSlot = Math.max(0, totalSkillSlots - surplus * 2)
let skillSlotIndex = 0

const itemsLeft = () => Object.values(skillQueues).reduce((n, q) => n + q.length, 0)
const fullestSkill = () =>
  Object.entries(skillQueues).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0][0]

function takeSkillItem(preferred) {
  const remaining = skill => skillQueues[skill].length
  const order = [preferred, ...Object.keys(skillQueues).filter(s => s !== preferred)].sort((a, b) => {
    if (a === preferred && remaining(a) > 0) return -1
    if (b === preferred && remaining(b) > 0) return 1
    return remaining(b) - remaining(a)
  })
  for (const skill of order) {
    if (skillQueues[skill].length) return { skill, item: skillQueues[skill].shift() }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 4. Communication rehearsal rotation
 * ------------------------------------------------------------------ */

// Each phase rehearses a named set. The union covers every communication item,
// and later phases re-drill earlier sets so a story is delivered, not just drafted.
const PHASE_COMMS = {
  foundations: ['com001', 'com002', 'com003', 'com005', 'com017', 'com021', 'com023'],
  structures: ['com004', 'com008', 'com009', 'com018', 'com019', 'com032'],
  'trees-graphs': ['com006', 'com007', 'com010', 'com011', 'com012', 'com031'],
  advanced: ['com013', 'com014', 'com015', 'com016', 'com020', 'com022', 'com024'],
  'interview-strength': ['com025', 'com026', 'com027', 'com028', 'com029', 'com030', 'com033'],
  integration: ['com008', 'com009', 'com010', 'com011', 'com012', 'com020', 'com024', 'com033'],
  polish: ['com001', 'com003', 'com013', 'com014', 'com016', 'com030', 'com021'],
}

const commsById = new Map(banks.Communication.map(i => [i.id, i]))
for (const [phase, ids] of Object.entries(PHASE_COMMS)) {
  for (const id of ids) {
    if (!commsById.has(id)) throw new Error(`PHASE_COMMS[${phase}] references unknown ${id}`)
  }
}

const commsReps = new Map() // id -> times rehearsed so far
const commsCursor = new Map() // phase -> rotation position
const COMMS_STAGE = [
  { verb: 'Draft', how: 'Write the bullets yourself first, no AI. Structure before wording.' },
  { verb: 'Record', how: 'Record yourself delivering it. Play it back and cut every filler sentence.' },
  { verb: 'Deliver', how: 'Deliver it to time, out loud, without looking at your notes.' },
  { verb: 'Pressure round', how: 'Deliver it cold, then answer one follow-up you have not rehearsed.' },
]

function nextCommsTask(week, phase) {
  const pool = PHASE_COMMS[phase]
  const pos = commsCursor.get(phase) ?? 0
  commsCursor.set(phase, pos + 1)
  const item = commsById.get(pool[pos % pool.length])
  const reps = commsReps.get(item.id) ?? 0
  commsReps.set(item.id, reps + 1)
  const stage = COMMS_STAGE[Math.min(reps, COMMS_STAGE.length - 1)]
  return {
    title: `${stage.verb}: ${item.title}`,
    detail: `${stage.how} ${item.practicePrompt}`,
    skill: 'Communication',
    minutes: MIN_COMMS,
    kind: reps === 0 ? 'learn' : 'practice',
    bankItemIds: [item.id],
    problemIds: [],
  }
}

/* ------------------------------------------------------------------ *
 * 5. Assessments per week
 * ------------------------------------------------------------------ */

// Assessments are matched to the week whose content they actually test rather
// than trusting their authored weekHint: the hand-written hints were written
// against an older, noisier problem order, which is how "Weekly mock: trees"
// ended up on a stack week. Each assessment is used exactly once, and the
// weekHint in the bank is rewritten to the week it lands on.

// An assessment's `topic` is either a pattern id, a pattern family, a bank
// area, or generic. These map a family to the pattern ids it covers.
const TOPIC_FAMILIES = {
  trees: ['trees-dfs', 'trees-bfs'],
  graphs: ['graphs-bfs', 'graphs-dfs', 'topological-sort', 'union-find', 'dijkstra'],
  'dynamic-programming': ['dp-1d', 'dp-2d', 'dp-knapsack', 'dp-lis'],
  'stack-queue': ['stack'],
  heap: ['heap-topk'],
}
// Topic -> the skill whose bank block should be running that week.
const TOPIC_SKILLS = {
  language: 'Go', // assessment-side alias for the Go language topics
  basics: 'Go',
  'data-types': 'Go',
  structs: 'Go',
  interfaces: 'Go',
  errors: 'Go',
  generics: 'Go',
  testing: 'Go',
  concurrency: 'Go',
  http: 'Go',
  database: 'Go',
  ops: 'Go',
  comprehension: 'Go',
  os: 'Fundamentals',
  dbms: 'Fundamentals',
  dns: 'Networking',
  tls: 'Networking',
  hld: 'System design',
  lld: 'System design',
  english: 'Communication',
  behavioral: 'Communication',
}
// Some assessments only make sense once the material exists. The Go rows are
// keyed to the week its bank actually reaches that topic — without them a Go
// capstone lands on week 1 and a goroutine check two weeks before goroutines.
const EARLIEST_WEEK = {
  hld: 9,
  lld: 17,
  comprehension: 17,
  'full-loop': 21,
  behavioral: 13,
  'google-tag': 13,
  language: 8, // Go language core finishes week 7; the check also wants table tests
  testing: 8,
  concurrency: 9,
  http: 13,
  database: 14,
  ops: 16,
}

function assessmentScore(a, week, weekPatterns, weekSkills) {
  const topic = a.topic ?? 'mixed'
  if (week < (EARLIEST_WEEK[topic] ?? 1)) return -1
  if (weekPatterns.has(topic)) return 5
  const family = TOPIC_FAMILIES[topic]
  if (family && family.some(p => weekPatterns.has(p))) return 4
  const skill = TOPIC_SKILLS[topic]
  if (skill && weekSkills.has(skill)) return 3
  // A topic-specific check still outranks a generic one even when its skill
  // block runs in another week: there are more retention items than Saturdays,
  // and a "mixed review" is the replaceable one.
  if (skill) return 2.5
  return 2 // generic: mixed, review, peer, implementation, remediation, full-loop
}

const primaryPool = assessments.filter(a => a.type === 'weekly' || a.type === 'mock')
const checkPool = assessments.filter(a => a.type === 'retention')
const claimed = new Set()

function claimBest(pool, week, weekPatterns, weekSkills) {
  let best = null
  let bestScore = -Infinity
  let bestGate = -Infinity
  for (const a of pool) {
    if (claimed.has(a.id)) continue
    const score = assessmentScore(a, week, weekPatterns, weekSkills)
    if (score < 0) continue // gated: its material does not exist yet
    // Prefer the better fit, then the most constrained item — one that only
    // just became eligible has fewer weeks left than an always-eligible one.
    // On a full tie keep the author's ordering, which moves heavier mocks later.
    const gate = EARLIEST_WEEK[a.topic ?? 'mixed'] ?? 1
    if (score > bestScore || (score === bestScore && gate > bestGate)) {
      best = a
      bestScore = score
      bestGate = gate
    }
  }
  if (best) claimed.add(best.id)
  return best
}

/* ------------------------------------------------------------------ *
 * 6. Prose helpers — every sentence names only what the task links
 * ------------------------------------------------------------------ */

const listTitles = list => list.map(p => p.title).join(' + ')
const patternName = id => patternById.get(id)?.name ?? id
const uniquePatternNames = list => [...new Set(list.map(p => patternName(p.pattern)))]
const sentence = s => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

function dsaIntroTask(list) {
  const names = uniquePatternNames(list)
  const lead = list[0]
  const parts = [
    `Attempt solo, no AI: clarify, brute force, optimise, code, test. State the complexity out loud before you run anything.`,
    `Follow-up to answer aloud: ${sentence(lead.followUpIdea)}`,
  ]
  if (list.length > 1) {
    parts.splice(1, 0, `Two problems — if the first runs over 40 minutes, stop, read the editorial, and carry the second to tomorrow.`)
  }
  return {
    title: `DSA · ${names.join(' / ')}: ${listTitles(list)}`,
    detail: parts.join(' '),
    skill: 'DSA',
    minutes: MIN_DSA,
    kind: 'practice',
    problemIds: list.map(p => p.id),
    bankItemIds: [],
  }
}

function dsaRevisionTask(list, week) {
  return {
    title: `DSA revision · ${uniquePatternNames(list).join(' / ')}: ${listTitles(list)}`,
    detail: `Re-solve from scratch under time — 30 minutes each, no notes and no editorial. Anything you cannot start within two minutes goes on this week's weak list. Week ${week} is revision only: no new problems.`,
    skill: 'DSA',
    minutes: MIN_DSA,
    kind: 'practice',
    problemIds: list.map(p => p.id),
    bankItemIds: [],
  }
}

function reviewTask(list) {
  if (!list.length) {
    return {
      title: 'Spaced review: pattern sheet',
      detail: 'Nothing is due for review yet. Write this week\'s patterns from memory instead: when to use each, the invariant, and the complexity.',
      skill: 'DSA',
      minutes: MIN_SKILL,
      kind: 'review',
      problemIds: [],
      bankItemIds: [],
    }
  }
  return {
    title: `Spaced review · ${uniquePatternNames(list).join(' / ')}: ${listTitles(list)}`,
    detail: `Recall pass, not a re-solve: for each one state the pattern, the invariant and the complexity from memory, then code only the part you could not recall. If a trick comes back in under 60 seconds, mark it green and move on.`,
    skill: 'DSA',
    minutes: MIN_SKILL,
    kind: 'review',
    problemIds: list.map(p => p.id),
    bankItemIds: [],
  }
}

function skillTask(picks) {
  const [first] = picks
  const titles = picks.map(p => p.item.title).join(' + ')
  const prompt = first.item.practicePrompt || first.item.selfCheckQuestions?.[0] || first.item.overview
  return {
    title: `${first.skill}: ${titles}`,
    detail: `${sentence(first.item.overview.split('. ')[0])} ${sentence(prompt)} Write your notes before opening any AI.`,
    skill: first.skill,
    minutes: MIN_SKILL,
    kind: 'learn',
    bankItemIds: picks.map(p => p.item.id),
    problemIds: [],
  }
}

/* ------------------------------------------------------------------ *
 * 7. Build the weeks
 * ------------------------------------------------------------------ */

const weeks = []

for (let week = 1; week <= TOTAL_WEEKS; week++) {
  const phase = phaseOfWeek.get(week)
  // A problem is reviewed at most once per week, but a problem introduced
  // earlier in the same week is fair game for Thursday's review and Saturday's
  // sets — that short gap is the point of the weekly rhythm.
  const reviewedThisWeek = new Set()
  const dailyTasks = []
  const weekPatterns = []
  const weekSkills = new Set()

  const introduced = introByWeek.get(week) ?? []
  const introBuckets = spreadAcrossStudyDays(introduced)
  const isRevisionWeek = introduced.length === 0

  for (const day of STUDY_DAYS) {
    // 15 min — communication
    const comms = nextCommsTask(week, phase)
    dailyTasks.push({ dayOffset: day, idSuffix: 'comms', ...comms })

    // 65 min — DSA
    const todaysNew = introBuckets[STUDY_DAYS.indexOf(day)] ?? []
    const introducedToday = new Set()
    if (todaysNew.length) {
      for (const p of todaysNew) {
        markIntroduced(p, week)
        introducedToday.add(p.id)
        weekPatterns.push(p.pattern)
      }
      dailyTasks.push({ dayOffset: day, idSuffix: 'dsa', ...dsaIntroTask(todaysNew) })
    } else {
      const blocked = new Set([...reviewedThisWeek, ...introducedToday])
      const list = pickForReview(week, isRevisionWeek ? 2 : 1, blocked)
      list.forEach(p => {
        weekPatterns.push(p.pattern)
        reviewedThisWeek.add(p.id)
      })
      // A distinct idSuffix so a revision block is distinguishable from first
      // contact both in the data and in the task id the API builds.
      dailyTasks.push({ dayOffset: day, idSuffix: 'dsa-revision', ...dsaRevisionTask(list, week) })
    }

    // 40 min — skill block, except Thursday which is the spaced review
    if (day === REVIEW_DAY) {
      const blocked = new Set([...reviewedThisWeek, ...introducedToday])
      const list = pickForReview(week, 3, blocked)
      list.forEach(p => reviewedThisWeek.add(p.id))
      dailyTasks.push({ dayOffset: day, idSuffix: 'review', ...reviewTask(list) })
    } else {
      const inDoubleWindow = skillSlotIndex >= doubleFromSlot
      const preferred = inDoubleWindow
        ? fullestSkill()
        : PHASE_SKILL_MIX[phase][dailyTasks.filter(t => t.idSuffix === 'skill').length % 5]
      const picks = []
      const first = takeSkillItem(preferred)
      if (first) {
        picks.push(first)
        if (inDoubleWindow && itemsLeft() > totalSkillSlots - skillSlotIndex - 1) {
          // A doubled block stays inside one bank: pairing two skills under a
          // single label would make the task's `skill` lie about its items.
          const queue = skillQueues[first.skill]
          if (queue.length) picks.push({ skill: first.skill, item: queue.shift() })
        }
        skillSlotIndex++
      }
      if (picks.length) {
        weekSkills.add(picks[0].skill)
        dailyTasks.push({ dayOffset: day, idSuffix: 'skill', ...skillTask(picks) })
      } else {
        // Banks exhausted: consolidate instead of inventing filler.
        dailyTasks.push({
          dayOffset: day,
          idSuffix: 'skill',
          title: 'Consolidation: one-page cheat sheet from memory',
          detail:
            'Every bank item is covered. Rebuild one page from memory — request path, storage choice, concurrency rules, complexity table — then check it against the banks and note only the gaps.',
          skill: 'System design',
          minutes: MIN_SKILL,
          kind: 'review',
          bankItemIds: [],
          problemIds: [],
        })
        weekSkills.add('System design')
      }
    }
  }

  // Saturday — 240 minutes of assessment, the only assessment day
  const patternsThisWeek = new Set(weekPatterns)
  const mock = claimBest(primaryPool, week, patternsThisWeek, weekSkills)
  const check = claimBest(checkPool, week, patternsThisWeek, weekSkills)
  const mockProblems = pickForReview(week, 2, reviewedThisWeek, { allowRepeat: true })
  const countWord = n => ['no', 'one', 'two', 'three'][n] ?? String(n)
  dailyTasks.push({
    dayOffset: SATURDAY,
    idSuffix: 'mock',
    title: mock ? (/^(Weekly|Mock|Full|Final|System design|Go capstone)/i.test(mock.title) ? mock.title : `Weekly mock: ${mock.title}`) : 'Weekly mock',
    detail: mockProblems.length
      ? `${sentence(mock?.instructions ?? 'Two problems in 70 minutes, then a 20-minute retro.')} Run ${countWord(mockProblems.length)} timed at 35 minutes each: ${listTitles(mockProblems)}. No AI during the mock.`
      : `${sentence(mock?.instructions ?? 'Timed mock.')} No AI during the mock.`,
    skill: 'Mock interview',
    minutes: MIN_SAT_MOCK,
    kind: 'mock',
    assessmentId: mock?.id ?? null,
    problemIds: mockProblems.map(p => p.id),
    bankItemIds: [],
  })

  dailyTasks.push({
    dayOffset: SATURDAY,
    idSuffix: 'assess',
    title: check ? check.title : 'Saturday retention check',
    detail: `${sentence(check?.instructions ?? 'Timed retention check. Self-score and tag every miss by pattern.')} Saturday only — log the score so the trend is visible.`,
    skill: 'Mock interview',
    minutes: MIN_SAT_ASSESS,
    kind: 'test',
    assessmentId: check?.id ?? null,
    problemIds: [],
    bankItemIds: [],
  })

  const timed = pickForReview(week, 3, reviewedThisWeek, { allowRepeat: true })
  const retroMinutes = MIN_SAT_TIMED - timed.length * 30
  dailyTasks.push({
    dayOffset: SATURDAY,
    idSuffix: 'timed-set',
    title: `Timed set: ${uniquePatternNames(timed).join(' / ')}`,
    detail: `${countWord(timed.length)[0].toUpperCase()}${countWord(timed.length).slice(1)} problem${timed.length === 1 ? '' : 's'} back to back, 30 minutes each, then ${retroMinutes} minutes of retro: ${listTitles(timed)}. No AI and no editorial until every one is closed. Write down which pattern you failed to name in time.`,
    skill: 'Mock interview',
    minutes: MIN_SAT_TIMED,
    kind: 'mock',
    problemIds: timed.map(p => p.id),
    bankItemIds: [],
  })

  // Theme and focus are derived, so they can never describe a week's content wrongly.
  const orderedWeekPatterns = [...new Set(weekPatterns)].sort(
    (a, b) => patternOrder.get(a) - patternOrder.get(b),
  )
  const patternPart = orderedWeekPatterns.length
    ? orderedWeekPatterns.slice(0, 3).map(patternName).join(', ')
    : 'mixed revision'
  const skillPart = [...weekSkills].join(', ')
  const phaseTitle = syllabus.phases.find(p => p.id === phase).title

  weeks.push({
    week,
    phase,
    theme: skillPart ? `${patternPart} · ${skillPart}` : patternPart,
    focus: isRevisionWeek
      ? `${phaseTitle}: revision under time, weak-pattern sprints, and full-loop rehearsal.`
      : `${phaseTitle}: ${introduced.length} new problems across ${orderedWeekPatterns.length} pattern${orderedWeekPatterns.length === 1 ? '' : 's'}${week > 1 ? ', plus spaced review of earlier weeks' : ', building the daily rhythm'}.`,
    dailyTasks,
  })
}

/* ------------------------------------------------------------------ *
 * 8. Self-checks before writing
 * ------------------------------------------------------------------ */

const errors = []

const introCount = new Map()
for (const w of weeks) {
  for (const t of w.dailyTasks) {
    if (t.idSuffix === 'dsa') {
      for (const id of t.problemIds) introCount.set(id, (introCount.get(id) ?? 0) + 1)
    }
  }
}
for (const p of problems) {
  const n = introCount.get(p.id) ?? 0
  if (n !== 1) errors.push(`${p.id} (${p.title}) introduced ${n} times, expected 1`)
}

for (const [skill, queue] of Object.entries(skillQueues)) {
  if (queue.length) errors.push(`${skill} bank has ${queue.length} unscheduled items: ${queue.map(i => i.id).join(', ')}`)
}
for (const item of banks.Communication) {
  if (!commsReps.has(item.id)) errors.push(`communication item ${item.id} is never rehearsed`)
}

for (const w of weeks) {
  const perDay = new Map()
  for (const t of w.dailyTasks) perDay.set(t.dayOffset, (perDay.get(t.dayOffset) ?? 0) + t.minutes)
  for (const [day, mins] of perDay) {
    const cap = day === SATURDAY ? syllabus.capacity.weekendMinutes : syllabus.capacity.weekdayMinutes
    if (mins !== cap) errors.push(`week ${w.week} day ${day} is ${mins} min, expected ${cap}`)
  }
}

if (errors.length) {
  console.error('week-plan build failed:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * 9. Write
 * ------------------------------------------------------------------ */

const totalTasks = weeks.reduce((n, w) => n + w.dailyTasks.length, 0)
const reviewTotals = [...reviewState.values()]
const minReviews = Math.min(...reviewTotals.map(r => r.reviews))

console.log(`weeks: ${weeks.length}, tasks: ${totalTasks}`)
console.log(`problems introduced: ${introCount.size}/${problems.length} (each exactly once)`)
console.log(`skill bank items scheduled: ${totalSkillItems} into ${totalSkillSlots} slots (surplus ${surplus})`)
console.log(`communication items rehearsed: ${commsReps.size}/${banks.Communication.length}`)
console.log(`minimum reviews per problem: ${minReviews}`)

if (CHECK_ONLY) {
  console.log('--check: nothing written')
  process.exit(0)
}

writeJson('week-plan.json', { weeks })

// Keep weekHint honest: it now records the week a problem is actually introduced.
const introWeekOf = new Map()
for (const w of weeks) {
  for (const t of w.dailyTasks) {
    if (t.idSuffix === 'dsa') {
      for (const id of t.problemIds) if (!introWeekOf.has(id)) introWeekOf.set(id, w.week)
    }
  }
}
writeJson(
  'dsa-problems.json',
  problems.map(p => ({ ...p, weekHint: introWeekOf.get(p.id) ?? p.weekHint })),
)

// Same for the assessment bank: weekHint records the Saturday it was matched to.
const assessmentWeek = new Map()
for (const w of weeks) {
  for (const t of w.dailyTasks) {
    if (t.assessmentId) assessmentWeek.set(t.assessmentId, w.week)
  }
}
const assessmentsDoc = read('assessments.json')
assessmentsDoc.items = assessmentsDoc.items
  .map(a => ({ ...a, weekHint: assessmentWeek.get(a.id) ?? a.weekHint }))
  .sort((a, b) => a.weekHint - b.weekHint || (a.type === 'retention' ? 1 : 0) - (b.type === 'retention' ? 1 : 0) || a.id.localeCompare(b.id))
writeJson('assessments.json', assessmentsDoc)

const unmatched = assessmentsDoc.items.filter(a => !assessmentWeek.has(a.id))
if (unmatched.length) {
  console.log(`assessments not placed on a Saturday: ${unmatched.map(a => a.id).join(', ')}`)
}

console.log('wrote content/week-plan.json, content/dsa-problems.json and content/assessments.json')
