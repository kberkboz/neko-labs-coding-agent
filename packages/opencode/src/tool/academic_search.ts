import * as Tool from "./tool"
import { Effect, Schema } from "effect"

/**
 * Neko academic search — ported from Neko Labs' backend/tools/literature.py.
 *
 * Queries the free, keyless scholarly APIs (arXiv, PubMed, Semantic Scholar,
 * Crossref) and returns real papers (title, authors, year, abstract, DOI, URL)
 * so experiments / brainstorm / discussions can ground themselves in actual
 * literature instead of the model's memory. No API keys required.
 *
 * Gated behind the "webfetch" permission so it follows the same web-access
 * posture as the rest of the toolset.
 */

const MAX_RESULTS = 8
const TIMEOUT_MS = 25_000

// Optional API keys. All four sources work without any key; a key only raises the
// rate limit (Semantic Scholar's keyless pool is shared and frequently 429s, so a
// free key helps most there). Read from the environment.
const S2_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()
const NCBI_KEY = process.env.NCBI_API_KEY?.trim()
// Crossref's "polite pool" wants a contact email in the User-Agent. We don't
// ship one; set CROSSREF_MAILTO in the environment to opt in. Without it we use
// a plain User-Agent (the public pool still works).
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO?.trim()
const UA = CROSSREF_MAILTO ? `Neko-Code-Research/1.0 (mailto:${CROSSREF_MAILTO})` : "Neko-Code-Research/1.0"

type Paper = {
  title: string
  authors: string[]
  abstract: string
  doi: string
  url: string
  source: string
  year: string
}

const paper = (p: Partial<Paper>): Paper => ({
  title: (p.title ?? "").trim(),
  authors: p.authors ?? [],
  abstract: (p.abstract ?? "").trim(),
  doi: (p.doi ?? "").trim(),
  url: (p.url ?? "").trim(),
  source: p.source ?? "",
  year: String(p.year ?? "").trim(),
})

const year4 = (text: string) => (text ? (String(text).match(/\b(?:19|20)\d{2}\b/)?.[0] ?? "") : "")

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}
async function getJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

// ── arXiv (Atom XML) ──────────────────────────────────────────────────────
async function searchArxiv(query: string, max: number): Promise<Paper[]> {
  const url =
    `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${query}`)}` +
    `&start=0&max_results=${max}&sortBy=relevance&sortOrder=descending`
  const xml = await getText(url)
  const grab = (s: string, tag: string) =>
    s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.replace(/\s+/g, " ").trim() ?? ""
  return xml
    .split("<entry>")
    .slice(1)
    .map((chunk) => {
      const entry = chunk.split("</entry>")[0] ?? ""
      const id = grab(entry, "id")
      const arxivId = id.match(/arxiv\.org\/abs\/([\w./-]+)/)?.[1] ?? ""
      return paper({
        title: grab(entry, "title"),
        abstract: grab(entry, "summary"),
        authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1]!.trim()),
        doi: grab(entry, "arxiv:doi"),
        url: arxivId ? `https://arxiv.org/abs/${arxivId}` : id,
        source: arxivId ? `arxiv:${arxivId}` : "arxiv",
        year: year4(grab(entry, "published")),
      })
    })
}

// ── PubMed (NCBI E-utilities: esearch + esummary JSON) ─────────────────────
async function searchPubmed(query: string, max: number): Promise<Paper[]> {
  const apiKey = NCBI_KEY ? `&api_key=${NCBI_KEY}` : ""
  const esearch = await getJson<any>(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${max}&retmode=json&sort=relevance${apiKey}`,
  )
  const ids: string[] = esearch?.esearchresult?.idlist ?? []
  if (!ids.length) return []
  const summary = await getJson<any>(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json${apiKey}`,
  )
  const result = summary?.result ?? {}
  return (result.uids ?? []).map((uid: string) => {
    const r = result[uid] ?? {}
    const doi = (r.articleids ?? []).find((a: any) => a.idtype === "doi")?.value ?? ""
    return paper({
      title: r.title ?? "",
      authors: (r.authors ?? []).map((a: any) => a.name).filter(Boolean),
      doi,
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      source: `pubmed:${uid}`,
      year: year4(r.pubdate ?? ""),
    })
  })
}

// ── Semantic Scholar (JSON) ────────────────────────────────────────────────
async function searchSemanticScholar(query: string, max: number): Promise<Paper[]> {
  const data = await getJson<any>(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${max}` +
      `&fields=title,authors,abstract,externalIds,openAccessPdf,year`,
    S2_KEY ? { "x-api-key": S2_KEY } : {},
  )
  return (data?.data ?? []).map((p: any) => {
    const ext = p.externalIds ?? {}
    const arxivId = ext.ArXiv
    return paper({
      title: p.title ?? "",
      authors: (p.authors ?? []).map((a: any) => a.name).filter(Boolean),
      abstract: p.abstract ?? "",
      doi: ext.DOI ?? "",
      url: p.openAccessPdf?.url || (arxivId ? `https://arxiv.org/abs/${arxivId}` : ext.DOI ? `https://doi.org/${ext.DOI}` : ""),
      source: p.paperId ? `s2:${p.paperId}` : "semantic_scholar",
      year: year4(String(p.year ?? "")),
    })
  })
}

// ── Crossref (JSON) ────────────────────────────────────────────────────────
async function searchCrossref(query: string, max: number): Promise<Paper[]> {
  const data = await getJson<any>(
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${max}` +
      `&select=${encodeURIComponent("title,author,abstract,DOI,issued")}`,
    { "User-Agent": UA },
  )
  return (data?.message?.items ?? []).map((item: any) => {
    const doi = item.DOI ?? ""
    return paper({
      title: (item.title ?? [])[0] ?? "",
      abstract: (item.abstract ?? "").replace(/<[^>]+>/g, ""),
      authors: (item.author ?? [])
        .map((a: any) => `${a.given ?? ""} ${a.family ?? ""}`.trim())
        .filter(Boolean),
      doi,
      url: doi ? `https://doi.org/${doi}` : "",
      source: doi ? `crossref:${doi}` : "crossref",
      year: year4(String(item.issued?.["date-parts"]?.[0]?.[0] ?? "")),
    })
  })
}

const SOURCES = {
  arxiv: searchArxiv,
  pubmed: searchPubmed,
  semantic_scholar: searchSemanticScholar,
  crossref: searchCrossref,
} as const

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Search query (keywords or a question)." }),
  source: Schema.optional(Schema.Literals(["all", "arxiv", "pubmed", "semantic_scholar", "crossref"])).annotate({
    description:
      "Which database to search: all (default) | arxiv (physics/CS/math) | pubmed (biomed) | semantic_scholar (cross-domain) | crossref (DOIs across publishers).",
  }),
  max: Schema.optional(Schema.Number).annotate({ description: "Max results per source (1-8, default 5)." }),
})

type Metadata = { source: string; count: number }

function format(papers: Paper[]): string {
  if (!papers.length) return "No results found."
  return papers
    .map((r, i) => {
      const lines = [`[${i + 1}] ${r.title || "(no title)"}${r.year ? ` (${r.year})` : ""}`]
      if (r.authors.length) lines.push(`    Authors: ${r.authors.slice(0, 5).join(", ")}${r.authors.length > 5 ? " et al." : ""}`)
      if (r.abstract) lines.push(`    Abstract: ${r.abstract.slice(0, 300)}${r.abstract.length > 300 ? "…" : ""}`)
      if (r.doi) lines.push(`    DOI: ${r.doi}`)
      if (r.url) lines.push(`    URL: ${r.url}`)
      lines.push(`    Source: ${r.source}`)
      return lines.join("\n")
    })
    .join("\n\n")
}

const DESCRIPTION = [
  "Search real academic literature across the free, keyless scholarly databases — arXiv, PubMed, Semantic Scholar, Crossref — and get back papers (title, authors, year, abstract, DOI, URL).",
  "Use this to ground research, experiments, and brainstorming in actual papers instead of from memory. Pick the source that fits the domain (arxiv for CS/physics/math, pubmed for biomedical, semantic_scholar/crossref for cross-domain), or 'all' to query every database.",
].join("\n")

export const AcademicSearchTool = Tool.define<typeof Parameters, Metadata, never>(
  "academic_search",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        yield* ctx.ask({ permission: "webfetch", patterns: ["*"], always: ["*"], metadata: {} })
        const source = params.source ?? "all"
        const max = Math.max(1, Math.min(MAX_RESULTS, Math.floor(params.max ?? 5)))
        const targets = source === "all" ? (Object.keys(SOURCES) as (keyof typeof SOURCES)[]) : [source]

        const settled = yield* Effect.promise(() =>
          Promise.all(
            targets.map((t) =>
              SOURCES[t](params.query, max)
                .then((r) => r)
                .catch(() => [] as Paper[]),
            ),
          ),
        )
        const papers = settled.flat().filter((p) => p.title)

        const output =
          papers.length === 0
            ? `No results for "${params.query}" (${source}). The databases may be unreachable, or try different keywords / another source.`
            : `# Academic search: ${params.query}\n\n${format(papers)}`

        return {
          title: `Academic search (${papers.length} result${papers.length === 1 ? "" : "s"})`,
          output,
          metadata: { source, count: papers.length },
        }
      }).pipe(Effect.orDie),
  }),
)
