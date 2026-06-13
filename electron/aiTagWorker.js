const fs = require('fs')
const path = require('path')

function normalizeOllamaUrl(input) {
  const fallback = 'http://localhost:11434'
  const raw = String(input || fallback).trim() || fallback
  return raw.replace(/\/+$/, '').replace(/\/\/localhost(:|$|\/)/i, '//127.0.0.1$1')
}

function getErrorMessage(error) {
  const message = error?.message || String(error)
  const cause = error?.cause?.message || error?.cause?.code
  return cause && !message.includes(cause) ? `${message}: ${cause}` : message
}

function parseTagsResponse(raw) {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const candidates = []
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < cleaned.length; j++) {
      const ch = cleaned[j]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') depth += 1
      if (ch === '}') depth -= 1
      if (depth === 0) {
        candidates.push(cleaned.slice(i, j + 1))
        break
      }
    }
  }
  let parsed = null
  let lastError = null
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value && typeof value === 'object' && Array.isArray(value.tags)) {
        parsed = value
        break
      }
    } catch (e) {
      lastError = e
    }
  }
  if (!parsed) {
    if (lastError) throw lastError
    throw new Error('No JSON in response')
  }
  return {
    tags: (parsed.tags || []).map(t => String(t).trim().toLowerCase()).filter(t => t.length > 0 && t.length < 40).slice(0, 15),
    description: String(parsed.description || '').trim().slice(0, 500),
  }
}

async function imageToBase64(filePath) {
  const SIZE_LIMIT = 9 * 1024 * 1024
  const MAX_DIM = 1920
  const buf = await fs.promises.readFile(filePath)
  if (buf.length <= SIZE_LIMIT) return buf.toString('base64')

  try {
    const sharp = require('sharp')
    return await sharp(buf, { animated: false, limitInputPixels: false })
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer()
      .then(out => out.toString('base64'))
  } catch {
    return buf.toString('base64')
  }
}

async function tagImage({ filePath, model, baseUrl }) {
  const imageBase64 = await imageToBase64(filePath)
  const prompt = `Analyze this image carefully. Reply with ONLY valid JSON - no markdown, no explanation, nothing else.

Format:
{"description":"one clear sentence describing what is in the image","tags":["tag1","tag2","tag3"]}

Tag rules (include ALL that apply, 6-15 tags):
- MEDIUM/SOURCE: "video game", "3d render", "digital art", "illustration", "photography", "anime", "painting", "sketch", "screenshot", "ui design", "pixel art", "real life" etc.
- SUBJECT: people, animals, vehicles, objects, food, nature, architecture, characters, etc.
- GENRE/CONTEXT: fantasy, sci-fi, horror, action, sports, nature, urban, cyberpunk, medieval, futuristic etc.
- MOOD/TONE: dark, vibrant, moody, peaceful, dramatic, cinematic, minimalist, chaotic etc.
- COLORS: dominant colors if distinctive.
- STYLE: realistic, stylized, cartoon, hyper-realistic, low-poly, retro etc.
- SPECIFIC DETAILS: brand names, recognizable characters/games/shows if clearly identifiable

Use lowercase. Be specific - "sports car" not just "car", "mountain landscape" not just "landscape".`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90000)
  try {
    const res = await fetch(`${normalizeOllamaUrl(baseUrl)}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, images: [imageBase64], stream: false, think: false, options: { temperature: 0.1, num_predict: 400 } }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 100)}`, fatal: res.status >= 500 }
    }
    const data = await res.json()
    return { ok: true, ...parseTagsResponse(data.response) }
  } finally {
    clearTimeout(timer)
  }
}

process.on('message', async msg => {
  if (!msg || msg.type !== 'tag') return
  try {
    const result = await tagImage(msg)
    process.send?.({ type: 'result', result })
  } catch (e) {
    const message = getErrorMessage(e)
    const fatal = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|abort|network/i.test(message)
    process.send?.({ type: 'result', result: { ok: false, error: message, fatal } })
  }
})
