import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { parseMonthlyRow, validateMonthlyData, simulate, rolling12Months } from "./simulator.js";

const COLORS = {
  nominal: "#f6b84a",
  real: "#ff7b72",
  usd: "#7bb7ff",
  green: "#6fe6a7",
  red: "#ff7b72",
  cyan: "#62d6c7",
  text: "#eefaf6",
  muted: "#9dc8bd",
  grid: "rgba(203,238,229,.09)"
};

const STRATEGY_LABELS = {
  savings: "Savings",
  "3m": "3-month deposit",
  "6m": "6-month deposit",
  "12m": "12-month deposit"
};

const PAGE_TITLES = {
  overview: "Overview",
  simulator: "Simulator",
  history: "Historical returns",
  pain: "Loss periods",
  methodology: "Methodology"
};

const state = {
  data: [],
  rolling: [],
  strategy: "savings",
  result: null,
  scrubIndex: 0,
  painStrategy: "savings",
  activePage: "overview"
};

const el = id => document.getElementById(id);
const fmtNaira = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 });
const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtInt = new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 });
const fmtPct = d3.format("+.1f");
const fmtPct2 = d3.format("+.2f");
const monthFmt = d3.timeFormat("%b %Y");
const parseMonth = d3.timeParse("%Y-%m");

function monthLabel(s) { return monthFmt(parseMonth(s)); }
function pctClass(v) { return v >= 0 ? "positive" : "negative"; }
function signedPct(v, digits = 1) { return `${digits === 1 ? fmtPct(v * 100) : fmtPct2(v * 100)}%`; }
function signedPctPoints(v) { return `${fmtPct2(v)}%`; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function parseAmount(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) && number >= 1000 ? number : 1_000_000;
}

function formatAmountInput() {
  const input = el("starting-balance");
  const amount = parseAmount(input.value);
  input.value = fmtInt.format(Math.round(amount));
}

function durationText(startDate, endDate) {
  const start = parseMonth(startDate);
  const end = parseMonth(endDate);
  const months = Math.max(0, (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth());
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years && rem) return `${years} year${years === 1 ? "" : "s"}, ${rem} month${rem === 1 ? "" : "s"}`;
  if (years) return `${years} year${years === 1 ? "" : "s"}`;
  return `${months} month${months === 1 ? "" : "s"}`;
}

async function init() {
  try {
    const raw = await d3.csv("./data/naira_illusion_monthly.csv", parseMonthlyRow);
    validateMonthlyData(raw);
    state.data = raw;
    state.rolling = rolling12Months(raw);

    populateDateControls();
    bindControls();
    restoreFromUrl();
    formatAmountInput();

    const wins = state.rolling.filter(d => d.strategy === "savings" && d.status === "ok" && d.real_return_pct > 0).length;
    el("positive-savings-count").textContent = wins;

    runExperiment({ updateUrl: false });
    drawReturnStrip();
    renderReturnSummary();
    drawRollingReturnChart();
    renderPainRanking();
    updateHistoricalExplanation();

    window.addEventListener("resize", debounce(redrawVisibleCharts, 140));
  } catch (error) {
    console.error(error);
    el("form-status").textContent = "The data could not be loaded. Please refresh the page or check the published data file.";
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
  document.querySelectorAll(".nav-item").forEach(button => {
    button.addEventListener("click", () => switchPage(button.dataset.pageTarget));
  });

  document.querySelectorAll(".benchmark-button").forEach(button => {
    button.addEventListener("click", () => setStrategy(button.dataset.strategy));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...document.querySelectorAll(".benchmark-button")];
      const i = buttons.indexOf(button);
      const next = event.key === "ArrowRight" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
      buttons[next].click();
    });
  });

  const amount = el("starting-balance");
  amount.addEventListener("focus", () => {
    amount.value = String(parseAmount(amount.value));
    amount.select();
  });
  amount.addEventListener("input", () => {
    amount.value = amount.value.replace(/[^0-9]/g, "");
  });
  amount.addEventListener("blur", formatAmountInput);

  el("experiment-form").addEventListener("submit", event => {
    event.preventDefault();
    formatAmountInput();
    runExperiment();
  });

  el("time-scrubber").addEventListener("input", event => {
    state.scrubIndex = +event.target.value;
    updateSnapshot();
    updateAllCursors();
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

function switchPage(page) {
  if (!PAGE_TITLES[page]) return;
  state.activePage = page;
  document.querySelectorAll(".dashboard-page").forEach(section => section.classList.toggle("active", section.dataset.page === page));
  document.querySelectorAll(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.pageTarget === page));
  el("active-page-title").textContent = PAGE_TITLES[page];

  requestAnimationFrame(() => {
    if (page === "overview" && state.result?.series?.length) {
      drawWealthChart("#overview-wealth-chart", "#overview-tooltip", state.result.series, state.scrubIndex, false, 300, "overview");
      drawInflationRateChart();
      drawRetainedChart();
    }
    if (page === "simulator" && state.result?.series?.length) {
      drawWealthChart("#simulator-wealth-chart", "#simulator-tooltip", state.result.series, state.scrubIndex, false, 480, "simulator");
    }
    if (page === "history") {
      drawReturnStrip();
      drawRollingReturnChart();
    }
  });
}

function setStrategy(strategy) {
  state.strategy = strategy;
  document.querySelectorAll(".benchmark-button").forEach(button => {
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

  if (Number.isFinite(balance) && balance >= 1000) el("starting-balance").value = fmtInt.format(balance);
  if (state.data.some(d => d.date === start)) el("start-date").value = start;
  if (state.data.some(d => d.date === end)) el("end-date").value = end;
  if (["savings", "3m", "6m", "12m"].includes(strategy)) setStrategy(strategy);
}

function runExperiment({ updateUrl = true } = {}) {
  const startingBalance = parseAmount(el("starting-balance").value);
  const startDate = el("start-date").value;
  const endDate = el("end-date").value;
  el("form-status").textContent = "";

  if (endDate < startDate) {
    el("form-status").textContent = "The end month must come after the start month.";
    return;
  }

  const result = simulate(state.data, { strategy: state.strategy, startDate, endDate, startingBalance });
  state.result = result;
  state.scrubIndex = Math.max(0, result.series.length - 1);

  updateScenarioChip();
  setupScrubber();

  if (result.status !== "ok") {
    renderIncomplete(result);
    if (result.series.length) {
      drawAllScenarioCharts(false);
      updateSnapshot();
    }
    if (updateUrl) writeUrl();
    return;
  }

  renderSummary(result);
  updateSnapshot();
  updateExplanations(result);
  drawAllScenarioCharts(true);

  if (updateUrl) writeUrl();
}

function updateScenarioChip() {
  const amount = parseAmount(el("starting-balance").value);
  el("scenario-chip").textContent = `${fmtNaira.format(amount)} · ${STRATEGY_LABELS[state.strategy]} · ${monthLabel(el("start-date").value)} — ${monthLabel(el("end-date").value)}`;
}

function renderIncomplete(result) {
  const last = result.series.at(-1);
  ["metric-nominal", "metric-real", "metric-usd", "metric-real-return"].forEach(id => el(id).textContent = "—");
  ["metric-nominal-change", "metric-real-change", "metric-usd-change"].forEach(id => {
    el(id).textContent = "Incomplete historical rate";
    el(id).className = "kpi-delta neutral";
  });
  el("metric-duration").textContent = durationText(result.start_date, result.end_date);

  if (last) {
    el("metric-nominal").textContent = fmtNaira.format(last.nominal);
    el("metric-real").textContent = fmtNaira.format(last.real);
    el("metric-usd").textContent = fmtUsd.format(last.usd);
  }

  const message = `This scenario needs a ${STRATEGY_LABELS[result.strategy]} rate for ${monthLabel(result.missing_date)}, but that historical rate is unavailable in the source data. The dashboard stops the calculation at that point rather than estimating or substituting a value.`;
  el("form-status").textContent = message;
  el("overview-explanation").textContent = message;
  el("simulator-explanation").textContent = message;
}

function renderSummary(result) {
  const s = result.summary;
  el("metric-nominal").textContent = fmtNaira.format(s.nominal);
  el("metric-real").textContent = fmtNaira.format(s.real);
  el("metric-usd").textContent = fmtUsd.format(s.usd);
  el("metric-real-return").textContent = signedPct(s.real_return);
  el("metric-duration").textContent = durationText(result.start_date, result.end_date);

  setDelta("metric-nominal-change", s.nominal_return, "change in account balance");
  setDelta("metric-real-change", s.real_return, "change in purchasing power");
  setDelta("metric-usd-change", s.usd_change, "change in official-rate USD value");
}

function setDelta(id, value, suffix) {
  const node = el(id);
  node.className = `kpi-delta ${pctClass(value)}`;
  node.textContent = `${signedPct(value)} · ${suffix}`;
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

function updateExplanations(result) {
  const s = result.summary;
  const period = durationText(result.start_date, result.end_date);
  const realLoss = Math.max(0, -s.real_return * 100);
  const realGain = Math.max(0, s.real_return * 100);
  const retainedShare = s.real / result.starting_balance * 100;
  const interest = s.nominal - result.starting_balance;

  let overview;
  if (s.real_return < 0) {
    overview = `If you saved ${fmtNaira.format(result.starting_balance)} using the ${STRATEGY_LABELS[result.strategy]} benchmark from ${monthLabel(result.start_date)} to ${monthLabel(result.end_date)} (${period}), the simulated account balance would end at ${fmtNaira.format(s.nominal)}. That is ${fmtNaira.format(interest)} above the amount you started with. However, after adjusting for inflation, the end balance would have the same purchasing power as about ${fmtNaira.format(s.real)} in your starting month. In practical terms, your purchasing power would have fallen by ${realLoss.toFixed(1)}%, even though the account balance increased.`;
  } else {
    overview = `If you saved ${fmtNaira.format(result.starting_balance)} using the ${STRATEGY_LABELS[result.strategy]} benchmark from ${monthLabel(result.start_date)} to ${monthLabel(result.end_date)} (${period}), the simulated account balance would end at ${fmtNaira.format(s.nominal)}. After adjusting for inflation, that would be equivalent to about ${fmtNaira.format(s.real)} in your starting month's purchasing power, which represents a real gain of ${realGain.toFixed(1)}%.`;
  }

  const simulator = `The chart starts all three measures at an index of 100 so they can be compared on the same scale. The account-balance line shows how the naira amount grows with the selected deposit benchmark. The purchasing-power line adjusts that balance for inflation, while the USD line converts it at the CBN official/reference rate. At the end of this scenario, the account balance is ${fmtNaira.format(s.nominal)}, its inflation-adjusted value is ${fmtNaira.format(s.real)}, and its official-rate USD value is ${fmtUsd.format(s.usd)}. The inflation-adjusted value retains ${retainedShare.toFixed(1)}% of the purchasing power of the starting amount.`;

  el("overview-explanation").textContent = overview;
  el("simulator-explanation").textContent = simulator;
}

function updateHistoricalExplanation() {
  const savings = state.rolling.filter(d => d.strategy === "savings" && d.status === "ok");
  const positive = savings.filter(d => d.real_return_pct > 0).length;
  const worst = [...savings].sort((a, b) => a.real_return_pct - b.real_return_pct)[0];
  el("history-explanation").textContent = `For the savings benchmark, none of the ${savings.length} valid rolling 12-month periods in this 2014–2024 sample produced a positive inflation-adjusted return. The weakest 12-month period ran from ${monthLabel(worst.start_date)} to ${monthLabel(worst.end_date)}: the account still earned a nominal return of ${fmtPct2(worst.nominal_return_pct)}%, but purchasing power fell by ${Math.abs(worst.real_return_pct).toFixed(1)}%. This is why a positive bank interest rate does not automatically mean the saver became better off in real terms.`;
}

function drawAllScenarioCharts(animate = true) {
  if (!state.result?.series?.length) return;
  drawWealthChart("#overview-wealth-chart", "#overview-tooltip", state.result.series, state.scrubIndex, animate, 300, "overview");
  drawWealthChart("#simulator-wealth-chart", "#simulator-tooltip", state.result.series, state.scrubIndex, animate, 480, "simulator");
  drawInflationRateChart();
  drawRetainedChart();
}

function drawWealthChart(selector, tooltipSelector, series, cursorIndex, animate, targetHeight, key) {
  const host = document.querySelector(selector);
  if (!host || host.offsetParent === null && state.activePage !== "overview" && state.activePage !== "simulator") return;

  const root = d3.select(selector);
  root.selectAll("*").remove();
  if (!series.length) return;

  const width = Math.max(320, host.clientWidth || 720);
  const height = Math.max(250, targetHeight);
  const margin = { top: 22, right: 22, bottom: 34, left: 46 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const dates = series.map(d => parseMonth(d.date));

  const values = series.flatMap(d => [d.nominal_index, d.real_index, d.usd_index]);
  const yMin = Math.max(0, d3.min(values) * .88);
  const yMax = d3.max(values) * 1.08;
  const x = d3.scaleTime().domain(d3.extent(dates)).range([0, innerW]);
  const y = d3.scaleLinear().domain([yMin, yMax]).nice().range([innerH, 0]);

  const svg = root.append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`);

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g").attr("class", "grid")
    .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(""));
  g.append("g").attr("class", "axis")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(width < 650 ? 4 : 6).tickSizeOuter(0));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(y).ticks(5).tickSizeOuter(0));

  if (y.domain()[0] <= 100 && y.domain()[1] >= 100) {
    g.append("line").attr("class", "reference-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", y(100)).attr("y2", y(100));
    g.append("text").attr("class", "reference-label")
      .attr("x", innerW).attr("y", y(100) - 6)
      .attr("text-anchor", "end")
      .text("START = 100");
  }

  const lines = [
    { field: "nominal_index", color: COLORS.nominal },
    { field: "real_index", color: COLORS.real },
    { field: "usd_index", color: COLORS.usd }
  ];
  const line = field => d3.line()
    .x(d => x(parseMonth(d.date)))
    .y(d => y(d[field]))
    .curve(d3.curveMonotoneX);

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  lines.forEach(item => {
    const path = g.append("path")
      .datum(series)
      .attr("fill", "none")
      .attr("stroke", item.color)
      .attr("stroke-width", 2.4)
      .attr("d", line(item.field));
    if (animate && !reduceMotion) {
      const length = path.node().getTotalLength();
      path.attr("stroke-dasharray", `${length} ${length}`)
        .attr("stroke-dashoffset", length)
        .transition().duration(650).ease(d3.easeCubicOut)
        .attr("stroke-dashoffset", 0);
    }
  });

  const cursor = g.append("g").attr("class", "cursor-layer");
  cursor.append("line").attr("class", "chart-cursor").attr("y1", 0).attr("y2", innerH);
  lines.forEach(item => cursor.append("circle")
    .attr("class", `cursor-dot dot-${item.field}`)
    .attr("r", 4.5)
    .attr("fill", item.color));

  g.append("rect")
    .attr("width", innerW)
    .attr("height", innerH)
    .attr("fill", "transparent")
    .style("cursor", "crosshair")
    .on("pointermove", event => {
      const [mx] = d3.pointer(event);
      const target = x.invert(mx);
      const bisect = d3.bisector(d => parseMonth(d.date)).center;
      const i = clamp(bisect(series, target), 0, series.length - 1);
      state.scrubIndex = i;
      el("time-scrubber").value = i;
      updateSnapshot();
      updateAllCursors();
      showWealthTooltip(event, tooltipSelector, series[i]);
    })
    .on("pointerleave", () => {
      const tip = document.querySelector(tooltipSelector);
      if (tip) tip.hidden = true;
    });

  state[`${key}Chart`] = { x, y, g, series, innerH };
  state.scrubIndex = clamp(cursorIndex, 0, series.length - 1);
  updateChartCursor(state[`${key}Chart`]);
}

function updateChartCursor(chart) {
  if (!chart || !chart.series[state.scrubIndex]) return;
  const p = chart.series[state.scrubIndex];
  const cx = chart.x(parseMonth(p.date));
  const layer = chart.g.select(".cursor-layer");
  layer.select("line").attr("x1", cx).attr("x2", cx);
  layer.select(".dot-nominal_index").attr("cx", cx).attr("cy", chart.y(p.nominal_index));
  layer.select(".dot-real_index").attr("cx", cx).attr("cy", chart.y(p.real_index));
  layer.select(".dot-usd_index").attr("cx", cx).attr("cy", chart.y(p.usd_index));
}

function updateAllCursors() {
  updateChartCursor(state.overviewChart);
  updateChartCursor(state.simulatorChart);
}

function showWealthTooltip(event, selector, p) {
  const tip = document.querySelector(selector);
  if (!tip) return;
  tip.innerHTML = `
    <strong>${monthLabel(p.date)}</strong>
    <div class="tooltip-row"><span>Account balance</span><span>${p.nominal_index.toFixed(1)}</span></div>
    <div class="tooltip-row"><span>Purchasing power</span><span>${p.real_index.toFixed(1)}</span></div>
    <div class="tooltip-row"><span>USD value</span><span>${p.usd_index.toFixed(1)}</span></div>`;
  tip.hidden = false;
  tip.style.left = `${Math.min(window.innerWidth - 235, event.clientX + 14)}px`;
  tip.style.top = `${Math.max(10, event.clientY - 92)}px`;
}

function drawInflationRateChart() {
  const host = el("inflation-rate-chart");
  if (!host) return;
  d3.select(host).selectAll("*").remove();

  const data = state.data.map((d, i) => {
    const yoy = i >= 12 ? (d.cpi / state.data[i - 12].cpi - 1) * 100 : null;
    return { date: d.date, savings: d.savings, inflation: yoy };
  }).filter(d => d.inflation != null);

  const width = Math.max(260, host.clientWidth || 420);
  const height = 190;
  const margin = { top: 12, right: 14, bottom: 28, left: 36 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const x = d3.scaleTime().domain(d3.extent(data, d => parseMonth(d.date))).range([0, innerW]);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => Math.max(d.savings, d.inflation)) * 1.08]).nice().range([innerH, 0]);

  const svg = d3.select(host).append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(""));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${innerH})`).call(d3.axisBottom(x).ticks(4).tickFormat(d3.timeFormat("%Y")).tickSizeOuter(0));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(d => `${d}%`).tickSizeOuter(0));

  const line = field => d3.line().defined(d => d[field] != null)
    .x(d => x(parseMonth(d.date)))
    .y(d => y(d[field]))
    .curve(d3.curveMonotoneX);

  g.append("path").datum(data).attr("fill", "none").attr("stroke", COLORS.red).attr("stroke-width", 2).attr("d", line("inflation"));
  g.append("path").datum(data).attr("fill", "none").attr("stroke", COLORS.amber).attr("stroke-width", 2).attr("d", line("savings"));

  const legend = svg.append("g").attr("transform", `translate(${Math.max(45, width - 155)},14)`);
  [["Inflation", COLORS.red], ["Savings rate", COLORS.amber]].forEach((item, i) => {
    const row = legend.append("g").attr("transform", `translate(0,${i * 14})`);
    row.append("line").attr("x1", 0).attr("x2", 13).attr("y1", 0).attr("y2", 0).attr("stroke", item[1]).attr("stroke-width", 2);
    row.append("text").attr("x", 18).attr("y", 3).attr("fill", COLORS.muted).attr("font-size", 8).text(item[0]);
  });
}

function drawRetainedChart() {
  const host = el("retained-chart");
  if (!host || !state.result?.summary) return;
  d3.select(host).selectAll("*").remove();

  const start = state.result.starting_balance;
  const real = state.result.summary.real;
  const data = [
    { label: "Starting amount", value: start, color: COLORS.cyan },
    { label: "End purchasing power", value: real, color: real >= start ? COLORS.green : COLORS.red }
  ];

  const width = Math.max(260, host.clientWidth || 420);
  const height = 190;
  const margin = { top: 10, right: 12, bottom: 42, left: 54 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const x = d3.scaleBand().domain(data.map(d => d.label)).range([0, innerW]).padding(.42);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.value) * 1.1]).nice().range([innerH, 0]);

  const svg = d3.select(host).append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(d => `₦${d3.format(".2s")(d)}`).tickSizeOuter(0));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).tickSize(0))
    .call(g => g.select(".domain").remove());

  g.selectAll("rect").data(data).join("rect")
    .attr("x", d => x(d.label))
    .attr("y", d => y(d.value))
    .attr("width", x.bandwidth())
    .attr("height", d => innerH - y(d.value))
    .attr("rx", 5)
    .attr("fill", d => d.color);

  g.selectAll("text.bar-value").data(data).join("text")
    .attr("class", "bar-value")
    .attr("x", d => x(d.label) + x.bandwidth() / 2)
    .attr("y", d => y(d.value) - 6)
    .attr("text-anchor", "middle")
    .attr("fill", COLORS.text)
    .attr("font-size", 8)
    .text(d => fmtNaira.format(d.value));
}

function drawReturnStrip() {
  const host = el("return-strip");
  if (!host) return;
  d3.select(host).selectAll("*").remove();

  const valid = state.rolling;
  const width = Math.max(860, host.clientWidth || 860);
  const height = 255;
  const margin = { top: 18, right: 16, bottom: 40, left: 95 };
  const innerW = width - margin.left - margin.right;
  const strategies = ["savings", "3m", "6m", "12m"];
  const starts = [...new Set(valid.map(d => d.start_date))].sort();
  const x = d3.scaleBand().domain(starts).range([0, innerW]).paddingInner(.08);
  const y = d3.scaleBand().domain(strategies).range([0, 150]).padding(.18);
  const color = d3.scaleLinear().domain([-22, 0, 3]).range([COLORS.red, "#31574f", COLORS.green]).clamp(true);

  const svg = d3.select(host).append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.selectAll("rect.return-cell").data(valid).join("rect")
    .attr("class", "return-cell")
    .attr("x", d => x(d.start_date))
    .attr("y", d => y(d.strategy))
    .attr("width", x.bandwidth())
    .attr("height", y.bandwidth())
    .attr("rx", 1)
    .attr("fill", d => d.status === "ok" ? color(d.real_return_pct) : "rgba(255,255,255,.05)")
    .on("pointerenter pointermove", showStripTooltip)
    .on("pointerleave", () => { el("strip-tooltip").hidden = true; });

  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(y).tickFormat(d => STRATEGY_LABELS[d].replace(" deposit", "")))
    .call(g => g.select(".domain").remove());

  const yearStarts = starts.filter(s => s.endsWith("-01"));
  g.append("g").attr("class", "axis")
    .attr("transform", "translate(0,160)")
    .call(d3.axisBottom(x).tickValues(yearStarts).tickFormat(d => d.slice(0, 4)).tickSize(0))
    .call(g => g.select(".domain").remove());
}

function showStripTooltip(event, d) {
  const tip = el("strip-tooltip");
  tip.innerHTML = d.status === "ok"
    ? `<strong>${STRATEGY_LABELS[d.strategy]}</strong>
       <div>${monthLabel(d.start_date)} — ${monthLabel(d.end_date)}</div>
       <div class="tooltip-row"><span>Nominal return</span><span>${signedPctPoints(d.nominal_return_pct)}</span></div>
       <div class="tooltip-row"><span>Real return</span><span>${signedPctPoints(d.real_return_pct)}</span></div>`
    : `<strong>${STRATEGY_LABELS[d.strategy]}</strong><div>Historical rate unavailable for this rolling window.</div>`;
  tip.hidden = false;
  tip.style.left = `${Math.min(window.innerWidth - 235, event.clientX + 12)}px`;
  tip.style.top = `${Math.max(10, event.clientY - 90)}px`;
}

function renderReturnSummary() {
  const strategies = ["savings", "3m", "6m", "12m"];
  el("return-summary").innerHTML = strategies.map(strategy => {
    const valid = state.rolling.filter(d => d.strategy === strategy && d.status === "ok");
    const wins = valid.filter(d => d.real_return_pct > 0).length;
    const share = valid.length ? wins / valid.length : 0;
    return `
      <div class="return-stat">
        <span>${STRATEGY_LABELS[strategy]}</span>
        <strong>${d3.format(".0%")(share)}</strong>
        <span>${wins} of ${valid.length} rolling 12-month periods beat inflation</span>
      </div>`;
  }).join("");
}

function drawRollingReturnChart() {
  const host = el("rolling-return-chart");
  if (!host) return;
  d3.select(host).selectAll("*").remove();

  const data = state.rolling.filter(d => d.strategy === "savings" && d.status === "ok");
  const width = Math.max(320, host.clientWidth || 900);
  const height = 330;
  const margin = { top: 16, right: 18, bottom: 38, left: 46 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const x = d3.scaleTime().domain(d3.extent(data, d => parseMonth(d.end_date))).range([0, innerW]);
  const extent = d3.extent(data.flatMap(d => [d.nominal_return_pct, d.real_return_pct]));
  const y = d3.scaleLinear().domain([Math.min(-25, extent[0] * 1.08), Math.max(10, extent[1] * 1.08)]).nice().range([innerH, 0]);

  const svg = d3.select(host).append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(6).tickSize(-innerW).tickFormat(""));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${innerH})`).call(d3.axisBottom(x).ticks(width < 650 ? 5 : 9).tickFormat(d3.timeFormat("%Y")).tickSizeOuter(0));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(6).tickFormat(d => `${d}%`).tickSizeOuter(0));
  g.append("line").attr("x1", 0).attr("x2", innerW).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", "rgba(255,255,255,.26)").attr("stroke-dasharray", "4 5");

  const line = field => d3.line()
    .x(d => x(parseMonth(d.end_date)))
    .y(d => y(d[field]))
    .curve(d3.curveMonotoneX);

  g.append("path").datum(data).attr("fill", "none").attr("stroke", COLORS.amber).attr("stroke-width", 2.2).attr("d", line("nominal_return_pct"));
  g.append("path").datum(data).attr("fill", "none").attr("stroke", COLORS.red).attr("stroke-width", 2.2).attr("d", line("real_return_pct"));

  const legend = svg.append("g").attr("transform", `translate(${Math.max(60, width - 205)},14)`);
  [["Nominal 12M return", COLORS.amber], ["Real 12M return", COLORS.red]].forEach((item, i) => {
    const row = legend.append("g").attr("transform", `translate(0,${i * 15})`);
    row.append("line").attr("x1", 0).attr("x2", 14).attr("y1", 0).attr("y2", 0).attr("stroke", item[1]).attr("stroke-width", 2);
    row.append("text").attr("x", 19).attr("y", 3).attr("fill", COLORS.muted).attr("font-size", 8).text(item[0]);
  });
}

function renderPainRanking() {
  const rows = state.rolling
    .filter(d => d.strategy === state.painStrategy && d.status === "ok" && Number.isFinite(d.real_return_pct))
    .sort((a, b) => a.real_return_pct - b.real_return_pct)
    .slice(0, 5);

  const maxAbs = d3.max(rows, d => Math.abs(d.real_return_pct)) || 1;
  el("pain-ranking").innerHTML = rows.map((d, i) => `
    <div class="pain-row">
      <div class="pain-rank">0${i + 1}</div>
      <div class="pain-period">
        <strong>${monthLabel(d.start_date)} — ${monthLabel(d.end_date)}</strong>
        <span>Nominal return: ${signedPctPoints(d.nominal_return_pct)}</span>
      </div>
      <div class="pain-bar-track" aria-hidden="true">
        <div class="pain-bar" style="width:${Math.abs(d.real_return_pct) / maxAbs * 100}%"></div>
      </div>
      <div class="pain-value">${signedPctPoints(d.real_return_pct)}</div>
    </div>`).join("");

  const worst = rows[0];
  if (worst) {
    el("pain-explanation").textContent = `For the ${STRATEGY_LABELS[state.painStrategy]} benchmark, the largest 12-month purchasing-power loss in this sample occurred from ${monthLabel(worst.start_date)} to ${monthLabel(worst.end_date)}. The simulated deposit still produced a nominal return of ${signedPctPoints(worst.nominal_return_pct)}, but after inflation the real return was ${signedPctPoints(worst.real_return_pct)}. In other words, the naira balance increased, but the amount of goods and services that balance could buy fell materially over the same period.`;
  }
}

async function copyResult() {
  if (!state.result?.summary) return;
  const s = state.result.summary;
  const text = `The Naira Illusion: ${fmtNaira.format(state.result.starting_balance)} using the ${STRATEGY_LABELS[state.result.strategy]} benchmark from ${monthLabel(state.result.start_date)} to ${monthLabel(state.result.end_date)} became ${fmtNaira.format(s.nominal)} nominally, ${fmtNaira.format(s.real)} in start-date purchasing power, and ${fmtUsd.format(s.usd)} at the CBN official/reference USD/NGN rate.`;
  try {
    await navigator.clipboard.writeText(text);
    const button = el("copy-result");
    const previous = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = previous; }, 1200);
  } catch {
    el("form-status").textContent = "Copying is not available in this browser.";
  }
}

function writeUrl() {
  const q = new URLSearchParams({
    balance: String(Math.round(parseAmount(el("starting-balance").value))),
    start: el("start-date").value,
    end: el("end-date").value,
    strategy: state.strategy
  });
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

function redrawVisibleCharts() {
  if (state.activePage === "overview" && state.result?.series?.length) {
    drawWealthChart("#overview-wealth-chart", "#overview-tooltip", state.result.series, state.scrubIndex, false, 300, "overview");
    drawInflationRateChart();
    drawRetainedChart();
  } else if (state.activePage === "simulator" && state.result?.series?.length) {
    drawWealthChart("#simulator-wealth-chart", "#simulator-tooltip", state.result.series, state.scrubIndex, false, 480, "simulator");
  } else if (state.activePage === "history") {
    drawReturnStrip();
    drawRollingReturnChart();
  }
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

init();