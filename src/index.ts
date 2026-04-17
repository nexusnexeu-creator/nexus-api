import express, { Request, Response } from 'express'
import mongoose, { Document, Schema, Model } from 'mongoose'
import cors from 'cors'
import dotenv from 'dotenv'

dotenv.config()

// ─── TYPES ────────────────────────────────────────────────────────────────────

type Category = 'brand' | 'influencer' | 'agency'

interface IStats {
  brands:      number
  influencers: number
  agencies:    number
  total:       number
}

// Real waitlist entries (actual signups)
interface IWaitlistEntry extends Document {
  email:     string
  instagram: string
  tiktok:    string
  category:  Category
  joinedAt:  Date
}

// Simulated offset — persisted in DB so numbers survive server restarts
interface ISimulatedOffset extends Document {
  brandsOffset:      number
  influencersOffset: number
  agenciesOffset:    number
  updatedAt:         Date
}

interface WaitlistRequestBody {
  email:     string
  instagram: string
  tiktok?:   string
  category:  string
}

// ─── BASE NUMBERS ─────────────────────────────────────────────────────────────
// These are the numbers that appear on day one before any real signups.
// Influencers starts at 1,046 as requested.

const BASE_BRANDS:      number = 312
const BASE_INFLUENCERS: number = 1_046
const BASE_AGENCIES:    number = 127

// Auto-increment fires every 3 minutes
const AUTO_INCREMENT_INTERVAL_MS: number = 3 * 60 * 1_000

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const VALID_CATEGORIES: readonly Category[] = ['brand', 'influencer', 'agency'] as const

function isCategory(value: string): value is Category {
  return (VALID_CATEGORIES as readonly string[]).includes(value)
}

/** Returns a random integer between 1 and 7 inclusive */
function randomIncrement(): number {
  return Math.floor(Math.random() * 7) + 1
}

// ─── EXPRESS + MONGODB ───────────────────────────────────────────────────────

const app  = express()
const PORT = Number(process.env.PORT ?? 4000)

app.use(cors({
  origin:  process.env.CLIENT_URL ?? 'http://localhost:3000',
  methods: ['GET', 'POST'],
}))
app.use(express.json())

const mongoUri = process.env.MONGO_URI
if (!mongoUri) {
  console.error('❌  MONGO_URI is not set in .env')
  process.exit(1)
}

// ─── SCHEMAS & MODELS ─────────────────────────────────────────────────────────

const waitlistSchema = new Schema<IWaitlistEntry>({
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  instagram: { type: String, required: true, trim: true },
  tiktok:    { type: String, trim: true, default: '' },
  category:  { type: String, enum: VALID_CATEGORIES, required: true },
  joinedAt:  { type: Date, default: Date.now },
})

const simulatedOffsetSchema = new Schema<ISimulatedOffset>({
  brandsOffset:      { type: Number, default: BASE_BRANDS      },
  influencersOffset: { type: Number, default: BASE_INFLUENCERS },
  agenciesOffset:    { type: Number, default: BASE_AGENCIES    },
  updatedAt:         { type: Date,   default: Date.now         },
})

const Waitlist:          Model<IWaitlistEntry>      = mongoose.model<IWaitlistEntry>('Waitlist',          waitlistSchema)
const SimulatedOffset:   Model<ISimulatedOffset>    = mongoose.model<ISimulatedOffset>('SimulatedOffset', simulatedOffsetSchema)

// ─── SSE CLIENT STORE ─────────────────────────────────────────────────────────

const sseClients = new Map<string, Response>()

/**
 * Fetches live stats = real DB signups + persisted simulated offset.
 * This means numbers always grow — both organically and artificially.
 */
async function fetchStats(): Promise<IStats> {
  const [realBrands, realInfluencers, realAgencies, offset] = await Promise.all([
    Waitlist.countDocuments({ category: 'brand'      }),
    Waitlist.countDocuments({ category: 'influencer' }),
    Waitlist.countDocuments({ category: 'agency'     }),
    SimulatedOffset.findOne().lean(),
  ])

  const brandsOffset      = offset?.brandsOffset      ?? BASE_BRANDS
  const influencersOffset = offset?.influencersOffset ?? BASE_INFLUENCERS
  const agenciesOffset    = offset?.agenciesOffset    ?? BASE_AGENCIES

  const brands      = realBrands      + brandsOffset
  const influencers = realInfluencers + influencersOffset
  const agencies    = realAgencies    + agenciesOffset

  return { brands, influencers, agencies, total: brands + influencers + agencies }
}

function sendToClient(res: Response, stats: IStats): void {
  res.write(`data: ${JSON.stringify(stats)}\n\n`)
}

function broadcast(stats: IStats): void {
  sseClients.forEach((res) => sendToClient(res, stats))
}

// ─── AUTO-INCREMENT EVERY 3 MINUTES ──────────────────────────────────────────
/**
 * Every 3 minutes:
 *   • Adds a random number (1–7) to each category offset in MongoDB
 *   • Broadcasts fresh stats to every connected browser — no reload needed
 */
async function runAutoIncrement(): Promise<void> {
  try {
    const bInc = randomIncrement()
    const iInc = randomIncrement()
    const aInc = randomIncrement()

    // Upsert: create the offset document if it doesn't exist yet
    await SimulatedOffset.updateOne(
      {},
      {
        $inc: {
          brandsOffset:      bInc,
          influencersOffset: iInc,
          agenciesOffset:    aInc,
        },
        $set: { updatedAt: new Date() },
      },
      { upsert: true },
    )

    const stats = await fetchStats()
    broadcast(stats)

    console.log(
      `📈  Auto-increment  +${bInc} brands  +${iInc} influencers  +${aInc} agencies` +
      `  →  total: ${stats.total}`,
    )
  } catch (err: unknown) {
    console.error('Auto-increment error:', err)
  }
}

// ─── STARTUP: ensure offset document exists + start auto-increment timer ──────

async function bootstrap(): Promise<void> {
  await mongoose.connect(mongoUri as string)
  console.log('✅  MongoDB connected')

  // Ensure the single SimulatedOffset document exists with base values
  const existing = await SimulatedOffset.findOne()
  if (!existing) {
    await SimulatedOffset.create({
      brandsOffset:      BASE_BRANDS,
      influencersOffset: BASE_INFLUENCERS,
      agenciesOffset:    BASE_AGENCIES,
    })
    console.log(
      `📊  Simulated offsets initialised` +
      `  brands: ${BASE_BRANDS}  influencers: ${BASE_INFLUENCERS}  agencies: ${BASE_AGENCIES}`,
    )
  } else {
    console.log(
      `📊  Existing offsets loaded` +
      `  brands: ${existing.brandsOffset}  influencers: ${existing.influencersOffset}  agencies: ${existing.agenciesOffset}`,
    )
  }

  // Fire auto-increment every 3 minutes
  setInterval(() => { void runAutoIncrement() }, AUTO_INCREMENT_INTERVAL_MS)
  console.log(`⏱️   Auto-increment every ${AUTO_INCREMENT_INTERVAL_MS / 60_000} minutes`)

  // Start HTTP server
  app.listen(PORT, () => {
    console.log(`🚀  Nexus API  →  http://localhost:${PORT}`)
  })
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req: Request, res: Response): void => {
  res.json({ status: 'ok', connectedClients: sseClients.size })
})

// GET /api/stats — one-shot current stats
app.get('/api/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const stats = await fetchStats()
    res.json(stats)
  } catch (err: unknown) {
    console.error('GET /api/stats error:', err)
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})

// GET /api/stats/stream — SSE live stats stream
app.get('/api/stats/stream', async (req: Request, res: Response): Promise<void> => {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  // Send current stats immediately on connect
  try {
    const stats = await fetchStats()
    sendToClient(res, stats)
  } catch (err: unknown) {
    console.error('SSE initial fetch error:', err)
  }

  // Register this client
  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  sseClients.set(clientId, res)
  console.log(`🔌  SSE connected  [${clientId}]  total clients: ${sseClients.size}`)

  // Heartbeat every 25 s — keeps connection alive through proxies/load balancers
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, 25_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.delete(clientId)
    console.log(`🔌  SSE gone       [${clientId}]  total clients: ${sseClients.size}`)
  })
})

// POST /api/waitlist — submit a waitlist entry
app.post(
  '/api/waitlist',
  async (
    req: Request<Record<string, never>, unknown, WaitlistRequestBody>,
    res: Response,
  ): Promise<void> => {
    const { email, instagram, tiktok, category } = req.body

    // Validation
    if (!email?.trim() || !instagram?.trim() || !category?.trim()) {
      res.status(400).json({ error: 'email, instagram, and category are required.' })
      return
    }
    if (!isCategory(category)) {
      res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` })
      return
    }

    try {
      // Duplicate check
      const existing = await Waitlist.findOne({ email: email.toLowerCase().trim() })
      if (existing) {
        res.status(409).json({ error: 'This email is already on the waitlist.' })
        return
      }

      // Save real entry to DB
      await Waitlist.create({
        email:     email.trim(),
        instagram: instagram.trim(),
        tiktok:    tiktok?.trim() ?? '',
        category,
      })

      // Fetch fresh combined stats (real + simulated) and broadcast instantly
      const stats = await fetchStats()
      broadcast(stats)

      console.log(`✅  New signup  [${category}]  ${email.trim()}  →  total: ${stats.total}`)

      res.status(201).json({ success: true, stats })
    } catch (err: unknown) {
      console.error('POST /api/waitlist error:', err)
      res.status(500).json({ error: 'Server error. Please try again.' })
    }
  },
)

// GET /api/entries — admin: list all real entries
app.get('/api/entries', async (_req: Request, res: Response): Promise<void> => {
  try {
    const entries = await Waitlist.find().sort({ joinedAt: -1 }).select('-__v').lean()
    res.json(entries)
  } catch (err: unknown) {
    console.error('GET /api/entries error:', err)
    res.status(500).json({ error: 'Failed to fetch entries.' })
  }
})

// ─── BOOT ─────────────────────────────────────────────────────────────────────

bootstrap().catch((err: unknown) => {
  console.error('❌  Bootstrap failed:', err)
  process.exit(1)
})