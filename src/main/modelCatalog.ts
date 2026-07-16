// Model catalog sourced from models.dev — the public, credential-independent
// registry (the same one hermes/pi consult). It's fresher and richer than pi's
// bundled static list, so it drives the Settings model dropdown. pi stays the
// execution engine; see `resolveModel` in codingAgent.ts for how a models.dev
// record becomes a runnable pi Model when pi's bundled catalog doesn't have it.
//
// Resolution (10-min freshness):
//   1. fresh in-memory copy            (common case, no I/O)
//   2. live fetch models.dev/api.json  → cache in memory + to disk
//   3. fetch failed → last-good copy from memory, else disk
//   4. nothing cached → pi's bundled getModels() (per provider, in getCatalog*)
//
// The disk copy writes itself; pi's list is bundled — so there is nothing to
// hand-maintain. The only static bit is DEV_KEY (our slug → models.dev key) for
// the handful of providers whose keys differ.

import { promises as fs } from 'fs';
import path from 'path';
import { getModels } from '@earendil-works/pi-ai/compat';

const URL = 'https://models.dev/api.json';
const TTL_MS = 10 * 60 * 1000; // 10 minutes
const FETCH_TIMEOUT_MS = 8000;

// Our provider slugs (settings + pi) → models.dev's top-level key. Identity for
// everything not listed. Providers absent from models.dev entirely fall through
// to pi's bundled list per-provider (see getCatalogModels).
const DEV_KEY: Record<string, string> = {
  fireworks: 'fireworks-ai',
  together: 'togetherai',
  'vercel-ai-gateway': 'vercel',
  'kimi-coding': 'kimi-for-coding',
};

// The normalized record. Superset of what the dropdown needs (id/name) plus the
// runtime fields `resolveModel` reads to synthesize a pi Model for new models.
export type CatalogModel = {
  id: string;
  name: string;
  reasoning: boolean;
  reasoningLevels: string[]; // models.dev reasoning_options effort values (informational)
  contextWindow: number;
  maxTokens: number;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

type RawRegistry = Record<string, { models?: Record<string, any> }>;

let mem: { reg: RawRegistry; fetchedAt: number } | null = null;
let diskPath: string | null = null;
let inFlight: Promise<RawRegistry | null> | null = null;

/** Wire the on-disk cache location. Call once at startup with userData dir. */
export function initModelCatalog(userDataDir: string): void {
  diskPath = path.join(userDataDir, 'model-catalog.json');
}

async function readDisk(): Promise<RawRegistry | null> {
  if (!diskPath) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(diskPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // missing/corrupt — non-fatal, deeper fallback handles it
  }
}

async function writeDisk(reg: RawRegistry): Promise<void> {
  if (!diskPath) return;
  try {
    await fs.writeFile(diskPath, JSON.stringify(reg), 'utf8');
  } catch {
    // best-effort cache; a failed write just means we refetch next launch
  }
}

// The whole registry, honoring the 10-min TTL, with the offline fallbacks.
// Concurrent callers share one in-flight fetch. Returns null only when live +
// memory + disk all fail (fresh offline first-run) — callers then use pi.
async function loadRegistry(): Promise<RawRegistry | null> {
  if (mem && Date.now() - mem.fetchedAt < TTL_MS) return mem.reg;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        const reg = (await res.json()) as RawRegistry;
        mem = { reg, fetchedAt: Date.now() };
        void writeDisk(reg);
        return reg;
      }
    } catch {
      // network/parse failure — fall through to cached copies
    }
    if (mem) return mem.reg; // stale but usable
    const disk = await readDisk();
    if (disk) {
      mem = { reg: disk, fetchedAt: 0 }; // treat as stale so next call retries live
      return disk;
    }
    return null;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function normalizeRecord(id: string, rec: any): CatalogModel {
  const input = (Array.isArray(rec?.modalities?.input) ? rec.modalities.input : ['text'])
    .filter((x: string) => x === 'text' || x === 'image');
  const effort = Array.isArray(rec?.reasoning_options)
    ? (rec.reasoning_options.find((o: any) => o?.type === 'effort')?.values ?? [])
    : [];
  return {
    id,
    name: rec?.name ?? id,
    reasoning: Boolean(rec?.reasoning),
    reasoningLevels: effort,
    contextWindow: rec?.limit?.context ?? 128000,
    maxTokens: rec?.limit?.output ?? 16384,
    input: input.length ? input : ['text'],
    cost: {
      input: rec?.cost?.input ?? 0,
      output: rec?.cost?.output ?? 0,
      cacheRead: rec?.cost?.cache_read ?? 0,
      cacheWrite: rec?.cost?.cache_write ?? 0,
    },
  };
}

// pi's bundled models, normalized to CatalogModel — the per-provider fallback
// for providers models.dev doesn't carry (or a fresh offline first-run).
function fromPi(provider: string): CatalogModel[] {
  // getModels is the deprecated static-catalog read; its param is pi's
  // KnownProvider union — our slug is a plain string, so cast (an unknown
  // provider just yields []).
  return getModels(provider as any).map((m: any) => ({
    id: m.id,
    name: m.name ?? m.id,
    reasoning: Boolean(m.reasoning),
    reasoningLevels: [],
    contextWindow: m.contextWindow ?? 128000,
    maxTokens: m.maxTokens ?? 16384,
    input: Array.isArray(m.input) ? m.input : ['text'],
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

/** Catalog models for one provider, sorted by id. Never throws. */
export async function getCatalogModels(provider: string): Promise<CatalogModel[]> {
  if (!provider) return [];
  const reg = await loadRegistry();
  const models = reg?.[DEV_KEY[provider] ?? provider]?.models;
  const out = models
    ? Object.entries(models).map(([id, rec]) => normalizeRecord(id, rec))
    : fromPi(provider); // provider absent from models.dev, or offline w/ no cache
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** One catalog record, or null if neither models.dev nor pi knows it. */
export async function getCatalogModel(provider: string, id: string): Promise<CatalogModel | null> {
  if (!provider || !id) return null;
  return (await getCatalogModels(provider)).find((m) => m.id === id) ?? null;
}
