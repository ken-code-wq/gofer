/**
 * "copy the table" / "copy all invoice numbers as a table" / "export the bills as csv".
 * A plain "the table" request reads the page's own <table> (or grid) with no model call; anything
 * more specific asks the brain to pull the rows out of the page text. The result goes to the
 * clipboard as tab-separated text (pastes into cells in Sheets, Excel and Numbers) and, when asked
 * for csv / export / download, to a .csv file in Downloads.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERB = String.raw`(?:copy|extract|export|get|grab|pull|download|save)`;
const AS_TABLE = String.raw`\b(?:as|into|in|to)\s+(?:a\s+|an\s+)?(?:table|csv|spreadsheet|sheet|excel|tsv|columns)\b`;
const PLAIN = new RegExp(String.raw`^${VERB}\s+(?:the\s+|this\s+)?(?:whole\s+|entire\s+)?(?:table|grid|list)(?:\s+(?:on|from)\s+(?:the|this)\s+page)?(?:\s+${AS_TABLE.slice(2)})?$`, "i");
const SPECIFIC = new RegExp(String.raw`^${VERB}\s+(.+?)\s*${AS_TABLE}`, "i");
const ALL = new RegExp(String.raw`^(?:copy|extract|export)\s+(?:all|every|each)\s+(?:the\s+)?(.+)$`, "i");

/** null, or { plain: boolean, what, file: boolean } */
export function parseTableRequest(text) {
  const t = String(text || "").trim().replace(/[.!]+$/, "");
  const file = /\b(csv|export|download|save)\b/i.test(t);
  if (PLAIN.test(t)) return { plain: true, what: "the table", file };
  let m = t.match(SPECIFIC);
  if (m) return { plain: /^(?:the\s+|this\s+)?(?:whole\s+)?(?:table|grid)$/i.test(m[1]), what: m[1], file };
  m = t.match(ALL);
  if (m && !/\b(?:text|of it)$/i.test(m[1])) return { plain: false, what: `all ${m[1]}`, file };
  return null;
}

/** The largest visible table or ARIA grid on the page, as { columns, rows }, or null. */
export async function domTable(page) {
  return page
    .evaluate(() => {
      const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const vis = (el) => el.getBoundingClientRect().height > 0;
      const tables = [...document.querySelectorAll("table, [role=table], [role=grid]")].filter(vis);
      let best = null;
      for (const t of tables) {
        const rowEls = [...t.querySelectorAll("tr, [role=row]")].filter((r) => r.closest("table, [role=table], [role=grid]") === t && vis(r));
        const rows = rowEls.map((r) => [...r.querySelectorAll("th, td, [role=columnheader], [role=cell], [role=gridcell], [role=rowheader]")].map((c) => clean(c.innerText)));
        const body = rows.filter((r) => r.some(Boolean));
        if (body.length < 2) continue;
        if (!best || body.length * body[0].length > best.length * best[0].length) best = body;
      }
      if (!best) return null;
      const [columns, ...rows] = best;
      return { columns, rows };
    })
    .catch(() => null);
}

const cellTSV = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
export const toTSV = ({ columns, rows }) => [columns, ...rows].map((r) => r.map(cellTSV).join("\t")).join("\n");
const cellCSV = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCSV = ({ columns, rows }) => [columns, ...rows].map((r) => r.map(cellCSV).join(",")).join("\n");

export function saveCSV(table, title = "table") {
  const dir = process.env.VB_SHOTS_DIR || path.join(os.homedir(), "Downloads");
  fs.mkdirSync(dir, { recursive: true });
  const base = String(title).replace(/[^\w\s.-]+/g, "").trim().slice(0, 50) || "table";
  let file = path.join(dir, `${base}.csv`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} ${i}.csv`);
  fs.writeFileSync(file, toCSV(table));
  return file;
}
