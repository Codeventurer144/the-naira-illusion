import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { parseMonthlyRow, validateMonthlyData, simulate, rolling12Months } from "./simulator.js";

const COLORS = {
  nominal: "#f0a202",
  real: "#b54332",
  usd: "#4676a6",
  green: "#2f7d5b",
  red: "#b54332",
  ink: "#11110f",
  muted: "#6f6a61",
  paper: "#f4f0e7"
};

const STRATEGY_LABELS = {
  savings: "Savings",
  "3m": "3-month deposit",
  "6m": "6-month deposit",
  "12m": "12-month deposit"
};

const state = {
  data: [],
  rolling: [],
  strategy: "savings",
  result: null,
  scrubIndex: 0,
  painStrategy: "savings"
};

const el = (id) => document.getElementById(id);
const fmtNaira = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 });
const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtPct = d3.format("+.1f");
const fmtPct2 = d3.format("+.2f");
const monthFmt = d3.timeFormat("%b %Y");
const parseMonth = d3.timeParse("%Y-%m");

function monthLabel(s) { return monthFmt(parseMonth(s)); }
function pctClass(v) { return v >= 0 ? "positive" : "negative"; }
function signedPct(v, digits = 1) { return `${digits === 1 ? fmtPct(v * 100) : fmtPct2(v * 100)}%`; }
function safeAmount(v) { return Number.isFinite(v) ? v : 1_000_000; }

async function init() {
  try {
    const raw = await d3.csv("./data/naira_illusion_monthly.csv", parseMonthlyRow);
    validateMonthlyData(raw);
    state.data = raw;
    state.rolling = rolling12Months(raw);
    populateDateControls();
    bindControls();
    restoreFromUrl();
    runExperiment({ updateUrl: false });
    drawReturnStrip();
    renderReturnSummary();
    renderPainRanking();
    el("positive-savings-count").textContent = state.rolling.filter(d => d.strategy === "savings" && d.status === "ok" && d.real_return_pct > 0).length;
    window.addEventListener("resize", debounce(() => {
      if (state.result?.series?.length) drawWealthChart(state.result.series, state.scrubIndex, false);
      drawReturnStrip();
    }, 120));
  } catch (error) {
    console.error(error);
    el("form-status").textContent = "The data could not be loaded. Serve this folder over HTTP (for example GitHub Pages or a local server) rather than opening index.html directly.";
  }
}

function populateDateControls() {
  const options = state.data.map(d => `<option value="${d.date}">${monthLabel(d.date)}</option>`).join("");
  el("start-date").innerHTML = options;
  el("end-date").innerHTML = options;
  el("start-date").value = state.data[0].date;
  el("end-date").value = state.data.at(-1).date;
}

function bindControls() {
  document.querySelectorAll(".segment").forEach(button => {
    button.addEventListener("click", () => setStrategy(button.dataset.strategy));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...document.querySelectorAll(".segment")];
      const i = buttons.indexOf(button);
      const next = event.key === "ArrowRight" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next].focus(); buttons[next].click();
    });
  });

  el("experiment-form").addEventListener("submit", (event) => {
    event.preventDefault();
    runExperiment();
  });

  el("time-scrubber").addEventListener("input", (event) => {
    state.scrubIndex = +event.target.value;
    updateSnapshot();
    updateCursor();
  });

  document.querySelectorAll(".pain-choice").forEach(button => {
    button.addEventListener("click", () => {
      state.painStrategy = button.dataset.strategy;
      document.querySelectorAll(".pain-choice").forEach(b => b.classList.toggle("active", b === button));
      renderPainRanking();
    });
  });

  el("copy-result").addEventListener("click", copyResult);
}

function setStrategy(strategy) {
  state.strategy = strategy;
  document.querySelectorAll(".segment").forEach(button => {
    const active = button.dataset.strategy === strategy;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function restoreFromUrl() {
  const q = new URLSearchParams(location.search);
  const balance = +q.get("balance");
  const start = q.get("start");
  const end = q.get("end");
  const strategy = q.get("strategy");
  if (Number.isFinite(balance) && balance >= 1000) el("starting-balance").value = balance;
  if (state.data.some(d => d.date === start)) el("start-date").value = start;
  if (state.data.some(d => d.date === end)) el("end-date").value = end;
  if (["savings", "3m", "6m", "12m"].includes(strategy)) setStrategy(strategy);
}

function runExperiment({ updateUrl = true } = {}) {
  const startingBalance = safeAmount(+el("starting-balance").value);
  const startDate = el("start-date").value;
  const endDate = el("end-date").value;
  el("form-status").textContent = "";

  if (endDate < startDate) {
    el("form-status").textContent = "Choose an end month that comes after the start month.";
    return;
  }

  const result = simulate(state.data, { strategy: state.strategy, startDate, endDate, startingBalance });
  state.result = result;

  if (result.status !== "ok") {
    el("form-status").textContent = `${STRATEGY_LABELS[state.strategy]} cannot be rolled through this selection because the historical rate needed at ${monthLabel(result.missing_date)} is unavailable. No substitute or interpolation has been used.`;
    renderIncomplete(result);
    if (result.series.length) {
      state.scrubIndex = result.series.length - 1;
      drawWealthChart(result.series, state.scrubIndex);
      setupScrubber();
    }
    return;
  }

  state.scrubIndex = result.series.length - 1;
  renderSummary(result);
  drawWealthChart(result.series, state.scrubIndex);
  setupScrubber();
  updateSnapshot();
  updateReveal(result);
  if (updateUrl) writeUrl();
}

function renderIncomplete(result) {
  const last = result.series.at(-1);
  const fields = ["metric-nominal", "metric-real", "metric-usd", "metric-nominal-change", "metric-real-change", "metric-usd-change"];
  fields.forEach(id => el(id).textContent = "—");
  el("result-headline").textContent = `The historical series stops at ${monthLabel(result.missing_date)} for this benchmark.`;
  if (last) {
    el("metric-nominal").textContent = fmtNaira.format(last.nominal);
    el("metric-real").textContent = fmtNaira.format(last.real);
    el("metric-usd").textContent = fmtUsd.format(last.usd);
  }
  el("reveal-sentence").innerHTML = `This selection needs a ${STRATEGY_LABELS[state.strategy]} rate in <strong>${monthLabel(result.missing_date)}</strong>, but that source cell is unresolved. The experience stops rather than fabricate a return.`;
}

function renderSummary(result) {
  const s = result.summary;
  el("metric-nominal").textContent = fmtNaira.format(s.nominal);
  el("metric-real").textContent = fmtNaira.format(s.real);
  el("metric-usd").textContent = fmtUsd.format(s.usd);
  setChange("metric-nominal-change", s.nominal_return, "nominal return");
  setChange("metric-real-change", s.real_return, "real return");
  setChange("metric-usd-change", s.usd_change, "vs starting USD value");

  const gap = s.nominal - s.real;
  el("result-headline").textContent = s.real_return < 0
    ? `The statement gained ${fmtNaira.format(s.interest_earned)}. Inflation opened a ${fmtNaira.format(gap)} gap.`
    : "This period increased both the account balance and its purchasing power.";
}

function setChange(id, value, suffix) {
  const node = el(id);
  node.className = `metric-change ${pctClass(value)}`;
  node.textContent = `${signedPct(value)} ${suffix}`;
}

function setupScrubber() {
  const range = el("time-scrubber");
  range.max = Math.max(0, state.result.series.length - 1);
  range.value = state.scrubIndex;
}

function updateSnapshot() {
  if (!state.result?.series?.length) return;
  const p = state.result.series[state.scrubIndex];
  const start = state.result.starting_balance;
  const startUsd = state.result.series[0].usd;
  el("scrub-date").textContent = monthLabel(p.date);
  el("snap-nominal").textContent = fmtNaira.format(p.nominal);
  el("snap-interest").textContent = fmtNaira.format(p.nominal - start);
  el("snap-real").textContent = fmtNaira.format(p.real);
  el("snap-inflation").textContent = fmtNaira.format(p.nominal - p.real);
  el("snap-usd").textContent = fmtUsd.format(p.usd);
  el("snap-usd-change").textContent = signedPct(p.usd / startUsd - 1);
}

function drawWealthChart(series, cursorIndex = series.length - 1, animate = true) {
  const root = d3.select("#wealth-chart");
  root.selectAll("*").remove();
  if (!series.length) return;

  const host = el("wealth-chart");
  const width = Math.max(320, host.clientWidth);
  const height = Math.max(380, Math.min(560, width * .52));
  const margin = { top: 26, right: 24, bottom: 46, left: width < 600 ? 42 : 56 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const dates = series.map(d => parseMonth(d.date));

  const yValues = series.flatMap(d => [d.nominal_index, d.real_index, d.usd_index]);
  const yMin = Math.max(0, d3.min(yValues) * .86);
  const yMax = d3.max(yValues) * 1.08;
  const x = d3.scaleTime().domain(d3.extent(dates)).range([0, innerW]);
  const y = d3.scaleLinear().domain([yMin, yMax]).nice().range([innerH, 0]);

  const svg = root.append("svg").attr("width", width).attr("height", height).attr("viewBox", `0 0 ${width} ${height}`);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(""));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${innerH})`).call(d3.axisBottom(x).ticks(width < 600 ? 4 : 7).tickSizeOuter(0));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}`));

  if (y.domain()[0] <= 100 && y.domain()[1] >= 100) {
    g.append("line").attr("class", "reference-line").attr("x1", 0).attr("x2", innerW).attr("y1", y(100)).attr("y2", y(100));
    g.append("text").attr("class", "reference-label").attr("x", innerW).attr("y", y(100) - 7).attr("text-anchor", "end").text("starting wealth = 100");
  }

  const lines = [
    { key: "nominal_index", color: COLORS.nominal },
    { key: "real_index", color: COLORS.real },
    { key: "usd_index", color: COLORS.usd }
  ];
  const line = key => d3.line().x(d => x(parseMonth(d.date))).y(d => y(d[key])).curve(d3.curveMonotoneX);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  lines.forEach(item => {
    const path = g.append("path").datum(series).attr("fill", "none").attr("stroke", item.color).attr("stroke-width", 3).attr("d", line(item.key));
    if (animate && !reduceMotion) {
      const length = path.node().getTotalLength();
      path.attr("stroke-dasharray", `${length} ${length}`).attr("stroke-dashoffset", length)
        .transition().duration(950).ease(d3.easeCubicOut).attr("stroke-dashoffset", 0);
    }
  });

  const cursor = g.append("g").attr("class", "cursor-layer");
  cursor.append("line").attr("class", "chart-cursor").attr("y1", 0).attr("y2", innerH);
  lines.forEach(item => cursor.append("circle").attr("class", `cursor-dot dot-${item.key}`).attr("r", 5).attr("fill", item.color));

  g.append("rect").attr("width", innerW).attr("height", innerH).attr("fill", "transparent").style("cursor", "crosshair")
    .on("pointermove", (event) => {
      const [mx] = d3.pointer(event);
      const target = x.invert(mx);
      const bisect = d3.bisector(d => parseMonth(d.date)).center;
      const i = Math.max(0, Math.min(series.length - 1, bisect(series, target)));
      state.scrubIndex = i;
      el("time-scrubber").value = i;
      updateSnapshot();
      updateCursor();
      showWealthTooltip(event, series[i]);
    })
    .on("pointerleave", () => { el("wealth-tooltip").hidden = true; });

  state.wealthChart = { x, y, g, series, innerH, margin, host };
  state.scrubIndex = Math.min(cursorIndex, series.length - 1);
  updateCursor();
}

function updateCursor() {
  const chart = state.wealthChart;
  if (!chart || !chart.series[state.scrubIndex]) return;
  const p = chart.series[state.scrubIndex];
  const cx = chart.x(parseMonth(p.date));
  const layer = chart.g.select(".cursor-layer");
  layer.select("line").attr("x1", cx).attr("x2", cx);
  layer.select(".dot-nominal_index").attr("cx", cx).attr("cy", chart.y(p.nominal_index));
  layer.select(".dot-real_index").attr("cx", cx).attr("cy", chart.y(p.real_index));
  layer.select(".dot-usd_index").attr("cx", cx).attr("cy", chart.y(p.usd_index));
}

function showWealthTooltip(event, p) {
  const tip = el("wealth-tooltip");
  const shell = tip.closest(".chart-shell").getBoundingClientRect();
  tip.innerHTML = `<strong>${monthLabel(p.date)}</strong>
    <div class="tooltip-row"><span>Nominal</span><span>${p.nominal_index.toFixed(1)}</span></div>
    <div class="tooltip-row"><span>Purchasing power</span><span>${p.real_index.toFixed(1)}</span></div>
    <div class="tooltip-row"><span>USD value</span><span>${p.usd_index.toFixed(1)}</span></div>`;
  tip.hidden = false;
  const left = Math.min(shell.width - 280, Math.max(8, event.clientX - shell.left + 14));
  const top = Math.max(8, event.clientY - shell.top - 105);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function drawReturnStrip() {
  const valid = state.rolling;
  const host = el("return-strip");
  d3.select(host).selectAll("*").remove();
  if (!valid.length) return;

  const minWidth = 880;
  const width = Math.max(minWidth, host.clientWidth || minWidth);
  const height = 280;
  const margin = { top: 30, right: 22, bottom: 42, left: 95 };
  const innerW = width - margin.left - margin.right;
  const rowH = 38;
  const strategies = ["savings", "3m", "6m", "12m"];
  const starts = [...new Set(valid.map(d => d.start_date))].sort();
  const x = d3.scaleBand().domain(starts).range([0, innerW]).paddingInner(.08);
  const y = d3.scaleBand().domain(strategies).range([0, rowH * strategies.length]).padding(.18);
  const color = d3.scaleLinear().domain([-22, 0, 3]).range([COLORS.red, "#37342f", COLORS.green]).clamp(true);

  const svg = d3.select(host).append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.selectAll("rect.return-cell").data(valid).join("rect")
    .attr("class", "return-cell")
    .attr("x", d => x(d.start_date))
    .attr("y", d => y(d.strategy))
    .attr("width", x.bandwidth())
    .attr("height", y.bandwidth())
    .attr("rx", 1)
    .attr("fill", d => d.status === "ok" ? color(d.real_return_pct) : "rgba(255,255,255,.08)")
    .on("pointerenter pointermove", showStripTooltip)
    .on("pointerleave", () => { el("strip-tooltip").hidden = true; });

  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat(d => STRATEGY_LABELS[d].replace(" deposit", ""))).call(g => g.select(".domain").remove());

  const yearStarts = starts.filter(s => s.endsWith("-01"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${rowH * strategies.length + 8})`)
    .call(d3.axisBottom(x).tickValues(yearStarts.filter((_, i) => width < 950 ? i % 2 === 0 : true)).tickFormat(d => d.slice(0,4)).tickSize(0))
    .call(g => g.select(".domain").remove());
}

function showStripTooltip(event, d) {
  const tip = el("strip-tooltip");
  const shell = tip.closest(".chart-shell").getBoundingClientRect();
  tip.innerHTML = d.status === "ok"
    ? `<strong>${STRATEGY_LABELS[d.strategy]}</strong><div>${monthLabel(d.start_date)} → ${monthLabel(d.end_date)}</div><div class="tooltip-row"><span>Real return</span><span>${fmtPct2(d.real_return_pct)}%</span></div><div class="tooltip-row"><span>Nominal return</span><span>${fmtPct2(d.nominal_return_pct)}%</span></div>`
    : `<strong>${STRATEGY_LABELS[d.strategy]}</strong><div>Rate unavailable for this rolling window.</div>`;
  tip.hidden = false;
  tip.style.left = `${Math.min(shell.width - 280, Math.max(8, event.clientX - shell.left + 12))}px`;
  tip.style.top = `${Math.max(8, event.clientY - shell.top - 105)}px`;
}

function renderReturnSummary() {
  const strategies = ["savings", "3m", "6m", "12m"];
  el("return-summary").innerHTML = strategies.map(strategy => {
    const valid = state.rolling.filter(d => d.strategy === strategy && d.status === "ok");
    const wins = valid.filter(d => d.real_return_pct > 0).length;
    const share = valid.length ? wins / valid.length : 0;
    return `<div class="return-stat"><span>${STRATEGY_LABELS[strategy]}</span><strong>${d3.format(".0%")(share)}</strong><span>${wins} of ${valid.length} windows beat inflation</span></div>`;
  }).join("");
}

function renderPainRanking() {
  const rows = state.rolling
    .filter(d => d.strategy === state.painStrategy && d.status === "ok" && Number.isFinite(d.real_return_pct))
    .sort((a,b) => a.real_return_pct - b.real_return_pct)
    .slice(0, 5);
  const maxAbs = d3.max(rows, d => Math.abs(d.real_return_pct)) || 1;
  el("pain-ranking").innerHTML = rows.map((d, i) => `
    <div class="pain-row">
      <div class="pain-rank">0${i+1}</div>
      <div class="pain-period"><strong>${monthLabel(d.start_date)} → ${monthLabel(d.end_date)}</strong><span>${fmtPct2(d.nominal_return_pct)}% nominal return</span></div>
      <div class="pain-bar-track" aria-hidden="true"><div class="pain-bar" style="width:${Math.abs(d.real_return_pct)/maxAbs*100}%"></div></div>
      <div class="pain-value">${fmtPct2(d.real_return_pct)}%</div>
    </div>`).join("");
}

function updateReveal(result) {
  const s = result.summary;
  el("reveal-sentence").innerHTML = `Your <strong>${fmtNaira.format(result.starting_balance)}</strong> became <strong>${fmtNaira.format(s.nominal)}</strong> on the statement, retained <strong>${fmtNaira.format(s.real)}</strong> of its ${monthLabel(result.start_date)} purchasing power, and became <strong>${fmtUsd.format(s.usd)}</strong> at the CBN USD/NGN rate.`;
}

async function copyResult() {
  if (!state.result?.summary) return;
  const s = state.result.summary;
  const text = `The Naira Illusion: ${fmtNaira.format(state.result.starting_balance)} using the ${STRATEGY_LABELS[state.result.strategy]} benchmark from ${monthLabel(state.result.start_date)} to ${monthLabel(state.result.end_date)} became ${fmtNaira.format(s.nominal)} nominally, ${fmtNaira.format(s.real)} in start-date purchasing power, and ${fmtUsd.format(s.usd)} at the CBN official/reference USD/NGN rate.`;
  try {
    await navigator.clipboard.writeText(text);
    const button = el("copy-result");
    const old = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => button.textContent = old, 1400);
  } catch {
    el("form-status").textContent = "Copy is unavailable in this browser. You can select the final result text manually.";
  }
}

function writeUrl() {
  const q = new URLSearchParams({
    balance: String(Math.round(+el("starting-balance").value || 1_000_000)),
    start: el("start-date").value,
    end: el("end-date").value,
    strategy: state.strategy
  });
  history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`);
}

function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

init();