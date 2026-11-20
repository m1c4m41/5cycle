"use client";
/**
 * The "Prerequisites:" sentence of a class card, with every course code in it
 * turned into a hover/click pop-out showing that course's name and description.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { lookupCourse, type CourseInfo } from "@/actions/course-info";

// Departments written out in words ("Physics 51", "Computer Science 5").
const ALIASES: Record<string, string> = {
  "computer science": "CSCI", "political science": "POLI", "politics": "POLI", "environmental analysis": "EA",
  "physics": "PHYS", "astronomy": "ASTR", "astrophysics": "ASTR", "mathematics": "MATH", "math": "MATH",
  "chemistry": "CHEM", "biology": "BIOL", "economics": "ECON", "psychology": "PSYC", "history": "HIST",
  "philosophy": "PHIL", "english": "ENGL", "literature": "LIT", "sociology": "SOC", "anthropology": "ANTH",
  "geology": "GEOL", "neuroscience": "NEUR", "engineering": "ENGR", "government": "GOVT", "music": "MUS",
  "theatre": "THEA", "theater": "THEA", "dance": "DANC", "french": "FREN", "spanish": "SPAN",
  "german": "GERM", "chinese": "CHIN", "japanese": "JAPN", "korean": "KORE", "russian": "RUSS",
  "italian": "ITAL", "latin": "LATN", "greek": "GREK", "education": "EDUC", "religious studies": "RLST",
  "classics": "CLAS", "geography": "GEOG", "management": "MGT", "writing": "WRIT", "statistics": "MATH",
  "art history": "ARHI", "studio art": "ART", "art": "ART",
};
const ALIAS_RE = Object.keys(ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/ /g, "\\s+"))
  .join("|");

// "BIOL 041E PO", "CSCI 060", "MATH31", "CHEM 014L KS", mixed case ("Art 110"),
// or the department spelled out ("Physics 51").
const CODE = new RegExp(
  `\\b(${ALIAS_RE}|[A-Za-z]{2,5})\\s?0*(\\d{1,3})([A-Z]{0,3})\\b(?:\\s+(PO|PZ|CM|HM|SC|KS|JT|JP|CG)\\b)?`,
  "gi",
);

// Ordinary words that can sit in front of a number ("Grade 3", "level 200").
const NOT_A_DEPT = new Set(
  "grade year level units unit part term week weeks page class hours hour sec section group tier phase step stage age ages years".split(" "),
);

const cache = new Map<string, CourseInfo>();

function CourseCode({ dept, num, suffix, aff, text }: { dept: string; num: number; suffix: string; aff: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<CourseInfo | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = `${dept}|${num}|${suffix}|${aff}`;

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(true);
    const hit = cache.get(key);
    if (hit) return setInfo(hit);
    lookupCourse(dept, num, suffix, aff)
      .then((r) => {
        cache.set(key, r);
        setInfo(r);
      })
      .catch(() => setInfo({ found: false, code: text }));
  };
  const hideSoon = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 180);
  };

  // Close on outside click / Escape (touch devices open it by tapping).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={root} className="relative inline-block" onMouseEnter={show} onMouseLeave={hideSoon}>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : show())}
        onFocus={show}
        className="font-semibold text-brand-700 underline decoration-dotted underline-offset-2 hover:text-brand-800"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {text}
      </button>
      {open && (
        <span
          role="dialog"
          className="absolute left-0 top-full z-40 mt-1 block w-72 max-w-[80vw] rounded-lg border border-ink-200 bg-white p-3 text-left text-xs font-normal normal-case leading-relaxed text-ink-700 shadow-lg"
          onMouseEnter={() => timer.current && clearTimeout(timer.current)}
          onMouseLeave={hideSoon}
        >
          {!info ? (
            <span className="text-ink-400">Loading…</span>
          ) : info.found ? (
            <>
              <span className="block text-sm font-bold text-ink-900">{info.title}</span>
              <span className="block font-mono text-[11px] text-ink-500">{info.code}</span>
              <span className="mt-1.5 block text-ink-700">
                {info.description || "No description in the catalog."}
              </span>
              <Link href={`/catalog?q=${encodeURIComponent(`${dept} ${num}`)}`} className="link mt-2 inline-block text-xs">
                Find it in the catalog →
              </Link>
            </>
          ) : (
            <span className="text-ink-500">
              <span className="font-semibold text-ink-700">{info.code}</span> isn&rsquo;t in the catalog for any
              loaded term.
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function PrereqText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CODE.lastIndex = 0;
  while ((m = CODE.exec(text))) {
    const word = m[1].replace(/\s+/g, " ").toLowerCase();
    const dept = ALIASES[word] ?? m[1].toUpperCase();
    if (!ALIASES[word] && m[1] !== m[1].toUpperCase() && NOT_A_DEPT.has(word)) continue;
    // With the i flag the suffix/affiliation could be lowercase words ("Art 110 and"): only keep uppercase ones.
    const suffix = /^[A-Z]+$/.test(m[3] ?? "") ? m[3] : "";
    const aff = /^(PO|PZ|CM|HM|SC|KS|JT|JP|CG)$/.test(m[4] ?? "") ? m[4] : "";
    if ((m[3] ?? "") !== suffix && (m[3] ?? "") !== "") continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <CourseCode key={m.index} dept={dept} num={Number(m[2])} suffix={suffix} aff={aff} text={m[0]} />,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
