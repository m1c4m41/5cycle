# Brief: expanding 5Cycle major/minor requirement sets from official catalogs

You are contributing **one school's** major + minor requirement sets to 5Cycle, a Next.js +
SQLite course planner for the Claremont Colleges (repo root: `/Users/micamai/csci6/5cycle`).

Requirement definitions are editable JSON in `data/requirements/*.json`, mirrored into SQLite
by `loadRequirementFiles()` in `lib/requirements.ts`. Your job is to turn a school's official
catalog into one new JSON file of requirement sets that the planner's checklist can match
against real catalog sections.

## Hard rules (read twice)

1. **Write ONLY the files you are told you own.** Other agents are working in this repo at the
   same time on other schools. Never edit `lib/`, `app/`, `components/`, `actions/`,
   `package.json`, `data/db.sqlite`, `data/requirements/majors.json`, `data/requirements/ge.json`,
   or another school's files.
2. **Never query the DB with anything but read-only SELECTs** (`node scripts/probe.mjs "SELECT …"`).
   Do NOT run `npm run *`, `next build`, the dev server, or any loader that writes SQLite. The
   orchestrator loads your JSON when you are done.
3. **No invented requirements.** Every group must be traceable to text you actually fetched from
   the school's official catalog/department page, and every set must carry
   `"source": "<exact URL you scraped>"` and `"verified": false`. If the catalog is vague or you
   cannot fetch a program, emit fewer groups / skip the program and say so in your report.
4. **Matchers must reference courses that exist in our synced catalog** — see the department
   universe below. A rule that can never match a real section is worse than no rule: it makes the
   checklist permanently red. Prefer a department+number range over a brittle exact code.

## Deliverable file format

Write `data/requirements/majors-<CODE>.json` (CODE = `pz` | `cm` | `scr` | `po` | `hm`):

```jsonc
{
  "_comment": ["one-paragraph provenance note: which catalog edition, which URLs, what you skipped"],
  "sets": [
    {
      "id": "major-PZ-ANTH",              // major-<CODE>-<SLUG> / minor-<CODE>-<SLUG>, CODE is the campus code
      "school": "PZ",                     // campus code ONLY: PO | CM | HM | PZ | SC
      "kind": "major",                    // "major" | "minor"
      "name": "Anthropology (BA) — Pitzer",
      "totalCredits": 12,                 // number of courses or credits if the catalog states it, else omit
      "verified": false,
      "source": "https://catalog.pitzer.edu/preview_entity.php?catoid=27&ent_oid=888",
      "notes": "1–2 sentences of plain-language structure, straight from the bulletin.",
      "groups": [
        {
          "name": "Lower-division foundation",
          "notes": "What the catalog requires, condensed.",
          "minCourses": 2,                // omit only if you set minCredits
          "level": "intro",               // "intro" | "upper" | "any" (optional)
          "required": true,               // false = optional group, excluded from % complete
          "departments": [{ "department": "ANTH", "max": 99 }],
          // plus any of: "courses": ["ECON 051 PZ"], "area": ["5SOC"],
          // "titleKeywords": ["thesis"], "matchers": [ …raw matcher… ],
          // "exclude": { "courses": […], "departments": […], "area": […] }
        }
      ]
    }
  ]
}
```

Group sugar compiles to OR-of-rules: `area`, `courses`, `departments`, `titleKeywords`, `any`,
`matchers` all add positive rules; `exclude` wraps each positive rule in `AND NOT(…)`. Use
`minCourses` for "N courses", `minCredits` for credit-based requirements (our 5C credit scale:
a full course = 1.0, HMC publishes 3.0 per course so HMC-side ranges are 3-credit each).

## Matcher semantics (exactly as `lib/requirements.ts` implements them)

- `{"type":"course","codes":["ECON 051 PZ"]}` — compared against `sections.course_code`, which is
  `"<DEPT> <NUMBER> <AFFILIATION>"`, e.g. `MATH 012 HM`, `ANTH 140 PZ`, `CSCI 021 CM`.
  Number is unpadded in the matcher (`ECON 51 PZ` also works), and `"ECON 51"` or `"ECON 51*"`
  match any affiliation. **The affiliation suffix matters when the catalog distinguishes
  campuses** — a Pitzer bulletin saying `MATH 012 HM` means that HMC listing.
- `{"type":"department","department":"ECON","min":100,"max":199,"schools":["PZ"]}` — matches
  `sections.department` with an optional course-number range and optional **teaching-campus**
  filter (`schools`). Omit `schools` when the major accepts the course from any 5C campus
  (true for most 5C cross-registrable requirements).
- `{"type":"area","codes":["3HUS"]}` — registrar course-area/GE designation. Prefix with `*` for
  wildcards (`"3*"`). Use only when the bulletin names a specific distribution code.
- `{"type":"titleKeyword","keywords":["thesis","senior seminar"]}` — title+description contains.
- Combinators: `{"type":"and"|"or","children":[…]}`, `{"type":"not","child":…}`.

## Department universe (the only codes that can possibly match)

`data/requirements/departments.json` is a JSON object keyed by teaching campus code
(`PO CM HM PZ SC CG`), each a map of `department → { numbers: […course numbers seen…],
affs: { "PZ": sectionCount, … }, sections }`. It was generated from 17,694 synced sections
(FA2023–SP2027). **Read it first.** When a bulletin lists course codes, translate each one:

- confirm the department code exists (case-sensitive, e.g. `ORST` not `ENVS`),
- confirm the number exists in `numbers` for that campus (or in the `affs` of the campus that
  teaches it),
- then decide exact-`courses` vs a `departments` range from how the bulletin phrases it
  (named required courses → `courses`; "two upper-division electives" → `departments` with a range).

Sanity-check the department codes you rely on with read-only SQL, e.g.
`node scripts/probe.mjs "SELECT DISTINCT department FROM sections WHERE school='PZ' ORDER BY 1"`
and
`node scripts/probe.mjs "SELECT id,title,department,course_number,school FROM sections WHERE department='ANTH' AND course_number>=100 LIMIT 5"`.

## Don't collide with existing sets

`data/requirements/majors.json` already ships these ids (read the file; keep its style):
`major-CM-ECON minor-CM-ECON major-CM-GOVT major-CM-PSYC minor-CM-PSYC major-CM-CSCI major-CM-MATH
major-CM-IR major-HM-CSCI major-HM-ENGR minor-HM-MATH major-PO-CSCI minor-PO-CSCI major-PO-ECON
major-PZ-ORST minor-PZ-SOC major-SC-CSCI minor-SC-DS major-PZ-ANTH major-SC-POLI minor-CM-PHI`.
Re-deriving one of those from the catalog is welcome — give it the **same id** so the loader
upgrades it in place, and make it strictly better (more groups, real course codes). Never reuse an
id for a different program.

Coverage goal: **every major and every minor** your school's catalog lists. Deep, faithful groups
for the biggest programs beat shallow ones everywhere, but aim for complete coverage of the
major list. If a school offers 40 majors + 15 minors, ship 55 sets.

## Validation you must run before reporting done

Write and run `scripts/check-sets-<CODE>.mjs` (you own that filename):

1. `JSON.parse` your file; assert ids are unique, `school` is a valid campus code, every set has
   ≥2 groups, every group has ≥1 positive rule and either `minCourses` or `minCredits`.
2. For every `courses` code, assert a section exists:
   `SELECT COUNT(*) FROM sections WHERE course_code = ?` (remember matcher codes are unpadded,
   DB codes are zero-padded to 3: `ECON 51 PZ` → `ECON 051 PZ`). Report the % that resolve.
3. **Match smoke test**: pick 400 real sections at random from your school
   (`node scripts/probe.mjs "SELECT id,course_code,department,course_number,school,areas FROM sections WHERE school='<CODE>' LIMIT 400"`),
   reimplement the tiny matcher in your check script (copy the semantics above — it's ~40 lines),
   and report for each set how many of those sections match at least one group. **Flag every set
   that matches 0 sections** — that's a broken set, fix it before reporting.
4. Report per-set group counts and any program you deliberately skipped.

Do not leave `scripts/check-sets-<CODE>.mjs` broken; it is part of the deliverable.

## Network tooling

`node scripts/fetch-page.mjs "<url>" <outfile>` renders a page in headless Chrome via CDP and
writes the DOM. Use it for anything behind the AWS WAF challenge (plain curl gets `HTTP 202` with
an empty body from `catalog.pitzer.edu`, `catalog.claremontmckenna.edu`,
`catalog.scrippscollege.edu`). Always pass a **unique** port/profile so parallel agents don't
fight, e.g. `CDP_PORT=9341 CDP_PROFILE=/tmp/fetch-pz node scripts/fetch-page.mjs …`.
Ordinary `.edu` WordPress/Drupal pages work with `curl -sL -A "Mozilla/5.0 … Chrome/122 …"`.
For Modern Campus Catalog™ sites: `preview_entity.php?catoid=N&ent_oid=N` (a field group's
major+minor requirements), `preview_program.php?catoid=N&poid=N` (an interdisciplinary program),
`&print` on any `content.php` URL gives a cleaner body. Pitzer's catoids: `27` = 2023-24 (the
edition our catalog data covers), `36` = 2026-27.

## Save your scrape

Write the raw text you extracted to `data/requirements/raw/<CODE>.json` as
`[{ "name", "url", "kind": "major"|"minor", "text" }]` so a human can audit the mapping later,
plus the scraper that produced it as `scripts/scrape-<CODE>.mjs` (you own both filenames).

## Report back

≤30 lines: sets shipped (majors/minors), catalog edition + URL(s), the courses-matcher hit rate
from step 2, any set matching 0 sections, and anything the catalog made impossible to encode.
