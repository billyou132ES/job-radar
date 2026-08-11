#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scannerDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scannerDir, "..");
const dataDir = join(rootDir, "data");
const REQUEST_DELAY_MS = 400;
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 20;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/127.0 Safari/537.36";

const relevantTerms = [
  "marketing", "mercadeo", "trade", "brand", "marca", "publicidad",
  "comunicaciones", "comercial", "category", "shopper", "consumer",
  "digital", "eventos", "insights", "ventas", "generador de demanda"
];
const seniorTerms = [
  "director", "gerente", "head", "vp", "vice president", "senior manager",
  "sr manager", "lead"
];
const juniorTerms = [
  "analista", "analyst", "asistente", "assistant", "auxiliar", "coordinador",
  "coordinator", "junior", "jr", "trainee", "intern", "practicante",
  "aprendiz", "graduate", "specialist", "especialista"
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const normalize = (value = "") => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("es");

function bogotaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function matchesTitle(title) {
  const value = normalize(title);
  return relevantTerms.some((term) => value.includes(term));
}

function classifyLevel(title) {
  const value = normalize(title);
  if (seniorTerms.some((term) => value.includes(term))) return "senior";
  if (juniorTerms.some((term) => value.includes(term))) return "junior";
  return "mid";
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

let lastRequestAt = 0;
async function workdayRequest(company, body) {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS - elapsed);

  const endpoint = `https://${company.workday.host}/wday/cxs/` +
    `${company.workday.tenant}/${company.workday.site}/jobs`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  lastRequestAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "user-agent": USER_AGENT
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function findColombiaFacet(facets) {
  let found = null;
  function visit(value, inCountryFacet = false) {
    if (found || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inCountryFacet);
      return;
    }
    if (typeof value !== "object") return;
    const key = value.facetParameter ?? value.id ?? value.name ?? value.label;
    const countryContext = inCountryFacet || key === "locationCountry";
    if (countryContext && normalize(value.descriptor) === "colombia" && value.id) {
      found = value.id;
      return;
    }
    for (const child of Object.values(value)) visit(child, countryContext);
  }
  visit(facets);
  return found;
}

async function fetchAllColombia(company, facetId) {
  const postings = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const payload = await workdayRequest(company, {
      // facetId null ⇒ sitio 100% Colombia (allColombia): traer todo sin facet
      appliedFacets: facetId ? { locationCountry: [facetId] } : {},
      limit: PAGE_SIZE,
      offset,
      searchText: ""
    });
    const page = Array.isArray(payload.jobPostings) ? payload.jobPostings : [];
    total = Number.isFinite(payload.total) ? payload.total : page.length;
    postings.push(...page);
    if (page.length === 0) break;
    offset += PAGE_SIZE;
  }
  return postings.slice(0, total);
}

async function fetchFallbackColombia(company) {
  const payload = await workdayRequest(company, {
    appliedFacets: {},
    limit: PAGE_SIZE,
    offset: 0,
    searchText: "colombia"
  });
  return (payload.jobPostings ?? []).filter((posting) => {
    const location = normalize(posting.locationsText);
    return location.includes("colombia") || location.includes("bogot");
  });
}

function postingUrl(company, externalPath) {
  const base = new URL(company.careersUrl);
  let path = base.pathname.replace(/\/$/, "");
  if (base.hostname.endsWith("myworkdayjobs.com")) path = `/${company.workday.site}`;
  return `${base.origin}${path}${externalPath.startsWith("/") ? "" : "/"}${externalPath}`;
}

function normalizePosting(company, posting, seen, today) {
  const externalPath = posting.externalPath ?? "";
  const sourceId = posting.bulletFields?.[0] || shortHash(externalPath);
  const id = `${company.workday.tenant}:${sourceId}`;
  if (!seen[id]) seen[id] = today;
  return {
    id,
    company: company.name,
    title: posting.title ?? "Cargo sin título",
    url: postingUrl(company, externalPath),
    location: posting.locationsText ?? "Ubicación no indicada",
    postedOn: posting.postedOn ?? "",
    level: classifyLevel(posting.title ?? ""),
    firstSeen: seen[id]
  };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

const companies = await readJson(join(dataDir, "companies.json"), []);
const tierOne = companies.filter((company) => company.tier === 1 && company.workday);
const seen = await readJson(join(dataDir, "seen.json"), {});
const today = bogotaDate();
const jobs = [];
const report = [];
let responded = 0;

for (const company of tierOne) {
  try {
    const discovery = await workdayRequest(company, {
      appliedFacets: {}, limit: 1, offset: 0, searchText: ""
    });
    const colombiaFacetId = findColombiaFacet(discovery.facets);
    let postings;
    let status;
    if (company.allColombia) {
      postings = await fetchAllColombia(company, null);
      status = "ok";
    } else if (colombiaFacetId) {
      postings = await fetchAllColombia(company, colombiaFacetId);
      status = "ok";
    } else {
      postings = await fetchFallbackColombia(company);
      status = postings.length > 0 ? "ok" : "no-colombia-facet";
    }
    responded += 1;
    const matches = postings.filter((posting) => matchesTitle(posting.title));
    jobs.push(...matches.map((posting) => normalizePosting(company, posting, seen, today)));
    report.push({
      name: company.name,
      status,
      colombiaPostings: postings.length,
      matches: matches.length
    });
  } catch (error) {
    const detail = error.name === "AbortError" ? "Timeout después de 20 s" : error.message;
    report.push({
      name: company.name,
      status: "error",
      colombiaPostings: 0,
      matches: 0,
      error: detail
    });
  }
}

jobs.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.company.localeCompare(b.company));
await writeJsonAtomic(join(dataDir, "seen.json"), seen);
await writeJsonAtomic(join(dataDir, "jobs.json"), {
  generatedAt: new Date().toISOString(),
  jobs
});
await writeJsonAtomic(join(dataDir, "scan-report.json"), report);

console.table(report.map((item) => ({
  empresa: item.name,
  status: item.status,
  "vacantes CO": item.colombiaPostings,
  matches: item.matches
})));

const successRate = tierOne.length === 0 ? 1 : responded / tierOne.length;
if (successRate < 0.7) process.exitCode = 1;
