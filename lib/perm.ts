/**
 * Cross-registration / "perm" link builder.
 *
 * Background: at the Claremont Colleges a student registers at their *home*
 * campus but may take courses taught at the other four. Courses carry a small
 * number of reserved cross-registration seats — HyperSchedule exposes this as
 * `permCount` — and a student needs a perm/permission form (sometimes plus
 * instructor or department consent) to claim one.
 *
 * The actual forms live behind each campus's SSO, so deep-linking *directly* to
 * a pre-filled form is only partly possible. This module therefore produces a
 * bundle: the right starting URL for the student's home campus, a pre-filled
 * email to the instructor for consent, and a paste-ready course block.
 *
 * ── MAINTAINERS ──────────────────────────────────────────────────────────
 * Every template below is editable without touching the UI. The five 5C
 * entries are pinned to each campus's confirmed primary student portal
 * (where the cross-registration / perm form lives); walk in behind SSO to the
 * perm form. `CGU` is not part of the 5C exchange and is marked
 * `needsVerification`. Anything set in CYCLE_PERM_LINKS_JSON (a JSON object
 * keyed by campus code) overrides these at runtime.
 */
import type { Section } from "./types";
import { SCHOOL_BY_CODE, type SchoolCode } from "./constants";
import { termLabel } from "./util";

export type PermTemplate = {
  /** Label shown on the button. */
  label: string;
  /** URL template. Supports {{department}} {{courseNumber}} {{suffix}} {{term}} {{instructor}} {{title}}. */
  url: string;
  /** Extra guidance shown under the button. */
  help: string;
  /** false = we could not confirm this destination resolves; surfaced in the UI. */
  verified: boolean;
};

export const PERM_TEMPLATES: Record<SchoolCode, PermTemplate> = {
  CM: {
    label: "CMC Perm / Cross-Registration form",
    url: "https://portal.claremontmckenna.edu/",
    help: "CMC: open the student portal (portal.claremontmckenna.edu) behind campus SSO, then find Cross-Registration → Permission (Perm). CMC students request perms for HMC/Pitzer/Pomona/Scripps courses during the cross-registration window.",
    verified: true,
  },
  HM: {
    label: "HMC Cross-Registration form",
    url: "https://portal.hmc.edu/ics/",
    help: "HMC: open the student portal (portal.hmc.edu ICS) behind campus SSO, then find Registration → 5C Cross-Registration (WebReg). Attach department/instructor consent when the listing requires it.",
    verified: true,
  },
  PZ: {
    label: "Pitzer Cross-Registration / Perm form",
    url: "https://mycampus2.pitzer.edu/ICS/",
    help: "Pitzer: student portal (mycampus2 ICS) → Registration → Cross-Registration Permission.",
    verified: true,
  },
  PO: {
    label: "Pomona 5C Exchange form",
    url: "https://my.pomona.edu/",
    help: "Pomona: open MyPomona (my.pomona.edu) behind campus SSO, then find 5C Exchange → Cross-Registration request. Pomona caps external courses per term, so check your exchange allowance first.",
    verified: true,
  },
  SC: {
    label: "Scripps Cross-Registration form",
    url: "https://mycampus.scrippscollege.edu/ICS/Portal_Homepage.jnz?portlet=Course_Search&screen=Advanced+Course+Search&screenType=next",
    help: "Scripps: open MyCampus (mycampus.scrippscollege.edu ICS) behind campus SSO, then find Registration → 5C Cross-Registration / Permission Form.",
    verified: true,
  },
  CG: {
    label: "CGU Registrar",
    url: "https://www.cgu.edu/academics/registrar/",
    help: "CGU students register through the CGU portal; 5C access is handled by the registrar's office.",
    verified: false,
  },
  UN: {
    label: "Registrar",
    url: "https://www.cmc.edu/registrar",
    help: "Set your home campus on your profile to get the right perm form.",
    verified: true,
  },
};

function overrides(): Partial<Record<SchoolCode, Partial<PermTemplate>>> {
  const raw = process.env.CYCLE_PERM_LINKS_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<Record<SchoolCode, Partial<PermTemplate>>>;
  } catch {
    return {};
  }
}

export function templateFor(homeSchool: string): PermTemplate {
  const code = (SCHOOL_BY_CODE[homeSchool]?.code ?? "UN") as SchoolCode;
  const base = PERM_TEMPLATES[code] ?? PERM_TEMPLATES.UN;
  return { ...base, ...(overrides()[code] ?? {}) };
}

/** Placeholders substituted into the URL template. */
export function permPlaceholders(s: Section): Record<string, string> {
  return {
    department: s.department,
    courseNumber: String(s.course_number),
    courseNumberPadded: String(s.course_number).padStart(3, "0"),
    suffix: s.suffix,
    section: String(s.section_number),
    affiliation: s.affiliation,
    term: s.term_id,
    title: s.title,
    instructor: s.instructors.map((i) => i.name).join(", "),
    school: s.school,
    credits: String(s.credits),
  };
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
    encodeURIComponent(vars[k] ?? ""),
  );
}

export type PermBundle = {
  needed: boolean;
  reason: string;
  /** Primary call-to-action. */
  formUrl: string;
  formLabel: string;
  help: string;
  needsLinkVerification: boolean;
  /** Seats the teaching campus has reserved for cross-reg, from HyperSchedule. */
  permSeats: number;
  seatsKnown: boolean;
  /** mailto: that pre-fills a consent request to the instructor. */
  consentMailto: string;
  /** Plain text block to paste into the registrar form. */
  pasteBlock: string;
  meetingText: string;
};

/** Does this student need a perm for this section? */
export function permNeededFor(homeSchool: string, s: Section): boolean {
  return s.school !== homeSchool;
}

export function buildPermBundle(homeSchool: string, s: Section): PermBundle {
  const tpl = templateFor(homeSchool);
  const vars = permPlaceholders(s);
  const url = fill(tpl.url, vars);
  const needed = permNeededFor(homeSchool, s);

  const meetingText = s.meetings.length
    ? s.meetings
        .map((m) => `${m.days} ${fmt(m.start_time)}–${fmt(m.end_time)}${m.locations ? ` (${m.locations})` : ""}`)
        .join("; ")
    : "TBA";

  const teaching = SCHOOL_BY_CODE[s.school]?.name ?? s.school;
  const home = SCHOOL_BY_CODE[homeSchool]?.name ?? homeSchool;
  const profs = s.instructors.map((i) => i.name).join(", ") || "TBA";

  const pasteBlock = [
    `Term:              ${termLabel(s.term_id)} (${s.term_id})`,
    `Course:            ${s.code_string}`,
    `Title:             ${s.title}`,
    `Teaching campus:   ${teaching}`,
    `Home campus:       ${home}`,
    `Instructor:        ${profs}`,
    `Credits:           ${s.credits} (campus scale) / ${s.credits_5c} (5C scale)`,
    `Meets:             ${meetingText}`,
    `Perm seats listed: ${s.perm_count}`,
    `Status:            ${s.status === "O" || s.status === "R" ? "Open" : "Closed"}`,
  ].join("\n");

  const subject = `Permission to enroll: ${s.code_string} — ${s.title}`;
  const body = [
    `Dear ${s.instructors[0]?.name ?? "Professor"},`,
    ``,
    `I am a ${home} student hoping to take your ${termLabel(s.term_id)} course`,
    `${s.code_string} (${s.title}) via 5C cross-registration, and I need a perm /`,
    `instructor permission to claim a cross-registration seat.`,
    ``,
    `Course details:`,
    pasteBlock.replace(/^/gm, "  "),
    ``,
    `My name and student ID are below. Thank you for considering my request.`,
    ``,
    `— `,
  ].join("\n");

  return {
    needed,
    reason: needed
      ? `Taught at ${teaching}, not your home campus (${home}) — you need a cross-registration perm.`
      : `Taught at your home campus (${home}) — you register for this directly, no perm needed.`,
    formUrl: url,
    formLabel: tpl.label,
    help: tpl.help,
    needsLinkVerification: !tpl.verified,
    permSeats: s.perm_count,
    seatsKnown: s.perm_count > 0,
    consentMailto: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    pasteBlock,
    meetingText,
  };
}

function fmt(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const ampm = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")}${ampm}`;
}
