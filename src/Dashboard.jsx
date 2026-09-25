import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  LayoutDashboard, Wallet, ReceiptText, FileBarChart2, Download,
  Settings as SettingsIcon, Plus, X, Pencil, Trash2, AlertTriangle,
  CheckCircle2, Search, TrendingUp, TrendingDown, Eye, Menu,
  ChevronRight, RotateCcw, Info, FileText, Building2
} from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip } from "recharts";
import { createWorker } from "tesseract.js";
import { STATIC_HISTORY } from "./historyData.js";
import { HISTORICAL_EXPENSES } from "./historicalExpenses.js";

/* ---------------------------------- THEME ---------------------------------- */
const C = {
  sidebar: "#0A0A0A",
  sidebarActive: "#1F1F1F",
  sidebarText: "#A3A3A3",
  sidebarMuted: "#6B6B6B",
  bg: "#F7F7F7",
  card: "#FFFFFF",
  border: "#E5E5E5",
  text: "#0A0A0A",
  muted: "#6B6B6B",
  green: "#0C2B66",
  greenLight: "#E7ECF5",
  amber: "#C8791E",
  amberLight: "#FBF1E0",
  red: "#CB3B32",
  redLight: "#FBEAE8",
  blue: "#2C5AA0",
  purple: "#C68A5D",
  accent: "#F3D5BA",
};
const CHART_COLORS = ["#0C2B66", "#C68A5D", "#6B6B6B", "#C8791E", "#A3A3A3", "#CB3B32", "#0A0A0A", "#3F3F46"];

/* ---------------------------------- HELPERS ---------------------------------- */
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return `${String(d.getDate()).padStart(2,"0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
// Portal-wide "hide amounts" toggle — flips to show 0 everywhere instead of real figures.
// Set synchronously from DashboardApp's render body so it's current before children render.
let HIDE_AMOUNTS = false;
const fmtPKR = (n) => HIDE_AMOUNTS ? "PKR 0" : `PKR ${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (used, budget) => (budget > 0 ? (used / budget) * 100 : 0);
const uid = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const todayISO = () => new Date().toISOString().slice(0, 10);

/* ---------------------------------- RECEIPT OCR PARSING ---------------------------------- */
// Best-effort parsing of raw OCR text from a receipt/invoice image. No API calls —
// runs entirely in the browser via tesseract.js. Always let the user review/correct
// the filled fields, since OCR on receipts is never 100% reliable.
function parseReceiptText(rawText) {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const result = { vendor: "", amount: "", date: "", description: "" };

  // --- Vendor: first line that has real letters and isn't just numbers/symbols ---
  for (const line of lines.slice(0, 6)) {
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    if (letters >= 3 && !/^(receipt|invoice|tax invoice|cash memo)$/i.test(line)) {
      result.vendor = line.replace(/[^A-Za-z0-9&.,'\-\s]/g, "").trim().slice(0, 60);
      break;
    }
  }

  // --- Amount: prefer a line with total-like keywords, else the largest number found ---
  const numberPattern = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g;
  const totalKeywordLine = lines.find((l) =>
    /(grand\s*total|net\s*total|total\s*amount|amount\s*due|balance\s*due|^total\b)/i.test(l) &&
    !/sub\s*total/i.test(l)
  );
  const pickLargest = (text) => {
    const matches = text.match(numberPattern) || [];
    const nums = matches.map((m) => parseFloat(m.replace(/,/g, ""))).filter((n) => !isNaN(n) && n > 0);
    return nums.length ? Math.max(...nums) : null;
  };
  let amount = totalKeywordLine ? pickLargest(totalKeywordLine) : null;
  if (amount === null) amount = pickLargest(rawText);
  if (amount !== null) result.amount = amount;

  // --- Date: common numeric formats, normalized to YYYY-MM-DD ---
  const isoMatch = rawText.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  const dmyMatch = rawText.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    result.date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  } else if (dmyMatch) {
    let [, d, m, y] = dmyMatch;
    if (y.length === 2) y = `20${y}`;
    if (Number(d) <= 31 && Number(m) <= 12) {
      result.date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // --- Description: extract item/product lines with quantities (e.g. "2x Widget, 1x Gadget") ---
  const SKIP_LINE = /^(total|sub\s*total|grand\s*total|net\s*total|amount\s*due|balance\s*due|tax|vat|gst|change|cash|card|credit|debit|discount|qty|quantity|item|description|price|rate|amount|no\.?|sr\.?|receipt|invoice|tax\s*invoice|cash\s*memo|date|time|cashier|thank|welcome|please|visit|tel|phone|address|www\.|http)/i;
  const numberOnly = /^[\d.,\-\s]+$/;

  const items = [];
  for (const line of lines) {
    if (line === result.vendor) continue;
    if (SKIP_LINE.test(line)) continue;
    if (numberOnly.test(line)) continue;
    if (!/[A-Za-z]{3,}/.test(line)) continue; // needs a real product name
    numberPattern.lastIndex = 0;
    if (!numberPattern.test(line)) continue; // needs a price on the line
    numberPattern.lastIndex = 0; // reset stateful global regex

    let qty = 1;
    let name = line;

    // "2 x Widget Name   500" or "2X Widget"
    let m = line.match(/^(\d{1,3})\s*[xX]\s*(.+)/);
    if (m) {
      qty = parseInt(m[1], 10);
      name = m[2];
    } else {
      // "Widget Name x2   500" or "Widget Name X 2"
      m = line.match(/(.+?)\s*[xX]\s*(\d{1,3})\b/);
      if (m) {
        qty = parseInt(m[2], 10);
        name = m[1];
      } else {
        // "2  Widget Name   250.00   500.00" — leading small qty then name
        m = line.match(/^(\d{1,2})\s+([A-Za-z].+)/);
        if (m) {
          qty = parseInt(m[1], 10);
          name = m[2];
        }
      }
    }

    // Strip trailing prices/numbers and stray symbols to isolate the item name.
    name = name.replace(numberPattern, "").replace(/[^A-Za-z0-9&.,'\-\s]/g, "").replace(/\s{2,}/g, " ").trim();
    if (name.length < 3) continue;
    items.push({ qty: qty > 0 && qty < 100 ? qty : 1, name: name.slice(0, 40) });
    if (items.length >= 6) break; // keep the description readable
  }

  result.description = items.length
    ? items.map((it) => `${it.qty}x ${it.name}`).join(", ")
    : (result.vendor ? `Purchase from ${result.vendor}` : (lines.find((l) => /[A-Za-z]{3,}/.test(l) && l !== result.vendor)?.slice(0, 60) || ""));

  return result;
}

/* ---------------------------------- BUDGET DATA ---------------------------------- */
// Real per-segment Budget + already-Exhausted amounts, taken directly from the company's
// "Budget" tab (Google Sheet). "priorExhausted" is spend already recorded in that sheet
// BEFORE this dashboard existed — new expenses added here are added on top of it, not
// instead of it, so totals stay accurate with the real sheet.
const SEGMENT_BUDGETS = {
  "REFRESHMENTS (TEA, COFFEE, ETC.)": {
    "Supplies - PK": { budget: 12123502, priorExhausted: 0 },
    "Vending machines rent": { budget: 910800, priorExhausted: 0 },
  },
  "OFFICE SUPPLIES": {
    "Janitorial expenses": { budget: 2630921, priorExhausted: 0 },
    "Kitchen expenses": { budget: 150940, priorExhausted: 0 },
    "Office supplies": { budget: 50365, priorExhausted: 0 },
    "Drinking water": { budget: 2718810, priorExhausted: 0 },
  },
  "MISCELLANEOUS": {
    "Postage and Delivery": { budget: 12000, priorExhausted: 0 },
    "Stationery": { budget: 235950, priorExhausted: 0 },
    "Printing and Reproduction": { budget: 200000, priorExhausted: 0 },
    "Fare allowance": { budget: 333840, priorExhausted: 0 },
    "Entertainment": { budget: 572840, priorExhausted: 0 },
    "Other Expenses": { budget: 6000, priorExhausted: 0 },
    "Daily meals": { budget: 400000, priorExhausted: 0 },
  },
  "OTHERS": {
    "Other Expenses": { budget: 0, priorExhausted: 0 },
  },
  "REPAIRS & MAINTENANCE": {
    "Building": { budget: 0, priorExhausted: 0 },
    "General Maintenance": { budget: 0, priorExhausted: 0 },
    "R&M - AC and Appliances": { budget: 0, priorExhausted: 0 },
    "R&M - Electronics (LEDs, etc.)": { budget: 0, priorExhausted: 0 },
    "R&M - Furnitures and Fixtures": { budget: 0, priorExhausted: 0 },
    "R&M - Equipments Admin": { budget: 0, priorExhausted: 0 },
  },
};
const sumSegmentBudgets = (headerName) => Object.values(SEGMENT_BUDGETS[headerName] || {}).reduce((s, seg) => s + seg.budget, 0);
const sumSegmentPriorExhausted = (headerName) => Object.values(SEGMENT_BUDGETS[headerName] || {}).reduce((s, seg) => s + (seg.priorExhausted || 0), 0);

const SEED_HEADERS = [
  { id: "h1", name: "REFRESHMENTS (TEA, COFFEE, ETC.)", budget: sumSegmentBudgets("REFRESHMENTS (TEA, COFFEE, ETC.)"), startDate: "2026-07-20", endDate: "", status: "Active" },
  { id: "h2", name: "OFFICE SUPPLIES", budget: sumSegmentBudgets("OFFICE SUPPLIES"), startDate: "2026-07-20", endDate: "", status: "Active" },
  { id: "h3", name: "MISCELLANEOUS", budget: sumSegmentBudgets("MISCELLANEOUS"), startDate: "2026-07-20", endDate: "", status: "Active" },
  { id: "h4", name: "REPAIRS & MAINTENANCE", budget: sumSegmentBudgets("REPAIRS & MAINTENANCE"), startDate: "2026-07-20", endDate: "", status: "Active" },
  { id: "h6", name: "OTHERS", budget: 0, startDate: "2026-07-20", endDate: "", status: "Active" },
];

// Segment (sub-category) options per Budget Header — matches the Google Sheet's row structure.
const SEGMENTS_BY_HEADER = {
  "REFRESHMENTS (TEA, COFFEE, ETC.)": ["Supplies - PK", "Vending machines rent"],
  "OFFICE SUPPLIES": ["Janitorial expenses", "Kitchen expenses", "Office supplies", "Drinking water"],
  "MISCELLANEOUS": ["Postage and Delivery", "Stationery", "Printing and Reproduction", "Fare allowance", "Entertainment", "Other Expenses", "Daily meals"],
  "OTHERS": ["Other Expenses"],
  "REPAIRS & MAINTENANCE": ["Building", "General Maintenance", "R&M - AC and Appliances", "R&M - Electronics (LEDs, etc.)", "R&M - Furnitures and Fixtures", "R&M - Equipments Admin"],
};
const DEFAULT_SEGMENTS = ["General"];
const segmentsForHeader = (headerName) => SEGMENTS_BY_HEADER[headerName] || DEFAULT_SEGMENTS;

// Full segment breakdown for a header: every defined segment, each with its own real
// Budget / Used (prior-exhausted + app-tracked) / Remaining — matching the sheet's columns.
// Budget Headers with no allocated budget — we only track the amount spent (and report it to
// Finance), so no remaining / utilization / over-budget warnings are shown for them.
const NO_BUDGET_HEADER_IDS = new Set(["h4", "h6"]); // h4 = REPAIRS & MAINTENANCE, h6 = OTHERS (no budget set yet)
const isNoBudgetHeader = (id) => NO_BUDGET_HEADER_IDS.has(id);

function getSegmentBreakdown(headerName, headerId, expenses) {
  const knownSegments = segmentsForHeader(headerName);
  const segBudgets = SEGMENT_BUDGETS[headerName] || {};
  const appUsedBySegment = expenses.filter((e) => e.headerId === headerId).reduce((acc, e) => {
    const key = e.segment || "Unspecified";
    acc[key] = (acc[key] || 0) + Number(e.amount);
    return acc;
  }, {});

  const rows = knownSegments.map((seg) => {
    const info = segBudgets[seg] || {};
    const budget = info.budget || 0;
    const used = (info.priorExhausted || 0) + (appUsedBySegment[seg] || 0);
    const remaining = budget - used;
    return { segment: seg, budget, used, remaining, utilization: pct(used, budget), over: budget > 0 && used > budget, noBudget: isNoBudgetHeader(headerId) };
  });

  Object.keys(appUsedBySegment).forEach((key) => {
    if (!knownSegments.includes(key)) {
      rows.push({ segment: key, budget: 0, used: appUsedBySegment[key], remaining: -appUsedBySegment[key], utilization: 0, over: !isNoBudgetHeader(headerId), noBudget: isNoBudgetHeader(headerId) });
    }
  });

  return rows;
}

// Mode of Payment options (matches the "Credit card useage" / "Petty Cash Usage" tabs on the sheet)
const PAYMENT_MODES = ["Credit Card", "Petty Cash", "Finance Payment"];
// Modes shown as balance/limit cards on the dashboard. "Finance Payment" (vendor invoices paid
// directly by Finance, e.g. water bottles, vending machine rent) doesn't touch either one.
const TRACKED_PAYMENT_MODES = ["Credit Card", "Petty Cash"];
const PAYMENT_MODE_LIMIT = 150000; // Credit Card only — Petty Cash is now tracked as a real cash-in-hand balance below.

// Petty Cash is physical cash, not a spending cap — it works like a float. Rather than
// re-summing every historical inflow/outflow ourselves (error-prone — the source ledger has
// a couple of rows with a missing date that our own parser silently dropped), we anchor on
// the ledger's own bottom-line total row: Total Debit (Rs 2,929,799) − Total Credit
// (Rs 2,690,577) = Rs 239,222 cash in hand, as of the last recorded transaction (Sep 14, 2026,
// source: Petty_cash_exp__jan_to__Sep_2026.xlsx).
// Anything added through the app AFTER that point (new "Petty Cash" expenses/top-ups, i.e.
// not part of the historical entries imported with id prefix "hist_") moves the balance
// from there.
const PETTY_CASH_BASELINE_BALANCE = 239222;
const PETTY_CASH_BASELINE_DATE = "2026-09-14";

// Added By options
const ADDED_BY_OPTIONS = ["Shahbaz Ahmed", "Ahsan Hussain", "Ali Turab", "Khaleeq Kamali", "Finance"];

// App-wide login gate. NOTE: this is a client-side deterrent, not real security —
// anyone viewing the deployed site's source code could find these values.
const LOGIN_USERS = [
  { name: "Shahbaz Ahmed", password: "2547", role: "admin" },
  { name: "Ahsan Hussain", password: "1122", role: "cashier" },
  { name: "Ali Turab", password: "5050", role: "admin" },
  { name: "Khaleeq Kamali", password: "2323", role: "admin" },
  { name: "Finance", password: "7867", role: "admin" },
];
// Which nav views each role can access. "cashier" only gets Expense Entries —
// enough to add expenses, charge them to a header/segment, and download
// attached receipts/documents to email for approval.
const ROLE_NAV_ACCESS = {
  admin: null, // null = everything
  cashier: ["expenses"],
};
const AUTH_STORAGE_KEY = "wsbd-auth-v1";

// Cash-flow approval workflow — each expense tracks its current stage.
const STATUS_STAGES = [
  "Requirement Raised",
  "Cash Requested",
  "Supervisor Approved",
  "Cash Issued to Rider",
  "Purchase Done",
  "Supporting Documents Collected",
  "Google Sheet Entry Done",
  "Physical Expense Sheet Done",
  "Manager Approved",
  "Cash Refilled",
  "Finance Submitted",
  "Finance Signed-off",
  "Document Filed",
];
const statusTone = (status) => {
  const idx = STATUS_STAGES.indexOf(status);
  if (idx === STATUS_STAGES.length - 1) return "green";
  if (idx <= 2) return "muted";
  return "amber";
};

// Business Unit options
const BU_OPTIONS = ["Pure", "SquatWolf", "Disrupt Lab", "Disrupt", "Wellows", "Secure", "Soft FM", "Hard FM", "HR-Ops"];

// Categories from the imported petty-cash history that roll up into Hard FM / Soft FM,
// per the Admin Budget vs Actual mapping (Maintenance = Hard FM, Facility = Soft FM).
const HARD_FM_HISTORY_CATS = new Set([
  "General Maintenance", "R&M - AC and Appliances", "R&M - Furniture & Fixture",
  "R&M - Equipments Admin", "R&M - Electronics"
]);
const SOFT_FM_HISTORY_CATS = new Set([
  "Janitorial Expense", "Stationery", "Daily - Meal", "Tea & Coffee",
  "Kitchen Supplies", "Water bottles", "Water Bottles", "Travel Expense",
  "Commission Expense", "ADM - Fare Allowance", "Entertainment"
]);
function historicalFMUsed(catSet) {
  return STATIC_HISTORY
    .filter((h) => h.type === "expense" && catSet.has(h.category) && h.date < "2026-08-05")
    .reduce((s, h) => s + Number(h.amount || 0), 0);
}
// From Aug 5, 2026 onward the source sheet explicitly tags each entry as "Hard FM" or
// "Soft FM" (the "fm" field in historyData.js) rather than us guessing it from the GL
// category — the same category can be either depending on the purchase. Those tagged
// entries are summed directly; everything before Aug 5 still uses the category heuristic.
const explicitFMUsed = (tag) => STATIC_HISTORY
  .filter((h) => h.type === "expense" && h.fm === tag && h.date >= "2026-08-05")
  .reduce((s, h) => s + Number(h.amount || 0), 0);
const HARD_FM_EXPLICIT_TAGGED_AUG_SEP = explicitFMUsed("Hard FM");
const SOFT_FM_EXPLICIT_TAGGED_AUG_SEP = explicitFMUsed("Soft FM");
const HARD_FM_HISTORICAL_USED = historicalFMUsed(HARD_FM_HISTORY_CATS) + HARD_FM_EXPLICIT_TAGGED_AUG_SEP;
const SOFT_FM_HISTORICAL_USED = historicalFMUsed(SOFT_FM_HISTORY_CATS) + SOFT_FM_EXPLICIT_TAGGED_AUG_SEP;
// H1 2026 budget figures from Admin_Budget_vs_Actual.xlsx (editable later in BU Budgets).
const HARD_FM_DEFAULT_BUDGET = 3168214.4675;
const SOFT_FM_DEFAULT_BUDGET = 6517151.005 + 2775518.34625 + 1265612.8265;

// Real expense entries start empty — data is added via the app or synced from the Google Sheet.
const SEED_EXPENSES = HISTORICAL_EXPENSES;

const STORAGE_KEY = "wsbd-app-data-v2";
// Bump this whenever historicalExpenses.js is re-imported. On load, saved "hist_" entries are
// swapped for the fresh import while anything added through the app is kept.
const HIST_VERSION = "2026-09-25-others-header";
// Budget Headers that were removed from the dashboard; dropped from saved browser data on load.
const REMOVED_HEADER_IDS = new Set(["h5"]); // h5 = UTILITIES

// Paste the Apps Script Web App URL here after deploying (ends in /exec).
// Leave empty and the app just keeps working off local storage, same as before.
const GOOGLE_SHEETS_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyLYV1SB2pf9jG26NA2SWSLBHGBseklBB255JLSXe4OBI-S0IjOKhmJfOnqLHkJrv4B/exec";
// Paste the Apps Script Web App URL for the HISTORY backend here (Code-History.gs,
// deployed on the existing "Petty cash from Sep 2025 to onwards" sheet).
// (History is now a static one-time import baked in from historyData.js — see STATIC_HISTORY.)

/* ---------------------------------- SMALL UI PARTS ---------------------------------- */
function Badge({ children, tone = "muted" }) {
  const tones = {
    muted: { bg: "#EEEEEE", fg: C.muted },
    green: { bg: C.greenLight, fg: C.green },
    amber: { bg: C.amberLight, fg: C.amber },
    red: { bg: C.redLight, fg: C.red },
  };
  const t = tones[tone];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ background: t.bg, color: t.fg }}
    >
      {children}
    </span>
  );
}

function ProgressBar({ percent, over }) {
  const clamped = Math.min(percent, 100);
  const color = over ? C.red : percent >= 80 ? C.amber : C.green;
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ background: "#E5E5E5", height: 8 }}>
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${clamped}%`, background: color }}
      />
    </div>
  );
}

function SegmentRow({ seg }) {
  if (seg.noBudget) {
    return (
      <div className="py-1.5 flex items-center justify-between text-xs gap-3">
        <span className="truncate font-medium" style={{ color: C.text }}>{seg.segment}</span>
        <span className="font-semibold shrink-0" style={{ color: C.text }}>{fmtPKR(seg.used)} used</span>
      </div>
    );
  }
  return (
    <div className="py-1.5" style={{ opacity: seg.budget > 0 ? 1 : 0.7 }}>
      <div className="flex items-center justify-between text-xs mb-1 gap-3">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate font-medium" style={{ color: C.text }}>{seg.segment}</span>
          {seg.over && <Badge tone="red">Over</Badge>}
        </span>
        <span className="font-semibold shrink-0" style={{ color: seg.remaining < 0 ? C.red : C.text }}>{fmtPKR(seg.remaining)} left</span>
      </div>
      <ProgressBar percent={seg.utilization} over={seg.over} />
      <div className="flex justify-between mt-1 text-[11px]" style={{ color: C.muted }}>
        <span>{fmtPKR(seg.used)} used</span>
        <span>{fmtPKR(seg.budget)} budget</span>
      </div>
    </div>
  );
}

function Gauge({ percent, size = 108, stroke = 11, over }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(percent, 100));
  const color = over ? C.red : percent >= 80 ? C.amber : C.green;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="#E5E5E5" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={c - (clamped / 100) * c}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
      <text x="50%" y="47%" textAnchor="middle" fontSize={size * 0.19} fontWeight="700" fill={C.text}>
        {percent.toFixed(1)}%
      </text>
      <text x="50%" y="65%" textAnchor="middle" fontSize={size * 0.1} fill={C.muted}>
        used
      </text>
    </svg>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  const isErr = toast.type === "error";
  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl px-4 py-3 shadow-lg text-sm font-medium"
      style={{ background: isErr ? C.red : C.green, color: "#fff" }}
    >
      {isErr ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
      {toast.msg}
    </div>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,36,28,0.45)" }}>
      <div
        className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto`}
        style={{ background: C.card }}
      >
        <div className="flex items-center justify-between px-6 py-4 sticky top-0" style={{ background: C.card, borderBottom: `1px solid ${C.border}` }}>
          <h3 className="text-base font-semibold" style={{ color: C.text }}>{title}</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100">
            <X size={18} color={C.muted} />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="block mb-4">
      <span className="block text-xs font-semibold mb-1.5" style={{ color: C.muted }}>{label}</span>
      {children}
      {hint && <span className="block text-xs mt-1" style={{ color: C.muted }}>{hint}</span>}
    </label>
  );
}

const inputStyle = {
  width: "100%",
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  padding: "9px 12px",
  fontSize: 14,
  color: C.text,
  outline: "none",
  background: "#fff",
};

/* ---------------------------------- APP ---------------------------------- */
export default function Dashboard() {
  const [authedUser, setAuthedUser] = useState(null);
  const [authRole, setAuthRole] = useState("admin");
  const [authLoaded, setAuthLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTH_STORAGE_KEY);
      if (saved) {
        setAuthedUser(saved);
        setAuthRole(LOGIN_USERS.find((u) => u.name === saved)?.role || "admin");
      }
    } catch (e) { /* ignore */ }
    setAuthLoaded(true);
  }, []);

  const handleLogin = (name, role) => {
    setAuthedUser(name);
    setAuthRole(role);
    try { localStorage.setItem(AUTH_STORAGE_KEY, name); } catch (e) { /* ignore */ }
  };
  const handleLogout = () => {
    setAuthedUser(null);
    try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) { /* ignore */ }
  };

  if (!authLoaded) return null;
  if (!authedUser) return <LoginScreen onLogin={handleLogin} />;

  return <DashboardApp authedUser={authedUser} authRole={authRole} onLogout={handleLogout} />;
}

function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = (e) => {
    e.preventDefault();
    const match = LOGIN_USERS.find((u) => u.password === password.trim());
    if (match) {
      onLogin(match.name, match.role);
    } else {
      setError("Incorrect password.");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: C.bg }}>
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl shadow-sm p-6" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <div className="text-white font-bold text-lg tracking-tight mb-1" style={{ background: "#1A1A1A", display: "inline-block", padding: "4px 10px", borderRadius: 8 }}>Disrupt.com</div>
        <h1 className="text-lg font-semibold mt-3 mb-1" style={{ color: C.text }}>Workplace Budget Dashboard</h1>
        <p className="text-sm mb-4" style={{ color: C.muted }}>Enter your password to continue.</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(""); }}
          placeholder="Password"
          className="w-full rounded-xl px-3 py-2.5 text-sm mb-2"
          style={{ border: `1px solid ${error ? C.red : C.border}` }}
        />
        {error && <p className="text-xs mb-2" style={{ color: C.red }}>{error}</p>}
        <button type="submit" className="w-full rounded-xl py-2.5 text-sm font-semibold" style={{ background: C.accent, color: C.text }}>
          Unlock
        </button>
      </form>
    </div>
  );
}

function DashboardApp({ authedUser, authRole, onLogout }) {
  const [forceShowAmounts, setForceShowAmounts] = useState(false); // manual override

  const [headers, setHeaders] = useState(SEED_HEADERS);
  const [expenses, setExpenses] = useState(SEED_EXPENSES);
  const [topUps, setTopUps] = useState([]); // { id, mode, date, amount }
  const [buBudgets, setBuBudgets] = useState(() => {
    const base = Object.fromEntries(BU_OPTIONS.map((b) => [b, 0]));
    base["Hard FM"] = HARD_FM_DEFAULT_BUDGET;
    base["Soft FM"] = SOFT_FM_DEFAULT_BUDGET;
    return base;
  });
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("dashboard");

  // Budget Headers and Expense Entries show amounts as 0 by default; the "Show Amounts"
  // toggle lets you peek at real figures when needed. Other sections (Dashboard, BU
  // Budgets, History) always show real numbers.
  const MASKED_BY_DEFAULT_VIEWS = ["headers", "expenses"];
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const [expenseModal, setExpenseModal] = useState(null); // null | {} | expense obj
  // The Add/Edit Expense form always shows real budget figures (header budget, used, available)
  // so you can see what's left before saving.
  HIDE_AMOUNTS = !forceShowAmounts && expenseModal === null && MASKED_BY_DEFAULT_VIEWS.includes(view);
  const [headerModal, setHeaderModal] = useState(null);
  const [deleteExpenseId, setDeleteExpenseId] = useState(null);
  const [deleteHeaderId, setDeleteHeaderId] = useState(null);
  const [syncing, setSyncing] = useState(false);

  // Load from persistent storage (browser localStorage)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.headers?.length) {
          const versionChanged = parsed.histVersion !== HIST_VERSION;
          const kept = parsed.headers.filter((h) => !REMOVED_HEADER_IDS.has(h.id)).map((h) => {
            if (isNoBudgetHeader(h.id)) return { ...h, budget: 0 };
            // When the built-in budgets are updated, re-sync the standard headers' budget
            // from SEGMENT_BUDGETS so saved browsers pick up the new figures.
            const seed = SEED_HEADERS.find((sh) => sh.id === h.id);
            return versionChanged && seed ? { ...h, budget: seed.budget } : h;
          });
          // Add any new built-in headers (e.g. OTHERS) that this browser's saved data doesn't have yet.
          const missing = SEED_HEADERS.filter((sh) => !kept.some((h) => h.id === sh.id || h.name.trim().toUpperCase() === sh.name));
          setHeaders([...kept, ...missing]);
        }
        if (parsed.expenses) {
          if (parsed.histVersion === HIST_VERSION) {
            setExpenses(parsed.expenses);
          } else {
            const appAdded = parsed.expenses.filter((e) => !String(e.id).startsWith("hist_"));
            setExpenses([...HISTORICAL_EXPENSES, ...appAdded]);
          }
        }
        if (parsed.topUps) setTopUps(parsed.topUps);
        if (parsed.buBudgets) setBuBudgets((b) => ({ ...b, ...parsed.buBudgets }));
      }
    } catch (e) {
      // no saved data yet — keep seed data
    } finally {
      setLoaded(true);
    }
  }, []);

  // Persist on change
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ headers, expenses, topUps, buBudgets, histVersion: HIST_VERSION }));
    } catch (e) {
      console.error("Storage error", e);
    }
  }, [headers, expenses, topUps, buBudgets, loaded]);

  const notify = (msg, type = "success") => {
    setToast({ msg, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  /* ---------------- Google Sheet sync (Apps Script webhook) ---------------- */
  async function pushExpenseToSheet(action, expense, headerName) {
    if (!GOOGLE_SHEETS_WEBHOOK_URL) return; // not configured yet — app keeps working locally
    try {
      await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids a CORS preflight to Apps Script
        body: JSON.stringify({ action, headerName, ...expense }),
      });
    } catch (err) {
      notify("Saved locally, but couldn't sync to Google Sheet.", "error");
    }
  }

  async function pullFromSheet() {
    if (!GOOGLE_SHEETS_WEBHOOK_URL) {
      notify("Google Sheet link isn't set up yet.", "error");
      return;
    }
    setSyncing(true);
    try {
      const res = await fetch(GOOGLE_SHEETS_WEBHOOK_URL);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Unknown error");
      const pulled = (data.entries || []).map((r) => ({
        id: r.id,
        date: r.date,
        headerId: r.headerId,
        segment: r.segment || "",
        description: r.description,
        vendor: r.vendor || "",
        amount: Number(r.amount) || 0,
        mode: r.mode || "",
        bu: r.bu || "",
        addedBy: r.addedBy,
        email: r.email || "",
        imageData: null,
        imageName: "",
        documentData: null,
        documentName: "",
        remarks: r.remarks || "",
        receiptLink: r.receiptLink || "",
        documentLink: r.documentLink || "",
      }));
      setExpenses(pulled);
      if (data.topUps) {
        setTopUps(data.topUps.map((t) => ({ id: t.id, mode: t.mode, date: t.date, amount: Number(t.amount) || 0 })));
      }
      notify(`Pulled ${pulled.length} entries from the Google Sheet.`);
    } catch (err) {
      notify("Couldn't pull from Google Sheet — check the Apps Script deployment.", "error");
    } finally {
      setSyncing(false);
    }
  }


  async function pushTopUpToSheet(topUp) {
    if (!GOOGLE_SHEETS_WEBHOOK_URL) return;
    try {
      await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "topup", ...topUp }),
      });
    } catch (err) {
      notify("Top-up saved locally, but couldn't sync to Google Sheet.", "error");
    }
  }

  /* ---------------- Derived data ---------------- */
  const headerStats = useMemo(() => {
    return headers.map((h) => {
      const priorExhausted = sumSegmentPriorExhausted(h.name);
      const appUsed = expenses.filter((e) => e.headerId === h.id).reduce((s, e) => s + Number(e.amount), 0);
      const used = priorExhausted + appUsed;
      if (isNoBudgetHeader(h.id)) {
        return { ...h, budget: 0, used, remaining: 0, utilization: 0, over: false, noBudget: true };
      }
      const remaining = h.budget - used;
      const utilization = pct(used, h.budget);
      return { ...h, used, remaining, utilization, over: used > h.budget, noBudget: false };
    });
  }, [headers, expenses]);

  const totals = useMemo(() => {
    const activeStats = headerStats.filter((h) => h.status === "Active");
    const totalBudget = activeStats.reduce((s, h) => s + Number(h.budget), 0);
    const totalUsed = activeStats.reduce((s, h) => s + h.used, 0);
    // Headers with no budget (e.g. Repairs & Maintenance) count toward Total Used but not
    // toward Remaining / Utilization, which only make sense against an allocated budget.
    const budgetedUsed = activeStats.filter((h) => !h.noBudget).reduce((s, h) => s + h.used, 0);
    return { totalBudget, totalUsed, budgetedUsed, remaining: totalBudget - budgetedUsed, utilization: pct(budgetedUsed, totalBudget) };
  }, [headerStats]);

  const overBudgetHeaders = headerStats.filter((h) => h.over);
  const headerNameById = useMemo(() => Object.fromEntries(headers.map((h) => [h.id, h.name])), [headers]);

  const buStats = useMemo(() => {
    return BU_OPTIONS.map((bu) => {
      const budget = Number(buBudgets[bu] || 0);
      const liveUsed = expenses.filter((e) => e.bu === bu).reduce((s, e) => s + Number(e.amount || 0), 0);
      const historicalUsed = bu === "Hard FM" ? HARD_FM_HISTORICAL_USED : bu === "Soft FM" ? SOFT_FM_HISTORICAL_USED : 0;
      const used = liveUsed + historicalUsed;
      return { bu, budget, used, liveUsed, historicalUsed, remaining: budget - used, utilization: pct(used, budget) };
    });
  }, [buBudgets, expenses]);

  const setBuBudget = (bu, amount) => {
    setBuBudgets((b) => ({ ...b, [bu]: Number(amount) || 0 }));
  };

  const paymentModeStats = useMemo(() => {
    return TRACKED_PAYMENT_MODES.map((mode) => {
      const toppedUp = topUps.filter((t) => t.mode === mode).reduce((s, t) => s + Number(t.amount), 0);
      const liveUsed = expenses.filter((e) => e.mode === mode).reduce((s, e) => s + Number(e.amount), 0);

      if (mode === "Petty Cash") {
        // Cash-in-hand model, anchored on the ledger's own baseline balance (see constant
        // above). Only expenses added AFTER that snapshot (not the imported "hist_" ones,
        // which are already reflected in the baseline) move the balance from here.
        const newUsed = expenses
          .filter((e) => e.mode === mode && !String(e.id).startsWith("hist_"))
          .reduce((s, e) => s + Number(e.amount || 0), 0);
        const opening = PETTY_CASH_BASELINE_BALANCE + toppedUp;
        const remaining = opening - newUsed;
        return { mode, limit: opening, used: newUsed, remaining, toppedUp, utilization: pct(newUsed, opening), over: remaining < 0, isBalance: true };
      }

      const limit = PAYMENT_MODE_LIMIT + toppedUp;
      const remaining = limit - liveUsed;
      return { mode, limit, used: liveUsed, remaining, toppedUp, utilization: pct(liveUsed, limit), over: liveUsed > limit, isBalance: false };
    });
  }, [expenses, topUps]);

  const [paymentModeView, setPaymentModeView] = useState(null); // null | "Credit Card" | "Petty Cash"

  function addTopUp(mode, date, amount) {
    const amt = Number(amount);
    if (!date) return notify("Please select a date.", "error");
    if (isNaN(amt) || amt <= 0) return notify("Top-up amount must be a positive number.", "error");
    const topUp = { id: uid("t"), mode, date, amount: amt, createdAt: new Date().toISOString() };
    setTopUps((prev) => [topUp, ...prev]);
    notify(`${mode} topped up by ${fmtPKR(amt)}.`);
    pushTopUpToSheet(topUp);
  }

  /* ---------------- Expense CRUD ---------------- */
  function saveExpense(form, editingId) {
    const amount = Number(form.amount);
    if (!form.date) return notify("Please select an expense date.", "error");
    if (!form.headerId) return notify("Please select a Budget Header.", "error");
    if (!form.description.trim()) return notify("Description is required.", "error");
    if (!form.addedBy.trim()) return notify("Please enter Added By.", "error");
    if (isNaN(amount) || amount <= 0) return notify("Amount must be a positive number.", "error");

    const headerName = headers.find((h) => h.id === form.headerId)?.name || "";
    if (editingId) {
      setExpenses((prev) => prev.map((e) => (e.id === editingId ? { ...e, ...form, amount } : e)));
      notify("Expense updated successfully.");
      pushExpenseToSheet("update", { ...form, amount, id: editingId }, headerName);
    } else {
      const newExpense = { id: uid("e"), ...form, amount, createdAt: new Date().toISOString() };
      setExpenses((prev) => [newExpense, ...prev]);
      notify("Expense added successfully.");
      pushExpenseToSheet("add", newExpense, headerName);
    }
    setExpenseModal(null);
  }

  function deleteExpense(id) {
    const target = expenses.find((e) => e.id === id);
    setExpenses((prev) => prev.filter((e) => e.id !== id));
    setDeleteExpenseId(null);
    notify("Expense deleted. Budget updated successfully.");
    pushExpenseToSheet("delete", { id }, target ? headerNameById[target.headerId] : "");
  }

  /* ---------------- Header CRUD ---------------- */
  function saveHeader(form, editingId) {
    const budget = Number(form.budget);
    if (!form.name.trim()) return notify("Header name is required.", "error");
    if (isNaN(budget) || budget <= 0) return notify("Allocated budget must be a positive number.", "error");
    const dup = headers.some((h) => h.name.trim().toLowerCase() === form.name.trim().toLowerCase() && h.id !== editingId);
    if (dup) return notify("A Budget Header with this name already exists.", "error");

    if (editingId) {
      setHeaders((prev) => prev.map((h) => (h.id === editingId ? { ...h, ...form, budget } : h)));
      notify("Budget header updated successfully.");
    } else {
      setHeaders((prev) => [...prev, { id: uid("h"), ...form, budget }]);
      notify("Budget header added successfully.");
    }
    setHeaderModal(null);
  }

  function deleteHeader(id) {
    const inUse = expenses.some((e) => e.headerId === id);
    if (inUse) {
      notify("Cannot delete — this header has linked expenses. Remove them first.", "error");
      setDeleteHeaderId(null);
      return;
    }
    setHeaders((prev) => prev.filter((h) => h.id !== id));
    setDeleteHeaderId(null);
    notify("Budget header deleted.");
  }

  function clearAllData() {
    setHeaders([]);
    setExpenses([]);
    notify("All data cleared.");
  }

  /* ---------------- Nav ---------------- */
  const ALL_NAV = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "headers", label: "Budget Headers", icon: Wallet },
    { id: "buBudgets", label: "BU Budgets", icon: Building2 },
    { id: "expenses", label: "Expense Entries", icon: ReceiptText },
    { id: "history", label: "History", icon: RotateCcw },
    { id: "reports", label: "Reports", icon: FileBarChart2 },
    { id: "export", label: "Export Data", icon: Download },
    { id: "settings", label: "Settings", icon: SettingsIcon },
  ];
  const allowedViews = ROLE_NAV_ACCESS[authRole];
  const NAV = allowedViews ? ALL_NAV.filter((n) => allowedViews.includes(n.id)) : ALL_NAV;

  // Restricted roles can't land on a view they don't have nav access to (e.g. first
  // login, or a stale view from before role changed) — snap to their first allowed tab.
  useEffect(() => {
    if (allowedViews && !allowedViews.includes(view)) {
      setView(allowedViews[0]);
    }
  }, [allowedViews, view]);


  return (
    <div className="flex min-h-screen w-full" style={{ background: C.bg, fontFamily: "'Segoe UI', ui-sans-serif, system-ui, -apple-system, sans-serif" }}>
      {/* Sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 md:hidden" style={{ background: "rgba(0,0,0,0.4)" }} onClick={() => setSidebarOpen(false)} />
      )}
      <aside
        className={`fixed md:sticky top-0 left-0 h-screen z-40 w-64 shrink-0 flex flex-col transition-transform duration-200 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"} md:translate-x-0`}
        style={{ background: `linear-gradient(180deg, ${C.sidebar} 0%, #000000 100%)`, boxShadow: "2px 0 12px rgba(0,0,0,0.08)" }}
      >
        <div className="px-6 py-6">
          <img src="/disrupt-logo.png" alt="Disrupt.com" className="h-6 w-auto" />
          <div className="text-[11px] leading-tight mt-1.5" style={{ color: C.sidebarMuted }}>Workplace Services</div>
        </div>
        <nav className="flex-1 px-3 mt-2 space-y-1">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = view === n.id;
            return (
              <button
                key={n.id}
                onClick={() => { setView(n.id); setSidebarOpen(false); }}
                className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all duration-150"
                style={{
                  background: active ? C.sidebarActive : "transparent",
                  color: active ? "#fff" : C.sidebarText,
                  boxShadow: active ? `inset 3px 0 0 ${C.accent}` : "none",
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <Icon size={17} />
                {n.label}
                {active && <ChevronRight size={15} className="ml-auto opacity-70" />}
              </button>
            );
          })}
        </nav>
        <div className="px-6 py-5 text-[11px]" style={{ color: C.sidebarMuted, borderTop: `1px solid ${C.sidebarActive}` }}>
          Budget Cycle<br />
          <span className="text-white font-medium">20 Jul 2026 → Till Date</span>
        </div>
        <div className="px-6 py-3" style={{ borderTop: `1px solid ${C.sidebarActive}` }}>
          <button
            onClick={() => setForceShowAmounts((v) => !v)}
            className="w-full flex items-center justify-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg"
            style={{ color: forceShowAmounts ? "#1A1A1A" : C.sidebarText, background: forceShowAmounts ? C.accent : "transparent", border: `1px solid ${C.sidebarActive}` }}
          >
            <Eye size={12} /> {forceShowAmounts ? "Hide Amounts Again" : "Show Amounts"}
          </button>
          <p className="text-[10px] mt-1.5 text-center" style={{ color: C.sidebarMuted }}>
            Budget Headers & Expense Entries show 0 by default
          </p>
        </div>
        <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: `1px solid ${C.sidebarActive}` }}>
          <div className="text-[11px]" style={{ color: C.sidebarMuted }}>
            Signed in as<br />
            <span className="text-white font-medium">{authedUser}</span>
          </div>
          <button
            onClick={onLogout}
            className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg"
            style={{ color: C.sidebarText, border: `1px solid ${C.sidebarActive}` }}
          >
            Logout
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 px-5 md:px-8 py-4" style={{ background: C.bg, boxShadow: "0 1px 3px rgba(15,36,28,0.05)" }}>
          <div className="flex items-center gap-3">
            <button className="md:hidden p-2 rounded-lg" style={{ background: C.card, border: `1px solid ${C.border}` }} onClick={() => setSidebarOpen(true)}>
              <Menu size={18} color={C.text} />
            </button>
            <div>
              <h1 className="text-lg md:text-xl font-bold" style={{ color: C.text }}>
                {NAV.find((n) => n.id === view)?.label || "Dashboard"}
              </h1>
              <p className="text-xs md:text-[13px]" style={{ color: C.muted }}>20 Jul 2026 → Till Date</p>
            </div>
          </div>
          <button
            onClick={() => setExpenseModal({ addedBy: authedUser })}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold shadow-sm shrink-0"
            style={{ background: C.accent, color: C.text }}
          >
            <Plus size={16} /> <span className="hidden sm:inline">New Expense</span>
          </button>
        </header>

        <main className="flex-1 px-5 md:px-8 py-6">
          {view === "dashboard" && (
            <DashboardView
              totals={totals}
              headerStats={headerStats}
              overBudgetHeaders={overBudgetHeaders}
              expenses={expenses}
              headerNameById={headerNameById}
              paymentModeStats={paymentModeStats}
              buStats={buStats}
              onViewPaymentMode={(mode) => setPaymentModeView(mode)}
              onAddExpense={() => setExpenseModal({ addedBy: authedUser })}
              onEditExpense={(e) => setExpenseModal(e)}
              onDeleteExpense={(id) => setDeleteExpenseId(id)}
              onViewAll={() => setView("expenses")}
              onViewBuBudgets={() => setView("buBudgets")}
            />
          )}
          {view === "headers" && (
            <HeadersView
              headerStats={headerStats}
              expenses={expenses}
              onAdd={() => setHeaderModal({})}
              onEdit={(h) => setHeaderModal(h)}
              onDelete={(id) => setDeleteHeaderId(id)}
            />
          )}
          {view === "buBudgets" && (
            <BuBudgetsView buStats={buStats} onSetBudget={setBuBudget} />
          )}
          {view === "expenses" && (
            <ExpensesView
              expenses={expenses}
              headers={headers}
              headerNameById={headerNameById}
              onAdd={() => setExpenseModal({ addedBy: authedUser })}
              onEdit={(e) => setExpenseModal(e)}
              onDelete={(id) => setDeleteExpenseId(id)}
            />
          )}
          {view === "history" && <HistoryView history={STATIC_HISTORY} />}
          {view === "reports" && (
            <ReportsView headers={headers} expenses={expenses} headerStats={headerStats} headerNameById={headerNameById} />
          )}
          {view === "export" && <ExportView headers={headers} expenses={expenses} headerNameById={headerNameById} notify={notify} />}
          {view === "settings" && (
            <SettingsView
              onClear={clearAllData}
              headerCount={headers.length}
              expenseCount={expenses.length}
              onPull={pullFromSheet}
              syncing={syncing}
              sheetConfigured={!!GOOGLE_SHEETS_WEBHOOK_URL}
            />
          )}
          <div className="text-center text-xs py-6 mt-2" style={{ color: C.muted }}>
            Created by Shahbaz &amp; Khaleeq · Version 25 Sep 2026
          </div>
        </main>
      </div>

      {expenseModal !== null && (
        <ExpenseModal
          headers={headers}
          initial={expenseModal}
          onClose={() => setExpenseModal(null)}
          onSave={saveExpense}
          headerStats={headerStats}
          expenses={expenses}
          buStats={buStats}
          notify={notify}
        />
      )}
      {headerModal !== null && (
        <HeaderModal initial={headerModal} onClose={() => setHeaderModal(null)} onSave={saveHeader} />
      )}
      {deleteExpenseId && (
        <ConfirmModal
          title="Delete expense entry?"
          body="This will permanently remove this entry and recalculate all budget totals."
          onCancel={() => setDeleteExpenseId(null)}
          onConfirm={() => deleteExpense(deleteExpenseId)}
        />
      )}
      {deleteHeaderId && (
        <ConfirmModal
          title="Delete budget header?"
          body="This cannot be undone. Headers with linked expenses cannot be deleted."
          onCancel={() => setDeleteHeaderId(null)}
          onConfirm={() => deleteHeader(deleteHeaderId)}
        />
      )}
      {paymentModeView && (
        <PaymentModeModal
          mode={paymentModeView}
          stats={paymentModeStats.find((p) => p.mode === paymentModeView)}
          expenses={expenses.filter((e) => e.mode === paymentModeView)}
          headerNameById={headerNameById}
          onClose={() => setPaymentModeView(null)}
          onTopUp={addTopUp}
        />
      )}
      <Toast toast={toast} />
    </div>
  );
}

/* ---------------------------------- KPI CARD ---------------------------------- */
function KPICard({ label, value, sub, icon: Icon, tone }) {
  const tones = {
    green: { bg: C.greenLight, fg: C.green },
    blue: { bg: "#EAF0F9", fg: C.blue },
    red: { bg: C.redLight, fg: C.red },
    purple: { bg: "#FBEEE3", fg: C.purple },
  };
  const t = tones[tone] || tones.green;
  return (
    <div className="rounded-2xl p-5 shadow-sm transition-all duration-200 hover:shadow-md hover:-translate-y-0.5" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: C.muted }}>{label}</span>
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: t.bg, boxShadow: `0 0 0 5px ${t.bg}80` }}>
          <Icon size={16} color={t.fg} />
        </div>
      </div>
      <div className="text-2xl font-bold tabular-nums tracking-tight" style={{ color: C.text }}>{value}</div>
      {sub && <div className="text-xs mt-1.5" style={{ color: C.muted }}>{sub}</div>}
    </div>
  );
}

/* ---------------------------------- DASHBOARD VIEW ---------------------------------- */
function DashboardView({ totals, headerStats, overBudgetHeaders, expenses, headerNameById, paymentModeStats, buStats, onViewPaymentMode, onAddExpense, onEditExpense, onDeleteExpense, onViewAll, onViewBuBudgets }) {
  const recent = [...expenses].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);
  const [expandedHeaderId, setExpandedHeaderId] = useState(null);

  return (
    <div className="space-y-6">
      {overBudgetHeaders.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl px-5 py-4" style={{ background: C.redLight, border: `1px solid #F3C7C3` }}>
          <AlertTriangle size={18} color={C.red} className="shrink-0 mt-0.5" />
          <div className="text-sm" style={{ color: "#7A241E" }}>
            <span className="font-semibold">{overBudgetHeaders.length} header{overBudgetHeaders.length > 1 ? "s" : ""} over budget: </span>
            {overBudgetHeaders.map((h) => h.name).join(", ")}. Review expense entries against these headers.
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="Total Budget" value={fmtPKR(totals.totalBudget)} sub="Excludes headers with no budget" icon={Wallet} tone="blue" />
        <KPICard label="Total Used" value={fmtPKR(totals.totalUsed)} sub={`${expenses.length} expense entries`} icon={ReceiptText} tone="purple" />
        <KPICard label="Total Remaining" value={fmtPKR(totals.remaining)} sub={totals.remaining < 0 ? "Over allocated budget" : "Available to spend"} icon={totals.remaining < 0 ? TrendingDown : TrendingUp} tone={totals.remaining < 0 ? "red" : "green"} />
        <KPICard label="Utilization" value={`${totals.utilization.toFixed(1)}%`} sub="Overall budget consumed" icon={FileBarChart2} tone={totals.utilization > 100 ? "red" : "blue"} />
      </div>



      {paymentModeStats && (
        <div>
          <h3 className="text-sm font-semibold mb-3" style={{ color: C.text }}>Payment Modes</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {paymentModeStats.map((p) => (
              <button
                key={p.mode}
                onClick={() => onViewPaymentMode(p.mode)}
                className="text-left rounded-2xl p-5 shadow-sm flex items-center gap-5 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5"
                style={{ background: C.card, border: `1px solid ${p.over ? "#F3C7C3" : C.border}` }}
              >
                <Gauge percent={p.utilization} size={84} stroke={8} over={p.over} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold" style={{ color: C.text }}>{p.mode}</span>
                    {p.over && <Badge tone="red">{p.isBalance ? "Cash Short" : "Over Limit"}</Badge>}
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between"><span style={{ color: C.muted }}>{p.isBalance ? "Opening Balance" : "Limit"}</span><span className="font-semibold" style={{ color: C.text }}>{fmtPKR(p.limit)}</span></div>
                    <div className="flex justify-between"><span style={{ color: C.muted }}>Spent</span><span className="font-semibold" style={{ color: C.text }}>{fmtPKR(p.used)}</span></div>
                    <div className="flex justify-between"><span style={{ color: C.muted }}>{p.isBalance ? "Available Balance" : "Remaining"}</span><span className="font-semibold" style={{ color: p.remaining < 0 ? C.red : C.green }}>{fmtPKR(p.remaining)}</span></div>
                  </div>
                  <div className="mt-2 text-xs font-semibold flex items-center gap-1" style={{ color: C.green }}>
                    View details <ChevronRight size={13} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 rounded-2xl shadow-sm overflow-hidden" style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${C.border}` }}>
            <h3 className="text-sm font-semibold" style={{ color: C.text }}>Budget Overview by Header</h3>
          </div>
          <div className="divide-y" style={{ borderColor: C.border }}>
            {headerStats.map((h) => {
              const isOpen = expandedHeaderId === h.id;
              const segmentBreakdown = isOpen ? getSegmentBreakdown(h.name, h.id, expenses) : [];
              return (
                <div key={h.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <div
                    className="px-5 py-4 flex items-center gap-3 cursor-pointer transition-colors hover:bg-[#FAFAFA]"
                    onClick={() => setExpandedHeaderId(isOpen ? null : h.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                        <span className="text-sm font-semibold truncate" style={{ color: C.text }}>{h.name}</span>
                        {h.over && <Badge tone="red">Over Budget</Badge>}
                        {!h.over && !h.noBudget && h.utilization >= 80 && <Badge tone="amber">Near Limit</Badge>}
                        {h.noBudget && <Badge tone="muted">No budget</Badge>}
                      </div>
                      {h.noBudget ? (
                        <div className="text-xs" style={{ color: C.muted }}>{fmtPKR(h.used)} used · amount tracked for Finance</div>
                      ) : (
                        <>
                          <ProgressBar percent={h.utilization} over={h.over} />
                          <div className="flex justify-between mt-1.5 text-xs" style={{ color: C.muted }}>
                            <span>{fmtPKR(h.used)} used</span>
                            <span>{fmtPKR(h.budget)} budget</span>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="text-right shrink-0 hidden sm:block">
                      {h.noBudget ? (
                        <div className="text-sm font-bold" style={{ color: C.text }}>{fmtPKR(h.used)}</div>
                      ) : (
                        <>
                          <div className="text-sm font-bold" style={{ color: h.over ? C.red : C.text }}>{h.utilization.toFixed(1)}%</div>
                          <div className="text-xs" style={{ color: h.remaining < 0 ? C.red : C.muted }}>{fmtPKR(Math.abs(h.remaining))} {h.remaining < 0 ? "over" : "left"}</div>
                        </>
                      )}
                    </div>
                    <ChevronRight
                      size={16}
                      color={C.muted}
                      className="shrink-0 transition-transform duration-200"
                      style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}
                    />
                  </div>
                  {isOpen && (
                    <div className="px-5 pb-4 -mt-1" style={{ background: "#FAFAFA" }}>
                      <div className="text-[10px] font-semibold uppercase tracking-wide mb-2 pt-3" style={{ color: C.muted }}>Segment Breakdown</div>
                      {segmentBreakdown.length === 0 ? (
                        <div className="text-xs pb-1" style={{ color: C.muted }}>No entries yet for this header.</div>
                      ) : (
                        <div className="divide-y" style={{ borderColor: C.border }}>
                          {segmentBreakdown.map((seg) => <SegmentRow key={seg.segment} seg={seg} />)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl shadow-sm p-5 flex flex-col transition-shadow duration-200 hover:shadow-md" style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <h3 className="text-sm font-semibold mb-1" style={{ color: C.text }}>Spending Trend by Header</h3>
          <p className="text-xs mb-2" style={{ color: C.muted }}>Cumulative amount used over time</p>
          <HeaderTrendChart headerStats={headerStats} expenses={expenses} />
          <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${C.border}` }}>
            <div className="flex justify-between text-xs mb-1.5"><span style={{ color: C.muted }}>Used</span><span style={{ color: C.muted }}>Remaining</span></div>
            <div className="flex rounded-full overflow-hidden" style={{ height: 10, background: "#E5E5E5" }}>
              <div style={{ width: `${Math.min(pct(totals.budgetedUsed, totals.totalBudget), 100)}%`, background: `linear-gradient(90deg, ${C.green}, #404040)` }} />
            </div>
            <div className="flex justify-between text-xs mt-1.5 font-medium">
              <span style={{ color: C.text }}>{fmtPKR(totals.budgetedUsed)}</span>
              <span style={{ color: C.text }}>{fmtPKR(Math.max(totals.remaining, 0))}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl shadow-sm overflow-hidden" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${C.border}` }}>
          <h3 className="text-sm font-semibold" style={{ color: C.text }}>Recent Expense Entries</h3>
          <button onClick={onViewAll} className="text-xs font-semibold" style={{ color: C.green }}>View all →</button>
        </div>
        <ExpenseTable rows={recent} headerNameById={headerNameById} onEdit={onEditExpense} onDelete={onDeleteExpense} />
      </div>
    </div>
  );
}

/* ---------------------------------- FM MANAGEMENT SUMMARY (Hard FM / Soft FM) ---------------------------------- */
function FMManagementSummary({ buStats, onViewDetails }) {
  const hard = buStats.find((b) => b.bu === "Hard FM");
  const soft = buStats.find((b) => b.bu === "Soft FM");
  if (!hard || !soft) return null;

  const Row = ({ label, stat }) => {
    const over = stat.budget > 0 && stat.used > stat.budget;
    return (
      <div className="rounded-2xl p-5" style={{ background: C.card, border: `1px solid ${over ? "#F3C7C3" : C.border}` }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold" style={{ color: C.text }}>{label}</span>
          {over && <Badge tone="red">Over Budget</Badge>}
        </div>
        <ProgressBar percent={stat.utilization} over={over} />
        <div className="flex justify-between mt-2 text-xs" style={{ color: C.muted }}>
          <span>{fmtPKR(stat.used)} used</span>
          <span>{fmtPKR(stat.budget)} budget</span>
        </div>
        <div className="flex justify-between mt-3 text-[11px]" style={{ color: C.muted }}>
          <span>History (Jul–Sep): {fmtPKR(stat.historicalUsed)}</span>
          <span>New (app): {fmtPKR(stat.liveUsed)}</span>
        </div>
        <div className="mt-1 text-xs font-semibold" style={{ color: over ? C.red : C.green }}>
          {over ? `Over by ${fmtPKR(Math.abs(stat.remaining))}` : `${fmtPKR(stat.remaining)} remaining`}
        </div>
      </div>
    );
  };

  return (
    <div className="rounded-2xl shadow-sm p-5" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold" style={{ color: C.text }}>Hard FM / Soft FM — Budget vs Actual</h3>
        <button onClick={onViewDetails} className="text-xs font-semibold" style={{ color: C.green }}>Manage budgets →</button>
      </div>
      <p className="text-xs mb-4" style={{ color: C.muted }}>
        Combines the imported petty-cash history (Jul–Sep 2026) with new expenses added through the app. Updates automatically as you add expenses tagged Hard FM or Soft FM.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Row label="Hard FM (Maintenance)" stat={hard} />
        <Row label="Soft FM (Facility)" stat={soft} />
      </div>
    </div>
  );
}

/* ---------------------------------- HISTORICAL USAGE CARD (from static history import) ---------------------------------- */
function HistoricalUsageCard() {
  const RANGE_FROM = "2026-07-01";
  const RANGE_TILL = "2026-09-14";

  const stats = useMemo(() => {
    const inRange = STATIC_HISTORY.filter((h) => h.date && h.date >= RANGE_FROM && h.date <= RANGE_TILL);
    const totalExpense = inRange.filter((h) => h.type === "expense").reduce((s, h) => s + Number(h.amount || 0), 0);
    const totalCashIn = inRange.filter((h) => h.type === "inflow").reduce((s, h) => s + Number(h.amount || 0), 0);
    const byBu = {};
    inRange.filter((h) => h.type === "expense").forEach((h) => {
      const key = h.bu || "Uncategorized";
      byBu[key] = (byBu[key] || 0) + Number(h.amount || 0);
    });
    const topBus = Object.entries(byBu).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { count: inRange.length, totalExpense, totalCashIn, topBus };
  }, []);

  return (
    <div className="rounded-2xl shadow-sm p-5" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold" style={{ color: C.text }}>Historical Usage — Jul 1 to Sep 14, 2026</h3>
        <Badge tone="muted">{stats.count} entries</Badge>
      </div>
      <p className="text-xs mb-4" style={{ color: C.muted }}>From the imported petty cash archive (see History tab for full detail).</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <KPICard label="Total Expenses" value={fmtPKR(stats.totalExpense)} icon={ReceiptText} tone="purple" />
        <KPICard label="Total Cash In" value={fmtPKR(stats.totalCashIn)} icon={TrendingUp} tone="green" />
        <KPICard label="Net" value={fmtPKR(stats.totalCashIn - stats.totalExpense)} icon={Wallet} tone={stats.totalCashIn - stats.totalExpense < 0 ? "red" : "blue"} />
      </div>
      {stats.topBus.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: C.muted }}>Top 5 BUs by Spend</div>
          <div className="space-y-1.5">
            {stats.topBus.map(([bu, amt]) => (
              <div key={bu} className="flex justify-between text-xs">
                <span style={{ color: C.text }}>{bu}</span>
                <span className="font-semibold" style={{ color: C.text }}>{fmtPKR(amt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- HEADER TREND CHART ---------------------------------- */
function HeaderTrendChart({ headerStats, expenses }) {
  const activeHeaders = headerStats.filter((h) => h.used > 0);

  const data = useMemo(() => {
    if (expenses.length === 0) return [];
    const sorted = [...expenses].sort((a, b) => new Date(a.date) - new Date(b.date));
    const dates = [...new Set(sorted.map((e) => e.date))].sort((a, b) => new Date(a) - new Date(b));
    const running = {};
    headerStats.forEach((h) => { running[h.id] = 0; });
    return dates.map((date) => {
      sorted.filter((e) => e.date === date).forEach((e) => {
        running[e.headerId] = (running[e.headerId] || 0) + Number(e.amount);
      });
      const point = { date: fmtDate(date) };
      headerStats.forEach((h) => { point[h.id] = running[h.id]; });
      return point;
    });
  }, [expenses, headerStats]);

  if (data.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs" style={{ color: C.muted, height: 240 }}>
        No spending data yet — add an expense to see the trend.
      </div>
    );
  }

  return (
    <div style={{ height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            {activeHeaders.map((h, i) => {
              const color = CHART_COLORS[i % CHART_COLORS.length];
              return (
                <linearGradient key={h.id} id={`grad-${h.id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.38} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              );
            })}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E5E5" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: C.muted }} axisLine={{ stroke: C.border }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)} width={40} />
          <RTooltip content={<TrendTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
          {activeHeaders.map((h, i) => {
            const color = CHART_COLORS[i % CHART_COLORS.length];
            return (
              <Area
                key={h.id}
                type="monotone"
                dataKey={h.id}
                name={h.name}
                stroke={color}
                fill={`url(#grad-${h.id})`}
                strokeWidth={2.5}
                dot={{ r: 3.5, strokeWidth: 0, fill: color }}
                activeDot={{ r: 6, strokeWidth: 2, stroke: "#fff" }}
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl px-3.5 py-3" style={{ background: "#fff", border: `1px solid ${C.border}`, boxShadow: "0 8px 24px rgba(15,36,28,0.12)" }}>
      <div className="text-xs font-semibold mb-2" style={{ color: C.text }}>{label}</div>
      <div className="space-y-1">
        {payload.map((p) => (
          <div key={p.dataKey} className="flex items-center justify-between gap-5 text-xs">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
              <span className="truncate" style={{ color: C.muted }}>{p.name}</span>
            </span>
            <span className="font-semibold shrink-0" style={{ color: C.text }}>{fmtPKR(p.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- EXPENSE TABLE ---------------------------------- */
function ExpenseTable({ rows, headerNameById, onEdit, onDelete }) {
  const showActions = !!(onEdit || onDelete);
  if (rows.length === 0) {
    return <div className="px-5 py-10 text-center text-sm" style={{ color: C.muted }}>No expense entries yet. Add your first expense to get started.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: "#FAFAFA" }}>
            {["Date", "Budget Header", "Segment", "Description", "Amount", "Mode", "BU", "Added By", "Attachments", ...(showActions ? [""] : [])].map((h) => (
              <th key={h} className="text-left px-5 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: C.muted }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} style={{ borderTop: `1px solid ${C.border}` }}>
              <td className="px-5 py-3 whitespace-nowrap" style={{ color: C.text }}>{fmtDate(e.date)}</td>
              <td className="px-5 py-3 whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5">
                  {headerNameById[e.headerId] || "—"}
                </span>
              </td>
              <td className="px-5 py-3 whitespace-nowrap" style={{ color: C.muted }}>{e.segment || "—"}</td>
              <td className="px-5 py-3 max-w-[220px] truncate" title={e.description} style={{ color: C.text }}>{e.description}</td>
              <td className="px-5 py-3 font-semibold whitespace-nowrap" style={{ color: C.text }}>{fmtPKR(e.amount)}</td>
              <td className="px-5 py-3 whitespace-nowrap" style={{ color: C.muted }}>{e.mode || "—"}</td>
              <td className="px-5 py-3 whitespace-nowrap" style={{ color: C.muted }}>{e.bu || "—"}</td>
              <td className="px-5 py-3 whitespace-nowrap" style={{ color: C.muted }}>{e.addedBy}</td>
              <td className="px-5 py-3 whitespace-nowrap">
                <div className="flex items-center gap-2">
                  {e.imageData && (
                    <a href={e.imageData} download={`receipt-${e.id}.jpg`} title="Download receipt image" className="p-1.5 rounded-lg hover:bg-gray-100">
                      <Download size={14} color={C.green} />
                    </a>
                  )}
                  {e.documentData && (
                    <a href={e.documentData} download={e.documentName || `document-${e.id}`} title="Download attached document" className="p-1.5 rounded-lg hover:bg-gray-100">
                      <FileText size={14} color={C.green} />
                    </a>
                  )}
                  {!e.imageData && !e.documentData && <span style={{ color: C.muted }}>—</span>}
                </div>
              </td>
              {showActions && (
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2 justify-end">
                    {onEdit && <button onClick={() => onEdit(e)} className="p-1.5 rounded-lg hover:bg-gray-100"><Pencil size={14} color={C.muted} /></button>}
                    {onDelete && <button onClick={() => onDelete(e.id)} className="p-1.5 rounded-lg hover:bg-gray-100"><Trash2 size={14} color={C.red} /></button>}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------- PAYMENT MODE MODAL ---------------------------------- */
function PaymentModeModal({ mode, stats, expenses, headerNameById, onClose, onTopUp }) {
  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpDate, setTopUpDate] = useState(todayISO());
  const [topUpAmount, setTopUpAmount] = useState("");

  if (!stats) return null;
  const sorted = [...expenses].sort((a, b) => new Date(b.date) - new Date(a.date));

  const handleTopUp = () => {
    onTopUp(mode, topUpDate, topUpAmount);
    setShowTopUp(false);
    setTopUpAmount("");
  };

  return (
    <Modal title={stats.isBalance ? `${mode} — Cash Balance` : `${mode} — Limit Overview`} onClose={onClose} wide>
      <div className="flex items-center gap-6 mb-5 flex-wrap">
        <Gauge percent={stats.utilization} size={120} stroke={11} over={stats.over} />
        <div className="flex-1 min-w-[180px] space-y-2 text-sm">
          <div className="flex justify-between"><span style={{ color: C.muted }}>{stats.isBalance ? "Opening Balance" : "Limit"}</span><span className="font-semibold" style={{ color: C.text }}>{fmtPKR(stats.limit)}</span></div>
          {stats.toppedUp > 0 && (
            <div className="flex justify-between"><span style={{ color: C.muted }}>Topped Up</span><span className="font-semibold" style={{ color: C.green }}>+{fmtPKR(stats.toppedUp)}</span></div>
          )}
          <div className="flex justify-between"><span style={{ color: C.muted }}>Spent</span><span className="font-semibold" style={{ color: C.text }}>{fmtPKR(stats.used)}</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>{stats.isBalance ? "Available Balance" : "Remaining"}</span><span className="font-semibold" style={{ color: stats.remaining < 0 ? C.red : C.green }}>{fmtPKR(stats.remaining)}</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Entries</span><span className="font-semibold" style={{ color: C.text }}>{expenses.length}</span></div>
        </div>
      </div>
      {stats.over && (
        <div className="flex items-start gap-2 rounded-xl px-4 py-3 mb-4" style={{ background: C.redLight }}>
          <AlertTriangle size={16} color={C.red} className="shrink-0 mt-0.5" />
          <div className="text-xs" style={{ color: "#7A241E" }}>
            {stats.isBalance ? (
              <span className="font-semibold">{mode} balance is short by {fmtPKR(Math.abs(stats.remaining))}.</span>
            ) : (
              <><span className="font-semibold">{mode} is over its {fmtPKR(stats.limit)} limit</span> by {fmtPKR(Math.abs(stats.remaining))}.</>
            )}
          </div>
        </div>
      )}

      {!showTopUp ? (
        <button
          onClick={() => setShowTopUp(true)}
          className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold mb-4"
          style={{ background: C.greenLight, color: C.green }}
        >
          <Plus size={16} /> Top Up {mode}
        </button>
      ) : (
        <div className="rounded-xl p-4 mb-4" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <Field label="Date"><input type="date" value={topUpDate} onChange={(e) => setTopUpDate(e.target.value)} style={inputStyle} /></Field>
            <Field label="Amount (PKR)"><input type="number" min="0" value={topUpAmount} onChange={(e) => setTopUpAmount(e.target.value)} placeholder="0" style={inputStyle} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowTopUp(false)} className="rounded-lg px-3.5 py-2 text-xs font-semibold" style={{ background: "#EEEEEE", color: C.muted }}>Cancel</button>
            <button onClick={handleTopUp} className="rounded-lg px-3.5 py-2 text-xs font-semibold" style={{ background: C.accent, color: C.text }}>Confirm Top Up</button>
          </div>
        </div>
      )}

      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
        <ExpenseTable rows={sorted} headerNameById={headerNameById} />
      </div>
    </Modal>
  );
}


function HeadersView({ headerStats, expenses, onAdd, onEdit, onDelete }) {
  const [expandedId, setExpandedId] = useState(null);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm" style={{ color: C.muted }}>Manage allocated budgets for each Workplace Services spending category. Click a card to see its segment breakdown.</p>
        <button onClick={onAdd} className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold shrink-0" style={{ background: C.accent, color: C.text }}>
          <Plus size={16} /> Add Header
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {headerStats.map((h) => {
          const isOpen = expandedId === h.id;
          const segmentBreakdown = isOpen ? getSegmentBreakdown(h.name, h.id, expenses) : [];
          return (
            <div
              key={h.id}
              className="rounded-2xl p-5 shadow-sm cursor-pointer transition-all duration-200 hover:shadow-md"
              style={{ background: C.card, border: `1px solid ${h.over ? "#F3C7C3" : C.border}` }}
              onClick={() => setExpandedId(isOpen ? null : h.id)}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="text-sm font-semibold truncate" style={{ color: C.text }}>{h.name}</h4>
                  </div>
                  <Badge tone={h.status === "Active" ? "green" : "muted"}>{h.status}</Badge>
                </div>
                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => onEdit(h)} className="p-1.5 rounded-lg hover:bg-gray-100"><Pencil size={14} color={C.muted} /></button>
                  <button onClick={() => onDelete(h.id)} className="p-1.5 rounded-lg hover:bg-gray-100"><Trash2 size={14} color={C.red} /></button>
                </div>
              </div>
              <div className="flex items-center gap-4">
                {h.noBudget ? (
                  <div className="flex-1 space-y-1.5 text-xs">
                    <div className="flex justify-between"><span style={{ color: C.muted }}>Budget</span><span className="font-semibold" style={{ color: C.muted }}>No budget</span></div>
                    <div className="flex justify-between"><span style={{ color: C.muted }}>Used</span><span className="font-semibold" style={{ color: C.text }}>{fmtPKR(h.used)}</span></div>
                    <div className="text-[11px]" style={{ color: C.muted }}>Amount tracked and reported to Finance.</div>
                  </div>
                ) : (
                  <>
                    <Gauge percent={h.utilization} size={92} stroke={9} over={h.over} />
                    <div className="flex-1 space-y-1.5 text-xs">
                      <div className="flex justify-between"><span style={{ color: C.muted }}>Budget</span><span className="font-semibold" style={{ color: C.text }}>{fmtPKR(h.budget)}</span></div>
                      <div className="flex justify-between"><span style={{ color: C.muted }}>Used</span><span className="font-semibold" style={{ color: C.text }}>{fmtPKR(h.used)}</span></div>
                      <div className="flex justify-between"><span style={{ color: C.muted }}>Remaining</span><span className="font-semibold" style={{ color: h.remaining < 0 ? C.red : C.green }}>{fmtPKR(h.remaining)}</span></div>
                    </div>
                  </>
                )}
              </div>
              {h.over && (
                <div className="mt-3 flex items-center gap-1.5 text-xs font-medium rounded-lg px-3 py-2" style={{ background: C.redLight, color: C.red }}>
                  <AlertTriangle size={13} /> Over budget by {fmtPKR(Math.abs(h.remaining))}
                </div>
              )}
              <div className="mt-3 flex items-center justify-between text-xs" style={{ color: C.muted }}>
                <span>{fmtDate(h.startDate)} {h.endDate ? `→ ${fmtDate(h.endDate)}` : "→ Till Date"}</span>
                <span className="flex items-center gap-1 font-semibold" style={{ color: C.green }}>
                  Segments <ChevronRight size={13} className="transition-transform duration-200" style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }} />
                </span>
              </div>
              {isOpen && (
                <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${C.border}` }}>
                  {segmentBreakdown.length === 0 ? (
                    <div className="text-xs" style={{ color: C.muted }}>No entries yet for this header.</div>
                  ) : (
                    <div className="divide-y" style={{ borderColor: C.border }}>
                      {segmentBreakdown.map((seg) => <SegmentRow key={seg.segment} seg={seg} />)}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {headerStats.length === 0 && (
          <div className="col-span-full text-center py-14 text-sm" style={{ color: C.muted }}>No budget headers yet. Add one to get started.</div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------- BU BUDGETS VIEW ---------------------------------- */
function BuBudgetsView({ buStats, onSetBudget }) {
  const enforcedBUs = new Set(["Hard FM", "Soft FM"]);
  return (
    <div className="space-y-5">
      <p className="text-sm" style={{ color: C.muted }}>
        Set an allocated budget for each Business Unit. This is for visibility only — it shows how much each BU
        has spent against its own budget, but does <span className="font-semibold">not</span> reduce the
        Budget Header/Segment totals above. <span className="font-semibold">Hard FM</span> and{" "}
        <span className="font-semibold">Soft FM</span> combine the imported petty-cash history with new expenses
        added through the app, and are flagged when they go over their allocated amount.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {buStats.map((b) => {
          const enforced = enforcedBUs.has(b.bu);
          const over = enforced && b.budget > 0 && b.used > b.budget;
          return (
            <div
              key={b.bu}
              className="rounded-2xl p-5 shadow-sm"
              style={{ background: C.card, border: `1px solid ${over ? "#F3C7C3" : C.border}` }}
            >
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold truncate" style={{ color: C.text }}>{b.bu}</h4>
                {enforced && <Badge tone={over ? "red" : "green"}>{over ? "Over Budget" : "Tracked"}</Badge>}
              </div>
              <div className="flex items-center justify-between text-xs mb-1.5" style={{ color: C.muted }}>
                <span>Allocated Budget (PKR)</span>
              </div>
              <input
                type="number"
                min="0"
                value={b.budget || ""}
                onChange={(e) => onSetBudget(b.bu, e.target.value)}
                placeholder="0"
                className="w-full rounded-xl px-3 py-2 text-sm font-semibold mb-3"
                style={{ border: `1px solid ${C.border}`, color: C.text, background: "#fff" }}
              />
              <div className="flex items-center justify-between text-sm">
                <span style={{ color: C.muted }}>Spent (total)</span>
                <span className="font-bold tabular-nums" style={{ color: over ? C.red : C.text }}>{fmtPKR(b.used)}</span>
              </div>
              {enforced && (b.historicalUsed > 0 || b.liveUsed > 0) && (
                <div className="mt-1.5 space-y-0.5">
                  <div className="flex justify-between text-[11px]" style={{ color: C.muted }}>
                    <span>From history (Jul–Sep)</span><span>{fmtPKR(b.historicalUsed)}</span>
                  </div>
                  <div className="flex justify-between text-[11px]" style={{ color: C.muted }}>
                    <span>New (added in app)</span><span>{fmtPKR(b.liveUsed)}</span>
                  </div>
                </div>
              )}
              <div className="mt-1.5 flex items-center justify-between text-xs" style={{ color: C.muted }}>
                <span>{fmtPKR(b.budget)} / {fmtPKR(b.used)}</span>
                {over && (
                  <span className="font-semibold" style={{ color: C.red }}>
                    Over by {fmtPKR(Math.abs(b.remaining))}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------- EXPENSES VIEW ---------------------------------- */
function ExpensesView({ expenses, headers, headerNameById, onAdd, onEdit, onDelete }) {
  const [search, setSearch] = useState("");
  const [headerFilter, setHeaderFilter] = useState("all");

  const filtered = useMemo(() => {
    return expenses
      .filter((e) => (headerFilter === "all" ? true : e.headerId === headerFilter))
      .filter((e) => {
        if (!search.trim()) return true;
        const s = search.toLowerCase();
        return e.description.toLowerCase().includes(s) || (e.vendor || "").toLowerCase().includes(s) || e.addedBy.toLowerCase().includes(s);
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [expenses, search, headerFilter]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 justify-between">
        <div className="flex items-center gap-2 flex-1">
          <div className="relative flex-1 max-w-xs">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" color={C.muted} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search description, vendor, added by…"
              style={{ ...inputStyle, paddingLeft: 32 }} />
          </div>
          <select value={headerFilter} onChange={(e) => setHeaderFilter(e.target.value)} style={{ ...inputStyle, maxWidth: 200 }}>
            <option value="all">All Headers</option>
            {headers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </div>
      </div>
      <div className="rounded-2xl shadow-sm overflow-hidden" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <ExpenseTable rows={filtered} headerNameById={headerNameById} onEdit={onEdit} onDelete={onDelete} />
      </div>
      <p className="text-xs" style={{ color: C.muted }}>{filtered.length} of {expenses.length} entries shown</p>
    </div>
  );
}

/* ---------------------------------- HISTORY VIEW ---------------------------------- */
function HistoryView({ history }) {
  const [search, setSearch] = useState("");
  const [buFilter, setBuFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [tillDate, setTillDate] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  const bus = useMemo(() => [...new Set(history.map((h) => h.bu).filter(Boolean))].sort(), [history]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return history.filter((h) => {
      if (buFilter !== "all" && h.bu !== buFilter) return false;
      if (typeFilter !== "all" && h.type !== typeFilter) return false;
      if (fromDate && h.date && h.date < fromDate) return false;
      if (tillDate && h.date && h.date > tillDate) return false;
      if (q && !`${h.description} ${h.bu} ${h.category}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [history, search, buFilter, typeFilter, fromDate, tillDate]);

  const totalExpense = filtered.filter((h) => h.type === "expense").reduce((s, h) => s + Number(h.amount || 0), 0);
  const totalInflow = filtered.filter((h) => h.type === "inflow").reduce((s, h) => s + Number(h.amount || 0), 0);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-4">

      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search description, BU or category\u2026"
          className="flex-1 min-w-[200px] rounded-xl px-3 py-2 text-sm"
          style={{ border: `1px solid ${C.border}` }}
        />
        <select
          value={buFilter}
          onChange={(e) => { setBuFilter(e.target.value); setPage(1); }}
          className="rounded-xl px-3 py-2 text-sm"
          style={{ border: `1px solid ${C.border}` }}
        >
          <option value="all">All BUs</option>
          {bus.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
          className="rounded-xl px-3 py-2 text-sm"
          style={{ border: `1px solid ${C.border}` }}
        >
          <option value="all">Expenses + Cash In</option>
          <option value="expense">Expenses only</option>
          <option value="inflow">Cash In only</option>
        </select>
        <div className="flex items-center gap-1.5">
          <label className="text-xs" style={{ color: C.muted }}>From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => { setFromDate(e.target.value); setPage(1); }}
            className="rounded-xl px-3 py-2 text-sm"
            style={{ border: `1px solid ${C.border}` }}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-xs" style={{ color: C.muted }}>Till</label>
          <input
            type="date"
            value={tillDate}
            onChange={(e) => { setTillDate(e.target.value); setPage(1); }}
            className="rounded-xl px-3 py-2 text-sm"
            style={{ border: `1px solid ${C.border}` }}
          />
        </div>
        {(fromDate || tillDate) && (
          <button
            onClick={() => { setFromDate(""); setTillDate(""); setPage(1); }}
            className="text-xs font-semibold px-3 py-2 rounded-xl"
            style={{ color: C.muted, border: `1px solid ${C.border}` }}
          >
            Clear dates
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KPICard label="Total Entries" value={String(filtered.length)} icon={ReceiptText} tone="blue" />
        <KPICard label="Total Expenses" value={fmtPKR(totalExpense)} icon={Wallet} tone="red" />
        <KPICard label="Total Cash In" value={fmtPKR(totalInflow)} icon={TrendingUp} tone="green" />
      </div>

      <div className="rounded-2xl shadow-sm overflow-hidden" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: C.bg }}>
                <th className="text-left px-4 py-2.5 font-semibold" style={{ color: C.muted }}>Date</th>
                <th className="text-left px-4 py-2.5 font-semibold" style={{ color: C.muted }}>BU</th>
                <th className="text-left px-4 py-2.5 font-semibold" style={{ color: C.muted }}>Category</th>
                <th className="text-left px-4 py-2.5 font-semibold" style={{ color: C.muted }}>Description</th>
                <th className="text-right px-4 py-2.5 font-semibold" style={{ color: C.muted }}>Amount</th>
                <th className="text-left px-4 py-2.5 font-semibold" style={{ color: C.muted }}>Type</th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: C.border }}>
              {pageRows.map((h, i) => (
                <tr key={i}>
                  <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: C.text }}>{h.date ? fmtDate(h.date) : "\u2014"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: C.text }}>{h.bu || "\u2014"}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: C.muted }}>{h.category || "\u2014"}</td>
                  <td className="px-4 py-2.5 max-w-md" style={{ color: C.text }}>{h.description || "\u2014"}</td>
                  <td className="px-4 py-2.5 text-right font-semibold whitespace-nowrap" style={{ color: h.type === "inflow" ? C.green : C.text }}>
                    {h.type === "inflow" ? "+" : ""}{fmtPKR(h.amount)}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <Badge tone={h.type === "inflow" ? "green" : "muted"}>{h.type === "inflow" ? "Cash In" : "Expense"}</Badge>
                  </td>
                </tr>
              ))}
              {pageRows.length === 0 && (
                <tr><td colSpan={6} className="text-center py-10 text-sm" style={{ color: C.muted }}>No matching entries.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 rounded-lg"
            style={{ border: `1px solid ${C.border}`, opacity: page === 1 ? 0.5 : 1 }}
          >
            Previous
          </button>
          <span style={{ color: C.muted }}>Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 rounded-lg"
            style={{ border: `1px solid ${C.border}`, opacity: page === totalPages ? 0.5 : 1 }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
/* ---------------------------------- REPORTS VIEW ---------------------------------- */
function ReportsView({ headers, expenses, headerStats, headerNameById }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [headerFilter, setHeaderFilter] = useState("all");
  const [vendorFilter, setVendorFilter] = useState("");
  const [addedByFilter, setAddedByFilter] = useState("all");

  const addedByOptions = useMemo(() => [...new Set(expenses.map((e) => e.addedBy))], [expenses]);

  const filtered = useMemo(() => {
    return expenses.filter((e) => {
      if (dateFrom && e.date < dateFrom) return false;
      if (dateTo && e.date > dateTo) return false;
      if (headerFilter !== "all" && e.headerId !== headerFilter) return false;
      if (vendorFilter.trim() && !(e.vendor || "").toLowerCase().includes(vendorFilter.trim().toLowerCase())) return false;
      if (addedByFilter !== "all" && e.addedBy !== addedByFilter) return false;
      return true;
    });
  }, [expenses, dateFrom, dateTo, headerFilter, vendorFilter, addedByFilter]);

  const filteredTotal = filtered.reduce((s, e) => s + Number(e.amount), 0);
  const scopedBudget = headerFilter === "all" ? headers.filter((h) => !isNoBudgetHeader(h.id)).reduce((s, h) => s + Number(h.budget), 0) : (isNoBudgetHeader(headerFilter) ? 0 : headers.find(h => h.id === headerFilter)?.budget || 0);
  // Remaining / utilization only compare budgeted spend against budget (Repairs & Maintenance has none).
  const budgetedFilteredTotal = filtered.filter((e) => !isNoBudgetHeader(e.headerId)).reduce((s, e) => s + Number(e.amount), 0);

  const byHeader = useMemo(() => {
    const map = {};
    filtered.forEach((e) => { map[e.headerId] = (map[e.headerId] || 0) + Number(e.amount); });
    return Object.entries(map).map(([id, amt]) => ({ id, name: headerNameById[id] || "—", amount: amt })).sort((a, b) => b.amount - a.amount);
  }, [filtered, headerNameById]);

  const byMonth = useMemo(() => {
    const map = {};
    filtered.forEach((e) => {
      const d = new Date(e.date + "T00:00:00");
      const key = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      map[key] = (map[key] || 0) + Number(e.amount);
    });
    return Object.entries(map).map(([month, amount]) => ({ month, amount }));
  }, [filtered]);

  const byDate = useMemo(() => {
    const map = {};
    filtered.forEach((e) => { map[e.date] = (map[e.date] || 0) + Number(e.amount); });
    return Object.entries(map).sort((a, b) => new Date(b[0]) - new Date(a[0]));
  }, [filtered]);

  const overBudget = headerStats.filter((h) => h.over);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl p-5 shadow-sm grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <Field label="Date From"><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputStyle} /></Field>
        <Field label="Date To"><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputStyle} /></Field>
        <Field label="Budget Header">
          <select value={headerFilter} onChange={(e) => setHeaderFilter(e.target.value)} style={inputStyle}>
            <option value="all">All Headers</option>
            {headers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </Field>
        <Field label="Vendor"><input value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} placeholder="Vendor name…" style={inputStyle} /></Field>
        <Field label="Added By">
          <select value={addedByFilter} onChange={(e) => setAddedByFilter(e.target.value)} style={inputStyle}>
            <option value="all">Everyone</option>
            {addedByOptions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="Scoped Budget" value={fmtPKR(scopedBudget)} icon={Wallet} tone="blue" />
        <KPICard label="Scoped Used" value={fmtPKR(filteredTotal)} sub={`${filtered.length} entries`} icon={ReceiptText} tone="purple" />
        <KPICard label="Scoped Remaining" value={fmtPKR(scopedBudget - budgetedFilteredTotal)} icon={TrendingUp} tone={scopedBudget - budgetedFilteredTotal < 0 ? "red" : "green"} />
        <KPICard label="Scoped Utilization" value={`${pct(budgetedFilteredTotal, scopedBudget).toFixed(1)}%`} icon={FileBarChart2} tone="blue" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-2xl shadow-sm overflow-hidden" style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="px-5 py-4 text-sm font-semibold" style={{ borderBottom: `1px solid ${C.border}`, color: C.text }}>Header-wise Spending</div>
          <div className="divide-y" style={{ borderColor: C.border }}>
            {byHeader.length === 0 && <div className="px-5 py-6 text-sm text-center" style={{ color: C.muted }}>No data for this filter.</div>}
            {byHeader.map((h) => (
              <div key={h.id} className="px-5 py-3 flex justify-between text-sm" style={{ borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.text }}>{h.name}</span>
                <span className="font-semibold" style={{ color: C.text }}>{fmtPKR(h.amount)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl shadow-sm overflow-hidden" style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="px-5 py-4 text-sm font-semibold" style={{ borderBottom: `1px solid ${C.border}`, color: C.text }}>Monthly Spending</div>
          <div className="divide-y" style={{ borderColor: C.border }}>
            {byMonth.length === 0 && <div className="px-5 py-6 text-sm text-center" style={{ color: C.muted }}>No data for this filter.</div>}
            {byMonth.map((m) => (
              <div key={m.month} className="px-5 py-3 flex justify-between text-sm" style={{ borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.text }}>{m.month}</span>
                <span className="font-semibold" style={{ color: C.text }}>{fmtPKR(m.amount)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl shadow-sm overflow-hidden" style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="px-5 py-4 text-sm font-semibold" style={{ borderBottom: `1px solid ${C.border}`, color: C.text }}>Highest Spending Headers</div>
          <div className="divide-y" style={{ borderColor: C.border }}>
            {byHeader.slice(0, 5).map((h, i) => (
              <div key={h.id} className="px-5 py-3 flex items-center gap-3 text-sm" style={{ borderBottom: `1px solid ${C.border}` }}>
                <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0" style={{ background: C.greenLight, color: C.green }}>{i + 1}</span>
                <span className="flex-1" style={{ color: C.text }}>{h.name}</span>
                <span className="font-semibold" style={{ color: C.text }}>{fmtPKR(h.amount)}</span>
              </div>
            ))}
            {byHeader.length === 0 && <div className="px-5 py-6 text-sm text-center" style={{ color: C.muted }}>No data for this filter.</div>}
          </div>
        </div>

        <div className="rounded-2xl shadow-sm overflow-hidden" style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="px-5 py-4 text-sm font-semibold flex items-center gap-1.5" style={{ borderBottom: `1px solid ${C.border}`, color: C.text }}>
            <AlertTriangle size={14} color={C.red} /> Over-Budget Headers
          </div>
          <div className="divide-y" style={{ borderColor: C.border }}>
            {overBudget.length === 0 && <div className="px-5 py-6 text-sm text-center" style={{ color: C.muted }}>No headers are currently over budget.</div>}
            {overBudget.map((h) => (
              <div key={h.id} className="px-5 py-3 flex justify-between text-sm" style={{ borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.text }}>{h.name}</span>
                <span className="font-semibold" style={{ color: C.red }}>+{fmtPKR(Math.abs(h.remaining))}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-2xl shadow-sm overflow-hidden" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <div className="px-5 py-4 text-sm font-semibold" style={{ borderBottom: `1px solid ${C.border}`, color: C.text }}>Date-wise Spending</div>
        <div className="max-h-72 overflow-y-auto divide-y" style={{ borderColor: C.border }}>
          {byDate.length === 0 && <div className="px-5 py-6 text-sm text-center" style={{ color: C.muted }}>No data for this filter.</div>}
          {byDate.map(([date, amt]) => (
            <div key={date} className="px-5 py-2.5 flex justify-between text-sm" style={{ borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.text }}>{fmtDate(date)}</span>
              <span className="font-semibold" style={{ color: C.text }}>{fmtPKR(amt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- EXPORT VIEW ---------------------------------- */
function toCSV(rows) {
  return rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}
function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Clean up the "Charged on" names from the petty cash sheet (typos, casing) so the same
// charging head doesn't show up twice in the export.
const CHARGED_ON_FIXES = {
  "auot os": "Auto Os", "auto os": "Auto Os", "wellows": "Wellows", "disrupt admiin": "Disrupt Admin",
  "squatwolf": "Squatwolf", "odoo erp": "ODOO ERP",
};
const normalizeChargedOn = (v) => {
  const t = String(v || "").replace(/\s+/g, " ").trim();
  if (!t) return "Unassigned";
  return CHARGED_ON_FIXES[t.toLowerCase()] || t;
};
// Expense rows from the petty cash sheet, one per charging head. The single entry the sheet
// split between two heads ("Rs.1800 charged to Disrupt Lab & Rs.1300 charged to Gz Systems")
// is split into two rows here.
function chargedOnLedgerRows() {
  const out = [];
  STATIC_HISTORY.filter((h) => h.type === "expense").forEach((h) => {
    const split = [...String(h.bu).matchAll(/Rs\.?\s*([\d,]+)\s*charged to\s*([^\n&]+)/gi)];
    if (split.length > 1) {
      split.forEach((m) => out.push({ ...h, bu: normalizeChargedOn(m[2]), amount: Number(m[1].replace(/,/g, "")), category: m[2].trim(), note: "Split entry" }));
    } else {
      out.push({ ...h, bu: normalizeChargedOn(h.bu) });
    }
  });
  return out;
}

function ExportView({ headers, expenses, headerNameById, notify }) {
  const exportExpenses = () => {
    const rows = [["Date", "Budget Header", "Segment", "Description", "Vendor/Purpose", "Amount (PKR)", "Mode of Payment", "BU", "Charged On", "Added By", "Remarks"]];
    expenses.forEach((e) => rows.push([fmtDate(e.date), headerNameById[e.headerId] || "—", e.segment || "", e.description, e.vendor || "", e.amount, e.mode || "", e.bu || "", normalizeChargedOn(e.chargedOn || e.bu), e.addedBy, e.remarks || ""]));
    downloadCSV(toCSV(rows), "expense-entries.csv");
    notify("Expense entries exported.");
  };
  const exportHeaders = () => {
    const rows = [["Header Name", "Allocated Budget", "Used", "Remaining", "Utilization %", "Status", "Start Date", "End Date"]];
    headers.forEach((h) => {
      const used = expenses.filter((e) => e.headerId === h.id).reduce((s, e) => s + Number(e.amount), 0);
      if (isNoBudgetHeader(h.id)) {
        rows.push([h.name, "No budget", used, "—", "—", h.status, fmtDate(h.startDate), h.endDate ? fmtDate(h.endDate) : "Till Date"]);
        return;
      }
      rows.push([h.name, h.budget, used, h.budget - used, pct(used, h.budget).toFixed(2), h.status, fmtDate(h.startDate), h.endDate ? fmtDate(h.endDate) : "Till Date"]);
    });
    downloadCSV(toCSV(rows), "budget-headers.csv");
    notify("Budget headers exported.");
  };
  const exportSummary = () => {
    const totalBudget = headers.filter((h) => !isNoBudgetHeader(h.id)).reduce((s, h) => s + Number(h.budget), 0);
    const noBudgetUsed = expenses.filter((e) => isNoBudgetHeader(e.headerId)).reduce((s, e) => s + Number(e.amount), 0);
    const totalUsed = expenses.reduce((s, e) => s + Number(e.amount), 0) - noBudgetUsed;
    const rows = [
      ["Metric", "Value"],
      ["Total Budget", totalBudget],
      ["Total Used", totalUsed],
      ["Total Remaining", totalBudget - totalUsed],
      ["Utilization %", pct(totalUsed, totalBudget).toFixed(2)],
      ["Spent on headers with no budget (Repairs & Maintenance)", noBudgetUsed],
      ["Period", "20 Jul 2026 to " + fmtDate(todayISO())],
    ];
    downloadCSV(toCSV(rows), "budget-summary.csv");
    notify("Summary report exported.");
  };

  const exportChargingHeads = () => {
    const ledger = chargedOnLedgerRows();
    const byHead = {};
    ledger.forEach((r) => {
      byHead[r.bu] = byHead[r.bu] || { count: 0, amount: 0 };
      byHead[r.bu].count += 1;
      byHead[r.bu].amount += Number(r.amount || 0);
    });
    const total = ledger.reduce((s, r) => s + Number(r.amount || 0), 0);
    const rows = [["Petty Cash — Charged On Summary (Jul 1 – Sep 14, 2026)"], ["Charged On", "No. of Entries", "Amount (PKR)", "% of Total"]];
    Object.entries(byHead).sort((a, b) => b[1].amount - a[1].amount).forEach(([head, v]) => {
      rows.push([head, v.count, v.amount, pct(v.amount, total).toFixed(2)]);
    });
    rows.push(["Total", ledger.length, total, "100.00"]);
    rows.push([]);
    rows.push(["Petty Cash — Entries by Charging Head"]);
    rows.push(["Date", "Charged On", "Expense Head", "Soft FM / Hard FM", "Description", "Amount (PKR)", "Note"]);
    [...ledger].sort((a, b) => a.bu.localeCompare(b.bu) || a.date.localeCompare(b.date)).forEach((r) => {
      rows.push([fmtDate(r.date), r.bu, r.category || "", r.fm || "", r.description, r.amount, r.note || ""]);
    });
    downloadCSV("\uFEFF" + toCSV(rows), "petty-cash-charging-heads.csv");
    notify("Charging heads exported.");
  };

  const cards = [
    { title: "Charging Heads (Petty Cash)", desc: `Export every petty cash expense from the sheet with who it was charged on, plus a total per charging head.`, action: exportChargingHeads },
    { title: "Expense Entries", desc: `Export all ${expenses.length} expense records with header, vendor, amount and remarks.`, action: exportExpenses },
    { title: "Budget Headers", desc: `Export all ${headers.length} budget headers with allocated, used, remaining and utilization.`, action: exportHeaders },
    { title: "Summary Report", desc: "Export overall totals and utilization for the current budget cycle.", action: exportSummary },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm" style={{ color: C.muted }}>Download workplace services budget data as CSV files, ready to open in Excel.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map((c) => (
          <div key={c.title} className="rounded-2xl p-5 shadow-sm flex flex-col" style={{ background: C.card, border: `1px solid ${C.border}` }}>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: C.greenLight }}>
              <Download size={17} color={C.green} />
            </div>
            <h4 className="text-sm font-semibold mb-1.5" style={{ color: C.text }}>{c.title}</h4>
            <p className="text-xs flex-1 mb-4" style={{ color: C.muted }}>{c.desc}</p>
            <button onClick={c.action} className="rounded-xl px-4 py-2.5 text-sm font-semibold" style={{ background: C.accent, color: C.text }}>
              Export CSV
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- SETTINGS VIEW ---------------------------------- */
function SettingsView({ onClear, headerCount, expenseCount, onPull, syncing, sheetConfigured }) {
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <div className="max-w-2xl space-y-5">
      <div className="rounded-2xl p-5 shadow-sm" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <h3 className="text-sm font-semibold mb-1" style={{ color: C.text }}>Workspace Info</h3>
        <p className="text-xs mb-4" style={{ color: C.muted }}>General information about this budget dashboard.</p>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between"><span style={{ color: C.muted }}>Organization</span><span style={{ color: C.text }}>Disrupt.com</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Department</span><span style={{ color: C.text }}>Workplace Services</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Budget Cycle</span><span style={{ color: C.text }}>20 Jul 2026 → Till Date</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Budget Headers</span><span style={{ color: C.text }}>{headerCount}</span></div>
          <div className="flex justify-between"><span style={{ color: C.muted }}>Expense Entries</span><span style={{ color: C.text }}>{expenseCount}</span></div>
        </div>
      </div>

      <div className="rounded-2xl p-5 shadow-sm" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: C.text }}>Google Sheet Sync</h3>
          <Badge tone={sheetConfigured ? "green" : "muted"}>{sheetConfigured ? "Connected" : "Not connected"}</Badge>
        </div>
        <p className="text-xs mb-4" style={{ color: C.muted }}>
          {sheetConfigured
            ? "New, edited and deleted expenses are pushed to the \"App Expense Log\" tab automatically."
            : "Add your Apps Script Web App URL in the code (GOOGLE_SHEETS_WEBHOOK_URL) to turn this on."}
        </p>
        <button
          onClick={onPull}
          disabled={!sheetConfigured || syncing}
          className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold"
          style={{ background: C.greenLight, color: C.green, opacity: !sheetConfigured || syncing ? 0.5 : 1 }}
        >
          <RotateCcw size={15} className={syncing ? "animate-spin" : ""} /> {syncing ? "Pulling…" : "Pull Latest from Sheet"}
        </button>
      </div>

      <div className="rounded-2xl p-5 shadow-sm" style={{ background: C.card, border: `1px solid ${C.border}` }}>
        <h3 className="text-sm font-semibold mb-1" style={{ color: C.text }}>Data Management</h3>
        <p className="text-xs mb-4" style={{ color: C.muted }}>Your data is saved automatically and stays available after refreshing.</p>
        <div className="flex flex-wrap gap-3">
          {!confirmClear ? (
            <button onClick={() => setConfirmClear(true)} className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold" style={{ background: C.redLight, color: C.red }}>
              <Trash2 size={15} /> Clear All Data
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: C.red }}>Are you sure? This can't be undone.</span>
              <button onClick={() => { onClear(); setConfirmClear(false); }} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white" style={{ background: C.red }}>Yes, clear</button>
              <button onClick={() => setConfirmClear(false)} className="rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: "#EEEEEE", color: C.muted }}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-2xl px-5 py-4" style={{ background: "#F0F0F1" }}>
        <Info size={16} color={C.blue} className="shrink-0 mt-0.5" />
        <p className="text-xs" style={{ color: "#3F3F46" }}>
          {sheetConfigured
            ? "Expenses saved on this device also sync to the shared Google Sheet, so other devices can pull the same data."
            : "Data currently persists in secure app storage tied to this dashboard. Ask Workplace Services IT if you'd like this connected to a shared Google Sheet or database for team-wide access."}
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------- EXPENSE MODAL ---------------------------------- */
function ExpenseModal({ headers, initial, onClose, onSave, headerStats, expenses, buStats, notify }) {
  const editingId = initial?.id || null;
  const initialHeaderId = initial?.headerId || (headers[0]?.id || "");
  const initialHeaderName = headers.find((h) => h.id === initialHeaderId)?.name || "";
  const [form, setForm] = useState({
    date: initial?.date || todayISO(),
    headerId: initialHeaderId,
    segment: initial?.segment || segmentsForHeader(initialHeaderName)[0] || "",
    description: initial?.description || "",
    amount: initial?.amount ?? "",
    mode: initial?.mode || PAYMENT_MODES[0],
    vendor: initial?.vendor || "",
    bu: initial?.bu || BU_OPTIONS[0],
    addedBy: initial?.addedBy || ADDED_BY_OPTIONS[0],
    status: initial?.status || STATUS_STAGES[0],
    imageData: initial?.imageData || null,
    imageName: initial?.imageName || "",
    documentData: initial?.documentData || null,
    documentName: initial?.documentName || "",
    email: initial?.email || "",
    remarks: initial?.remarks || "",
  });

  const selectedHeader = headerStats.find((h) => h.id === form.headerId);
  const projected = selectedHeader ? selectedHeader.used + Number(form.amount || 0) : 0;
  const willExceed = selectedHeader && !selectedHeader.noBudget && Number(form.amount) > 0 && projected > selectedHeader.budget;
  const segmentOptions = segmentsForHeader(selectedHeader?.name || "");
  const segmentStats = selectedHeader
    ? getSegmentBreakdown(selectedHeader.name, selectedHeader.id, expenses).find((s) => s.segment === form.segment)
    : null;
  const segmentProjected = segmentStats ? segmentStats.used + Number(form.amount || 0) : 0;
  const segmentWillExceed = segmentStats && segmentStats.budget > 0 && Number(form.amount) > 0 && segmentProjected > segmentStats.budget;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const onHeaderChange = (e) => {
    const newHeaderId = e.target.value;
    const newHeaderName = headers.find((h) => h.id === newHeaderId)?.name || "";
    const newSegments = segmentsForHeader(newHeaderName);
    setForm((f) => ({ ...f, headerId: newHeaderId, segment: newSegments[0] || "" }));
  };

  const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // ~1.5MB, keeps localStorage usable
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);

  const scanReceipt = async (dataUrl) => {
    setScanning(true);
    setScanProgress(0);
    try {
      const worker = await createWorker("eng", 1, {
        logger: (m) => {
          if (m.status === "recognizing text") setScanProgress(Math.round((m.progress || 0) * 100));
        },
      });
      const { data } = await worker.recognize(dataUrl);
      await worker.terminate();

      const parsed = parseReceiptText(data.text || "");
      setForm((f) => ({
        ...f,
        vendor: parsed.vendor || f.vendor,
        amount: parsed.amount !== "" ? parsed.amount : f.amount,
        date: parsed.date || f.date,
        description: parsed.description || f.description,
      }));
      notify?.("Receipt scanned — fields filled in, please double-check before saving.");
    } catch (err) {
      notify?.("Couldn't read the receipt automatically. Please fill the details manually.", "error");
    } finally {
      setScanning(false);
      setScanProgress(0);
    }
  };

  const onImageChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      notify?.("Please attach an image file.", "error");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      notify?.("Image is too large — please attach a file under 1.5MB.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setForm((f) => ({ ...f, imageData: reader.result, imageName: file.name }));
      // Scan automatically as soon as the receipt is attached — no extra click needed.
      scanReceipt(reader.result);
    };
    reader.readAsDataURL(file);
  };
  const removeImage = () => setForm((f) => ({ ...f, imageData: null, imageName: "" }));


  const MAX_DOC_BYTES = 3 * 1024 * 1024; // ~3MB
  const onDocumentChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_DOC_BYTES) {
      notify?.("Document is too large — please attach a file under 3MB.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, documentData: reader.result, documentName: file.name }));
    reader.readAsDataURL(file);
  };
  const removeDocument = () => setForm((f) => ({ ...f, documentData: null, documentName: "" }));

  return (
    <Modal title={editingId ? "Edit Expense" : "Add Expense"} onClose={onClose} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
        <div className="sm:col-span-2">
          {form.imageData ? (
            <div className="rounded-xl overflow-hidden mb-3" style={{ border: `1px solid ${C.border}` }}>
              <div className="flex items-center gap-3 px-3 py-2">
                <img src={form.imageData} alt="Receipt preview" className="w-12 h-12 object-cover rounded-lg" />
                <span className="text-xs flex-1 truncate" style={{ color: C.muted }}>{form.imageName}</span>
                <button type="button" onClick={removeImage} className="p-1.5 rounded-lg hover:bg-gray-100">
                  <X size={14} color={C.muted} />
                </button>
              </div>
              {scanning && (
                <div
                  className="flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold"
                  style={{ background: C.bg, color: C.muted, borderTop: `1px solid ${C.border}` }}
                >
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full border-2 animate-spin"
                    style={{ borderColor: `${C.muted} transparent ${C.muted} ${C.muted}` }}
                  />
                  Scanning receipt… {scanProgress}% — filling in details automatically
                </div>
              )}
              {!scanning && (
                <button
                  type="button"
                  onClick={() => scanReceipt(form.imageData)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold"
                  style={{ background: C.accent, color: C.text, borderTop: `1px solid ${C.border}` }}
                >
                  <Search size={13} />
                  Re-scan Receipt
                </button>
              )}
            </div>
          ) : (
            <label
              htmlFor="receipt-scan-input"
              className="mb-3 flex flex-col items-center justify-center gap-1.5 rounded-2xl px-4 py-6 cursor-pointer text-center"
              style={{ border: `1.5px dashed ${C.accent}`, background: C.bg }}
            >
              <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: C.accent }}>
                <Search size={18} color={C.text} />
              </div>
              <div className="text-sm font-semibold" style={{ color: C.text }}>Scan a Receipt</div>
              <div className="text-[11px]" style={{ color: C.muted }}>
                Snap or upload a photo — vendor, amount and date fill in automatically
              </div>
              <input id="receipt-scan-input" type="file" accept="image/*" onChange={onImageChange} className="hidden" />
            </label>
          )}
        </div>
        <Field label="Expense Date"><input type="date" value={form.date} onChange={set("date")} style={inputStyle} /></Field>
        <Field label="Budget Header">
          <select value={form.headerId} onChange={onHeaderChange} style={inputStyle}>
            {headers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </Field>
        <Field label="Segment">
          <select value={form.segment} onChange={set("segment")} style={inputStyle}>
            {segmentOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        {selectedHeader && selectedHeader.noBudget && (
          <div className="sm:col-span-2 -mt-1 mb-3 rounded-xl px-4 py-3 flex items-center justify-between text-xs" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
            <span style={{ color: C.muted }}>No budget for this header — amount is tracked for Finance</span>
            <span className="font-semibold tabular-nums" style={{ color: C.text }}>{fmtPKR(selectedHeader.used)} used</span>
          </div>
        )}
        {selectedHeader && !selectedHeader.noBudget && (
          <div className="sm:col-span-2 -mt-1 mb-3 space-y-2">
            <div className="rounded-xl px-4 py-3 grid grid-cols-3 gap-2" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>Header Budget</div>
                <div className="text-sm font-bold tabular-nums" style={{ color: C.text }}>{fmtPKR(selectedHeader.budget)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>Used So Far</div>
                <div className="text-sm font-bold tabular-nums" style={{ color: C.text }}>{fmtPKR(selectedHeader.used)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>Available</div>
                <div className="text-sm font-bold tabular-nums" style={{ color: selectedHeader.remaining < 0 ? C.red : C.green }}>{fmtPKR(selectedHeader.remaining)}</div>
              </div>
            </div>
            {segmentStats && segmentStats.budget > 0 && (
              <div className="rounded-xl px-4 py-3 grid grid-cols-3 gap-2" style={{ background: C.greenLight, border: `1px solid ${C.border}` }}>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide truncate" style={{ color: C.muted }} title={segmentStats.segment}>{segmentStats.segment}</div>
                  <div className="text-sm font-bold tabular-nums" style={{ color: C.text }}>{fmtPKR(segmentStats.budget)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>Used</div>
                  <div className="text-sm font-bold tabular-nums" style={{ color: C.text }}>{fmtPKR(segmentStats.used)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>Available</div>
                  <div className="text-sm font-bold tabular-nums" style={{ color: segmentStats.remaining < 0 ? C.red : C.green }}>{fmtPKR(segmentStats.remaining)}</div>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="sm:col-span-2">
          <Field label="Description"><input value={form.description} onChange={set("description")} placeholder="e.g. Lunch for Auto OS Team" style={inputStyle} /></Field>
        </div>
        <Field label="Amount (PKR)"><input type="number" min="0" value={form.amount} onChange={set("amount")} placeholder="0" style={inputStyle} /></Field>
        <Field label="Mode of Payment">
          <select value={form.mode} onChange={set("mode")} style={inputStyle}>
            {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="Vendor / Purpose"><input value={form.vendor} onChange={set("vendor")} placeholder="e.g. Prompt Cafe, 140-H" style={inputStyle} /></Field>
        <Field label="BU">
          <select value={form.bu} onChange={set("bu")} style={inputStyle}>
            {BU_OPTIONS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </Field>
        {(() => {
          const selectedBu = (buStats || []).find((b) => b.bu === form.bu);
          if (!selectedBu) return null;
          const isEnforced = form.bu === "Soft FM" || form.bu === "Hard FM";
          const willBeOver = isEnforced && selectedBu.budget > 0 && (selectedBu.used + Number(form.amount || 0)) > selectedBu.budget;
          return (
            <div className="sm:col-span-2 -mt-1 mb-1 flex items-center justify-between rounded-xl px-4 py-2.5 text-xs" style={{ background: willBeOver ? C.redLight : C.bg, border: `1px solid ${C.border}` }}>
              <span style={{ color: C.muted }}>{form.bu} budget</span>
              <span className="font-semibold tabular-nums" style={{ color: willBeOver ? C.red : C.text }}>
                {fmtPKR(selectedBu.budget)} / {fmtPKR(selectedBu.used)}
                {willBeOver && " — over budget"}
              </span>
            </div>
          );
        })()}
        <Field label="Added By">
          <select value={form.addedBy} onChange={set("addedBy")} style={inputStyle}>
            {ADDED_BY_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Email (optional)"><input type="email" value={form.email} onChange={set("email")} placeholder="name@disrupt.com" style={inputStyle} /></Field>
        <Field label="Attach Document (optional)">
          {form.documentData ? (
            <div className="flex items-center gap-3 rounded-xl px-3 py-2" style={{ border: `1px solid ${C.border}` }}>
              <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: C.greenLight }}>
                <FileText size={18} color={C.green} />
              </div>
              <span className="text-xs flex-1 truncate" style={{ color: C.muted }}>{form.documentName}</span>
              <button type="button" onClick={removeDocument} className="p-1.5 rounded-lg hover:bg-gray-100">
                <X size={14} color={C.muted} />
              </button>
            </div>
          ) : (
            <input type="file" onChange={onDocumentChange} style={inputStyle} />
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field label="Remarks (optional)"><input value={form.remarks} onChange={set("remarks")} style={inputStyle} /></Field>
        </div>
      </div>

      {segmentWillExceed && (
        <div className="flex items-start gap-2 rounded-xl px-4 py-3 mb-2" style={{ background: C.redLight }}>
          <AlertTriangle size={16} color={C.red} className="shrink-0 mt-0.5" />
          <div className="text-xs" style={{ color: "#7A241E" }}>
            <span className="font-semibold">This will exceed the {segmentStats.segment} segment budget</span> by {fmtPKR(segmentProjected - segmentStats.budget)}.
          </div>
        </div>
      )}
      {willExceed && (
        <div className="flex items-start gap-2 rounded-xl px-4 py-3 mb-2" style={{ background: C.redLight }}>
          <AlertTriangle size={16} color={C.red} className="shrink-0 mt-0.5" />
          <div className="text-xs" style={{ color: "#7A241E" }}>
            <span className="font-semibold">This will exceed the {selectedHeader.name} budget</span> by {fmtPKR(projected - selectedHeader.budget)}. The header will be marked Over Budget after saving.
          </div>
        </div>
      )}

      <div className="flex justify-end gap-3 mt-2">
        <button onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold" style={{ background: "#EEEEEE", color: C.muted }}>Cancel</button>
        <button onClick={() => onSave(form, editingId)} className="rounded-xl px-5 py-2.5 text-sm font-semibold" style={{ background: C.accent, color: C.text }}>
          {editingId ? "Save Changes" : "Add Expense"}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------------------------- HEADER MODAL ---------------------------------- */
function HeaderModal({ initial, onClose, onSave }) {
  const editingId = initial?.id || null;
  const [form, setForm] = useState({
    name: initial?.name || "",
    budget: initial?.budget ?? "",
    startDate: initial?.startDate || todayISO(),
    endDate: initial?.endDate || "",
    status: initial?.status || "Active",
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal title={editingId ? "Edit Budget Header" : "Add Budget Header"} onClose={onClose}>
      <Field label="Header Name"><input value={form.name} onChange={set("name")} placeholder="e.g. Refreshments" style={inputStyle} /></Field>
      <Field label="Allocated Budget (PKR)"><input type="number" min="0" value={form.budget} onChange={set("budget")} style={inputStyle} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start Date"><input type="date" value={form.startDate} onChange={set("startDate")} style={inputStyle} /></Field>
        <Field label="End Date (optional)"><input type="date" value={form.endDate} onChange={set("endDate")} style={inputStyle} /></Field>
      </div>
      <Field label="Status">
        <select value={form.status} onChange={set("status")} style={inputStyle}>
          <option>Active</option>
          <option>Inactive</option>
        </select>
      </Field>
      <div className="flex justify-end gap-3 mt-2">
        <button onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold" style={{ background: "#EEEEEE", color: C.muted }}>Cancel</button>
        <button onClick={() => onSave(form, editingId)} className="rounded-xl px-5 py-2.5 text-sm font-semibold" style={{ background: C.accent, color: C.text }}>
          {editingId ? "Save Changes" : "Add Header"}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------------------------- CONFIRM MODAL ---------------------------------- */
function ConfirmModal({ title, body, onCancel, onConfirm }) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="text-sm mb-6" style={{ color: C.muted }}>{body}</p>
      <div className="flex justify-end gap-3">
        <button onClick={onCancel} className="rounded-xl px-4 py-2.5 text-sm font-semibold" style={{ background: "#EEEEEE", color: C.muted }}>Cancel</button>
        <button onClick={onConfirm} className="rounded-xl px-5 py-2.5 text-sm font-semibold text-white" style={{ background: C.red }}>Delete</button>
      </div>
    </Modal>
  );
}
