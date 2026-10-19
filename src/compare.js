/**
 * "compare these tabs", "compare @[A] @[B] @[C]", "which of my tabs is cheapest": a table in the
 * chat with one row per tab and the attributes that matter for the question, plus a one-line verdict.
 * Each tab is read with the page-reading layer (transcripts, PDFs, Google Docs, main content).
 */
import { ask } from "./brain.js";
import { readTabs, tabsText, kindName } from "./pagetext.js";

/** Is a question about several tabs asking for a comparison (rather than "which tab mentions X")? */
export function isCompareRequest(text) {
  return /\b(?:compare|comparing|comparison|versus|vs\.?|difference|differences|differ|pros and cons|better|best|worse|worst|cheaper|cheapest|pricier|priciest|most|least|highest|lowest|fastest|slowest|biggest|largest|smallest|longest|shortest|newest|oldest|rank|recommend)\b/i.test(
    String(text || "").replace(/@\[[^\]]*\]/g, " "),
  );
}

const COMPARE_SCHEMA = {
  type: "object",
  properties: {
    attributes: { type: "array", items: { type: "string" }, description: "3 to 6 short column headings: the things worth comparing for this question (e.g. Price, Rating, Battery life)." },
    rows: {
      type: "array",
      description: "One per tab, in tab order.",
      items: {
        type: "object",
        properties: {
          tab: { type: "integer", description: "The tab number." },
          name: { type: "string", description: "Short name for what the tab is about (product, article, video), at most 5 words." },
          values: { type: "array", items: { type: "string" }, description: "One short value per attribute, copied from the tab's text; '—' when the tab doesn't say." },
        },
        required: ["tab", "name", "values"],
      },
    },
    verdict: { type: "string", description: "One or two plain sentences that answer the user's question using the comparison (which is best/cheapest/different and why)." },
  },
  required: ["attributes", "rows", "verdict"],
};

/** Rows from the model -> table cells, one row per tab that was read, in tab order. */
export function toCompareTable(data, tabs) {
  const attrs = (data?.attributes || []).map((a) => String(a).trim()).filter(Boolean).slice(0, 6);
  const byTab = new Map((data?.rows || []).map((r) => [Number(r.tab), r]));
  const rows = tabs.map((t) => {
    const r = byTab.get(t.n);
    const name = String(r?.name || t.title || t.url).trim().slice(0, 60);
    return [name, ...attrs.map((_, i) => String(r?.values?.[i] ?? "—").trim() || "—")];
  });
  return { columns: ["Tab", ...attrs], rows };
}

export async function compareTabs(pages, question, titles = null, context = "") {
  const tabs = await readTabs(pages, { titles, question, total: 40000, max: 8 });
  if (tabs.length < 2) throw new Error(titles?.length ? "I need at least two of those tabs open to compare" : "Open at least two pages to compare");
  const r = await ask({
    system:
      "You compare the user's open browser tabs. Read each tab's text and fill a comparison table: pick the attributes that " +
      "matter for the question, one row per tab, values copied exactly from that tab (numbers, prices, dates). Never invent values; " +
      "use '—' when a tab doesn't say. Keep values short (a few words). Then answer the question in the verdict. Plain text, no markdown.",
    text: `${context ? `Conversation so far:\n${context}\n\n` : ""}Open tabs:\n\n${tabsText(tabs)}\n\nThe user asks: ${question}`,
    schema: COMPARE_SCHEMA,
  });
  const table = toCompareTable(r.data, tabs);
  const kinds = tabs.map((t) => t.reading && kindName(t.reading.kind)).filter(Boolean);
  const asleep = tabs.filter((t) => !t.reading).map((t) => t.title);
  const note = [
    `Compared ${tabs.length} tabs${kinds.length ? ` (read ${[...new Set(kinds)].join(", ")})` : ""}.`,
    asleep.length ? `Couldn't read ${asleep.map((t) => `“${t}”`).join(", ")}; it may be asleep.` : "",
  ].filter(Boolean).join(" ");
  return { ...table, verdict: String(r.data.verdict || "").trim(), note, tabs: tabs.map((t) => t.title), read: tabs.length, model: r.modelLabel || r.model, ms: r.ms };
}
