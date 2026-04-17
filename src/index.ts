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

interface IWaitlistEntry extends Document {
  email:     string
  instagram: string
  tiktok:    string
  category:  Category
  joinedAt:  Date
}

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
// Change these three numbers whenever you want to reset.
// Save the file — tsx watch restarts automatically and the new numbers take effect.

const BASE_BRANDS:      number = 88
const BASE_INFLUENCERS: number = 446
const BASE_AGENCIES:    number = 68

const AUTO_INCREMENT_INTERVAL_MS: number = 3 * 60 * 1_000

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const VALID_CATEGORIES: readonly Category[] = ['brand', 'influencer', 'agency'] as const

function isCategory(value: string): value is Category {
  return (VALID_CATEGORIES as readonly string[]).includes(value)
}

function randomIncrement(): number {
  return Math.floor(Math.random() * 7) + 1
}

// ─── EXPRESS ─────────────────────────────────────────────────────────────────

const app  = express()
const PORT = Number(process.env.PORT ?? 4000)

app.use(cors({
  origin: [
    'https://nexus-event-two.vercel.app',
    'http://localhost:3000',
  ],
  methods:     ['GET', 'POST', 'OPTIONS'],
  credentials: true,
}))

app.options('*', cors({
  origin: [
    'https://nexus-event-two.vercel.app',
    'http://localhost:3000',
  ],
  methods:     ['GET', 'POST', 'OPTIONS'],
  credentials: true,
}))

app.use(express.json())
app.set('trust proxy', 1)

// ─── MONGODB ──────────────────────────────────────────────────────────────────

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

const Waitlist:        Model<IWaitlistEntry>   = mongoose.model<IWaitlistEntry>  ('Waitlist',          waitlistSchema)
const SimulatedOffset: Model<ISimulatedOffset> = mongoose.model<ISimulatedOffset>('SimulatedOffset',   simulatedOffsetSchema)

// ─── SSE CLIENT STORE ─────────────────────────────────────────────────────────

const sseClients = new Map<string, Response>()

// ─── STATS ────────────────────────────────────────────────────────────────────

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
  if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
    (res as unknown as { flush: () => void }).flush()
  }
}

function broadcast(stats: IStats): void {
  sseClients.forEach((res) => sendToClient(res, stats))
}

// ─── AUTO-INCREMENT ───────────────────────────────────────────────────────────

async function runAutoIncrement(): Promise<void> {
  try {
    const bInc = randomIncrement()
    const iInc = randomIncrement()
    const aInc = randomIncrement()

    await SimulatedOffset.updateOne(
      {},
      {
        $inc: { brandsOffset: bInc, influencersOffset: iInc, agenciesOffset: aInc },
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

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response): void => {
  res.json({ status: 'ok', connectedClients: sseClients.size })
})

app.get('/api/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const stats = await fetchStats()
    res.json(stats)
  } catch (err: unknown) {
    console.error('GET /api/stats error:', err)
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})

app.get('/api/stats/stream', async (req: Request, res: Response): Promise<void> => {
  res.writeHead(200, {
    'Content-Type':                     'text/event-stream',
    'Cache-Control':                    'no-cache',
    'Connection':                       'keep-alive',
    'X-Accel-Buffering':                'no',
    'Access-Control-Allow-Origin':      'https://nexus-event-two.vercel.app',
    'Access-Control-Allow-Credentials': 'true',
  })
  res.flushHeaders()

  try {
    const stats = await fetchStats()
    sendToClient(res, stats)
  } catch (err: unknown) {
    console.error('SSE initial fetch error:', err)
  }

  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  sseClients.set(clientId, res)
  console.log(`🔌  SSE connected  [${clientId}]  total clients: ${sseClients.size}`)

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
    if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
      (res as unknown as { flush: () => void }).flush()
    }
  }, 25_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.delete(clientId)
    console.log(`🔌  SSE gone       [${clientId}]  total clients: ${sseClients.size}`)
  })
})

app.post(
  '/api/waitlist',
  async (
    req: Request<Record<string, never>, unknown, WaitlistRequestBody>,
    res: Response,
  ): Promise<void> => {
    const { email, instagram, tiktok, category } = req.body

    if (!email?.trim() || !instagram?.trim() || !category?.trim()) {
      res.status(400).json({ error: 'email, instagram, and category are required.' })
      return
    }
    if (!isCategory(category)) {
      res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` })
      return
    }

    try {
      const existing = await Waitlist.findOne({ email: email.toLowerCase().trim() })
      if (existing) {
        res.status(409).json({ error: 'This email is already on the waitlist.' })
        return
      }

      await Waitlist.create({
        email:     email.trim(),
        instagram: instagram.trim(),
        tiktok:    tiktok?.trim() ?? '',
        category,
      })

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

app.get('/api/entries', async (_req: Request, res: Response): Promise<void> => {
  try {
    const entries = await Waitlist.find().sort({ joinedAt: -1 }).select('-__v').lean()
    res.json(entries)
  } catch (err: unknown) {
    console.error('GET /api/entries error:', err)
    res.status(500).json({ error: 'Failed to fetch entries.' })
  }
})

// ─── BOOTSTRAP ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  await mongoose.connect(mongoUri as string)
  console.log('✅  MongoDB connected')

  // Always overwrite the offsets with the current BASE numbers on every startup.
  // To reset your numbers: change the three BASE constants above and save/restart.
  await SimulatedOffset.updateOne(
    {},
    {
      $set: {
        brandsOffset:      BASE_BRANDS,
        influencersOffset: BASE_INFLUENCERS,
        agenciesOffset:    BASE_AGENCIES,
        updatedAt:         new Date(),
      },
    },
    { upsert: true },
  )
  console.log(
    `📊  Offsets set  brands: ${BASE_BRANDS}  influencers: ${BASE_INFLUENCERS}  agencies: ${BASE_AGENCIES}`,
  )

  setInterval(() => { void runAutoIncrement() }, AUTO_INCREMENT_INTERVAL_MS)
  console.log(`⏱️   Auto-increment every ${AUTO_INCREMENT_INTERVAL_MS / 60_000} minutes`)

  app.listen(PORT, () => {
    console.log(`🚀  Nexus API  →  http://localhost:${PORT}`)
  })
}

bootstrap().catch((err: unknown) => {
  console.error('❌  Bootstrap failed:', err)
  process.exit(1)
})
