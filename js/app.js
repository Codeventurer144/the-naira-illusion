import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { parseMonthlyRow, validateMonthlyData, simulate, rolling12Months } from "./simulator.js";

const COLORS = {
  nominal: "#f6b84a",
  real: "#ff8b82",
  usd: "#8fc3ff",
  green: "#82efb6",
  red: "#ff8b82",
  cyan: "#78e2d3",
  text: "#f5fbf9",
  muted: "#dbece7"
};

const STRATEGY_LABELS = {
  savings: "Savings account",
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
    const positiveSavingsCount = el("positive-savings-count");
    if (positiveSavingsCount) positiveSavingsCount.textContent = wins;

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

  document.querySelectorAll(".deposit-button").forEach(button => {
    button.addEventListener("click", () => setStrategy(button.dataset.strategy));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...document.querySelectorAll(".deposit-button")];
      const i = buttons.indexOf(button);
      const next = event.key === "ArrowRight"
        ? (i + 1) % buttons.length
        : (i - 1 + buttons.length) % buttons.length;
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

  const closeGuide = el("onboarding-close");
  if (closeGuide) {
    closeGuide.addEventListener("click", () => {
      if (window.dismissNairaGuide) window.dismissNairaGuide();
    });
  }

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !el("onboarding")?.classList.contains("hidden")) {
      if (window.dismissNairaGuide) window.dismissNairaGuide();
    }
  });
}

function switchPage(page) {
  if (!PAGE_TITLES[page]) return;
  state.activePage = page;

  document.querySelectorAll(".dashboard-page").forEach(section => {
    section.classList.toggle("active", section.dataset.page === page);
  });

  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.pageTarget === page);
  });

  requestAnimationFrame(() => {
    if (page === "overview" && state.result?.series?.length) {
      drawWealthChart("#overview-wealth-chart", "#overview-tooltip", state.result.series, state.scrubIndex, false, 340, "overview");
      drawInflationRateChart();
      drawRetainedChart();
    }

    if (page === "simulator" && state.result?.series?.length) {
      drawWealthChart("#simulator-wealth-chart", "#simulator-tooltip", state.result.series, state.scrubIndex, false, 500, "simulator");
    }

    if (page === "history") {
      drawReturnStrip();
      drawRollingReturnChart();
    }
  });
}

function setStrategy(strategy) {
  state.strategy = strategy;

  document.querySelectorAll(".deposit-button").forEach(button => {
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
    el("form-status").textContent = "The withdrawal date must come after the date the money was saved.";
    return;
  }

  const result = simulate(state.data, {
    strategy: state.strategy,
    startDate,
    endDate,
    startingBalance
  });

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
  el("scenario-chip").textContent =
    `${fmtNaira.format(amount)} · ${STRATEGY_LABELS[state.strategy]} · ${monthLabel(el("start-date").value)} — ${monthLabel(el("end-date").value)}`;
}

function renderIncomplete(result) {
  const last = result.series.at(-1);

  ["metric-nominal", "metric-real", "metric-usd", "metric-real-return"].forEach(id => {
    el(id).textContent = "—";
  });

  ["metric-nominal-change", "metric-real-change", "metric-usd-change"].forEach(id => {
    el(id).textContent = "Historical rate unavailable";
    el(id).className = "kpi-delta neutral";
  });

  el("metric-duration").textContent = durationText(result.start_date, result.end_date);

  if (last) {
    el("metric-nominal").textContent = fmtNaira.format(last.nominal);
    el("metric-real").textContent = fmtNaira.format(last.real);
    el("metric-usd").textContent = fmtUsd.format(last.usd);
  }

  const message =
    `This scenario needs a ${STRATEGY_LABELS[result.strategy]} rate for ${monthLabel(result.missing_date)}, but that historical rate is unavailable in the source data. The dashboard stops the calculation at that point rather than estimating or substituting a value.`;

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
    overview =
      `If you saved ${fmtNaira.format(result.starting_balance)} in the ${STRATEGY_LABELS[result.strategy]} from ${monthLabel(result.start_date)} to ${monthLabel(result.end_date)} (${period}), the simulated account balance would end at ${fmtNaira.format(s.nominal)}. That is ${fmtNaira.format(interest)} more naira than you started with. But after allowing for inflation, the end balance would have the same purchasing power as about ${fmtNaira.format(s.real)} in ${monthLabel(result.start_date)}. So although the account balance increased, the amount of goods and services the money could buy would have fallen by about ${realLoss.toFixed(1)}%.`;
  } else {
    overview =
      `If you saved ${fmtNaira.format(result.starting_balance)} in the ${STRATEGY_LABELS[result.strategy]} from ${monthLabel(result.start_date)} to ${monthLabel(result.end_date)} (${period}), the simulated account balance would end at ${fmtNaira.format(s.nominal)}. After allowing for inflation, that would be equivalent to about ${fmtNaira.format(s.real)} in ${monthLabel(result.start_date)} purchasing power, giving a real gain of about ${realGain.toFixed(1)}%.`;
  }

  const simulator =
    `The chart starts all three measures at 100 so they can be compared on the same scale. The account-balance line shows how the naira amount changes under the selected deposit option. The purchasing-power line adjusts that balance for inflation. The USD line converts the same account balance using the CBN official/reference exchange rate. At the end of this scenario, the account contains ${fmtNaira.format(s.nominal)}, but its inflation-adjusted value is about ${fmtNaira.format(s.real)}. That means it retains about ${retainedShare.toFixed(1)}% of the purchasing power of the amount you started with. At the official/reference exchange rate, the end balance is worth about ${fmtUsd.format(s.usd)}.`;

  el("overview-explanation").textContent = overview;
  el("simulator-explanation").textContent = simulator;
}

function updateHistoricalExplanation() {
  const savings = state.rolling.filter(d => d.strategy === "savings" && d.status === "ok");
  const worst = [...savings].sort((a, b) => a.real_return_pct - b.real_return_pct)[0];

  el("history-explanation").textContent =
    `For the savings account option, none of the ${savings.length} valid rolling 12-month periods in this 2014–2024 sample produced a positive inflation-adjusted return. The weakest 12-month period ran from ${monthLabel(worst.start_date)} to ${monthLabel(worst.end_date)}. The account still earned a nominal return of ${fmtPct2(worst.nominal_return_pct)}%, but purchasing power fell by ${Math.abs(worst.real_return_pct).toFixed(1)}%. This means the balance went up in naira terms while the amount of goods and services it could buy went down.`;
}

function drawAllScenarioCharts(animate = true) {
  if (!state.result?.series?.length) return;

  drawWealthChart(
    "#overview-wealth-chart",
    "#overview-tooltip",
    state.result.series,
    state.scrubIndex,
    animate,
    340,
    "overview"
  );

  drawWealthChart(
    "#simulator-wealth-chart",
    "#simulator-tooltip",
    state.result.series,
    state.scrubIndex,
    animate,
    500,
    "simulator"
  );

  drawInflationRateChart();
  drawRetainedChart();
}

function drawWealthChart(selector, tooltipSelector, series, cursorIndex, animate, targetHeight, key) {
  const host = document.querySelector(selector);
  if (!host) return;

  const root = d3.select(selector);
  root.selectAll("*").remove();
  if (!series.length) return;

  const width = Math.max(320, host.clientWidth || 720);
  const height = Math.max(260, targetHeight);
  const margin = { top: 24, right: 24, bottom: 40, left: 50 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const dates = series.map(d => parseMonth(d.date));

  const values = series.flatMap(d => [d.nominal_index, d.real_index, d.usd_index]);
  const yMin = Math.max(0, d3.min(values) * .88);
  const yMax = d3.max(values) * 1.08;

  const x = d3.scaleTime()
    .domain(d3.extent(dates))
    .range([0, innerW]);

  const y = d3.scaleLinear()
    .domain([yMin, yMax])
    .nice()
    .range([innerH, 0]);

  const svg = root.append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g")
    .attr("class", "grid")
    .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(""));

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(width < 650 ? 4 : 6).tickSizeOuter(0));

  g.append("g")
    .attr("class", "axis")
    .call(d3.axisLeft(y).ticks(5).tickSizeOuter(0));

  if (y.domain()[0] <= 100 && y.domain()[1] >= 100) {
    g.append("line")
      .attr("class", "reference-line")
      .attr("x1", 0)
      .attr("x2", innerW)
      .attr("y1", y(100))
      .attr("y2", y(100));

    g.append("text")
      .attr("class", "reference-label")
      .attr("x", innerW)
      .attr("y", y(100) - 7)
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
      .attr("stroke-width", 2.6)
      .attr("d", line(item.field));

    if (animate && !reduceMotion) {
      const length = path.node().getTotalLength();

      path.attr("stroke-dasharray", `${length} ${length}`)
        .attr("stroke-dashoffset", length)
        .transition()
        .duration(650)
        .ease(d3.easeCubicOut)
        .attr("stroke-dashoffset", 0);
    }
  });

  const cursor = g.append("g").attr("class", "cursor-layer");

  cursor.append("line")
    .attr("class", "chart-cursor")
    .attr("y1", 0)
    .attr("y2", innerH);

  lines.forEach(item => {
    cursor.append("circle")
      .attr("class", `cursor-dot dot-${item.field}`)
      .attr("r", 4.7)
      .attr("fill", item.color);
  });

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

  layer.select("line")
    .attr("x1", cx)
    .attr("x2", cx);

  layer.select(".dot-nominal_index")
    .attr("cx", cx)
    .attr("cy", chart.y(p.nominal_index));

  layer.select(".dot-real_index")
    .attr("cx", cx)
    .attr("cy", chart.y(p.real_index));

  layer.select(".dot-usd_index")
    .attr("cx", cx)
    .attr("cy", chart.y(p.usd_index));
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
    <div class="tooltip-row"><span>Account balance index</span><span>${p.nominal_index.toFixed(1)}</span></div>
    <div class="tooltip-row"><span>Purchasing-power index</span><span>${p.real_index.toFixed(1)}</span></div>
    <div class="tooltip-row"><span>USD-value index</span><span>${p.usd_index.toFixed(1)}</span></div>`;

  tip.hidden = false;
  tip.style.left = `${Math.min(window.innerWidth - 245, event.clientX + 14)}px`;
  tip.style.top = `${Math.max(10, event.clientY - 100)}px`;
}

function drawInflationRateChart() {
  const host = el("inflation-rate-chart");
  if (!host) return;

  d3.select(host).selectAll("*").remove();

  const data = state.data.map((d, i) => {
    const yoy = i >= 12
      ? (d.cpi / state.data[i - 12].cpi - 1) * 100
      : null;

    return {
      date: d.date,
      savings: d.savings,
      inflation: yoy
    };
  }).filter(d => d.inflation != null);

  const width = Math.max(280, host.clientWidth || 440);
  const height = 230;
  const margin = { top: 16, right: 16, bottom: 34, left: 42 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const x = d3.scaleTime()
    .domain(d3.extent(data, d => parseMonth(d.date)))
    .range([0, innerW]);

  const y = d3.scaleLinear()
    .domain([0, d3.max(data, d => Math.max(d.savings, d.inflation)) * 1.08])
    .nice()
    .range([innerH, 0]);

  const svg = d3.select(host)
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g")
    .attr("class", "grid")
    .call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(""));

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(4).tickFormat(d3.timeFormat("%Y")).tickSizeOuter(0));

  g.append("g")
    .attr("class", "axis")
    .call(d3.axisLeft(y).ticks(4).tickFormat(d => `${d}%`).tickSizeOuter(0));

  const line = field => d3.line()
    .defined(d => d[field] != null)
    .x(d => x(parseMonth(d.date)))
    .y(d => y(d[field]))
    .curve(d3.curveMonotoneX);

  g.append("path")
    .datum(data)
    .attr("fill", "none")
    .attr("stroke", COLORS.real)
    .attr("stroke-width", 2.3)
    .attr("d", line("inflation"));

  g.append("path")
    .datum(data)
    .attr("fill", "none")
    .attr("stroke", COLORS.nominal)
    .attr("stroke-width", 2.3)
    .attr("d", line("savings"));

  const legend = svg.append("g")
    .attr("transform", `translate(${Math.max(52, width - 175)},16)`);

  [["Inflation", COLORS.real], ["Savings rate", COLORS.nominal]].forEach((item, i) => {
    const row = legend.append("g")
      .attr("transform", `translate(0,${i * 17})`);

    row.append("line")
      .attr("x1", 0)
      .attr("x2", 15)
      .attr("y1", 0)
      .attr("y2", 0)
      .attr("stroke", item[1])
      .attr("stroke-width", 2.3);

    row.append("text")
      .attr("x", 20)
      .attr("y", 4)
      .attr("fill", COLORS.muted)
      .attr("font-size", 10)
      .text(item[0]);
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
    { label: "End purchasing power", value: real, color: real >= start ? COLORS.green : COLORS.real }
  ];

  const width = Math.max(280, host.clientWidth || 440);
  const height = 230;
  const margin = { top: 18, right: 14, bottom: 50, left: 62 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const x = d3.scaleBand()
    .domain(data.map(d => d.label))
    .range([0, innerW])
    .padding(.42);

  const y = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.value) * 1.1])
    .nice()
    .range([innerH, 0]);

  const svg = d3.select(host)
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g")
    .attr("class", "grid")
    .call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(""));

  g.append("g")
    .attr("class", "axis")
    .call(d3.axisLeft(y).ticks(4).tickFormat(d => `₦${d3.format(".2s")(d)}`).tickSizeOuter(0));

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).tickSize(0))
    .call(group => group.select(".domain").remove());

  g.selectAll("rect")
    .data(data)
    .join("rect")
    .attr("x", d => x(d.label))
    .attr("y", d => y(d.value))
    .attr("width", x.bandwidth())
    .attr("height", d => innerH - y(d.value))
    .attr("rx", 5)
    .attr("fill", d => d.color);

  g.selectAll("text.bar-value")
    .data(data)
    .join("text")
    .attr("class", "bar-value")
    .attr("x", d => x(d.label) + x.bandwidth() / 2)
    .attr("y", d => y(d.value) - 7)
    .attr("text-anchor", "middle")
    .attr("fill", COLORS.text)
    .attr("font-size", 10)
    .text(d => fmtNaira.format(d.value));
}

function drawReturnStrip() {
  const host = el("return-strip");
  if (!host) return;

  d3.select(host).selectAll("*").remove();

  const data = state.rolling;
  const width = Math.max(880, host.clientWidth || 880);
  const height = 270;
  const margin = { top: 20, right: 18, bottom: 42, left: 112 };
  const innerW = width - margin.left - margin.right;
  const strategies = ["savings", "3m", "6m", "12m"];
  const starts = [...new Set(data.map(d => d.start_date))].sort();

  const x = d3.scaleBand()
    .domain(starts)
    .range([0, innerW])
    .paddingInner(.08);

  const y = d3.scaleBand()
    .domain(strategies)
    .range([0, 160])
    .padding(.18);

  const color = d3.scaleLinear()
    .domain([-22, 0, 3])
    .range([COLORS.real, "#52756d", COLORS.green])
    .clamp(true);

  const svg = d3.select(host)
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  g.selectAll("rect.return-cell")
    .data(data)
    .join("rect")
    .attr("class", "return-cell")
    .attr("x", d => x(d.start_date))
    .attr("y", d => y(d.strategy))
    .attr("width", x.bandwidth())
    .attr("height", y.bandwidth())
    .attr("rx", 1)
    .attr("fill", d => d.status === "ok" ? color(d.real_return_pct) : "rgba(255,255,255,.06)")
    .on("pointerenter pointermove", showStripTooltip)
    .on("pointerleave", () => {
      el("strip-tooltip").hidden = true;
    });

  g.append("g")
    .attr("class", "axis")
    .call(d3.axisLeft(y).tickFormat(d => STRATEGY_LABELS[d]))
    .call(group => group.select(".domain").remove());

  const yearStarts = starts.filter(s => s.endsWith("-01"));

  g.append("g")
    .attr("class", "axis")
    .attr("transform", "translate(0,170)")
    .call(d3.axisBottom(x).tickValues(yearStarts).tickFormat(d => d.slice(0, 4)).tickSize(0))
    .call(group => group.select(".domain").remove());
}

function showStripTooltip(event, d) {
  const tip = el("strip-tooltip");

  tip.innerHTML = d.status === "ok"
    ? `<strong>${STRATEGY_LABELS[d.strategy]}</strong>
       <div>${monthLabel(d.start_date)} — ${monthLabel(d.end_date)}</div>
       <div class="tooltip-row"><span>Account return</span><span>${signedPctPoints(d.nominal_return_pct)}</span></div>
       <div class="tooltip-row"><span>After inflation</span><span>${signedPctPoints(d.real_return_pct)}</span></div>`
    : `<strong>${STRATEGY_LABELS[d.strategy]}</strong><div>Historical rate unavailable for this 12-month period.</div>`;

  tip.hidden = false;
  tip.style.left = `${Math.min(window.innerWidth - 245, event.clientX + 12)}px`;
  tip.style.top = `${Math.max(10, event.clientY - 95)}px`;
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
        <span>${wins} of ${valid.length} rolling 12-month periods finished above inflation</span>
      </div>`;
  }).join("");
}

function drawRollingReturnChart() {
  const host = el("rolling-return-chart");
  if (!host) return;

  d3.select(host).selectAll("*").remove();

  const data = state.rolling.filter(d => d.strategy === "savings" && d.status === "ok");
  const width = Math.max(320, host.clientWidth || 900);
  const height = 360;
  const margin = { top: 18, right: 20, bottom: 42, left: 52 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const x = d3.scaleTime()
    .domain(d3.extent(data, d => parseMonth(d.end_date)))
    .range([0, innerW]);

  const extent = d3.extent(data.flatMap(d => [d.nominal_return_pct, d.real_return_pct]));

  const y = d3.scaleLinear()
    .domain([
      Math.min(-25, extent[0] * 1.08),
      Math.max(10, extent[1] * 1.08)
    ])
    .nice()
    .range([innerH, 0]);

  const svg = d3.select(host)
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g")
    .attr("class", "grid")
    .call(d3.axisLeft(y).ticks(6).tickSize(-innerW).tickFormat(""));

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(width < 650 ? 5 : 9).tickFormat(d3.timeFormat("%Y")).tickSizeOuter(0));

  g.append("g")
    .attr("class", "axis")
    .call(d3.axisLeft(y).ticks(6).tickFormat(d => `${d}%`).tickSizeOuter(0));

  g.append("line")
    .attr("x1", 0)
    .attr("x2", innerW)
    .attr("y1", y(0))
    .attr("y2", y(0))
    .attr("stroke", "rgba(255,255,255,.32)")
    .attr("stroke-dasharray", "4 5");

  const line = field => d3.line()
    .x(d => x(parseMonth(d.end_date)))
    .y(d => y(d[field]))
    .curve(d3.curveMonotoneX);

  g.append("path")
    .datum(data)
    .attr("fill", "none")
    .attr("stroke", COLORS.nominal)
    .attr("stroke-width", 2.4)
    .attr("d", line("nominal_return_pct"));

  g.append("path")
    .datum(data)
    .attr("fill", "none")
    .attr("stroke", COLORS.real)
    .attr("stroke-width", 2.4)
    .attr("d", line("real_return_pct"));

  const legend = svg.append("g")
    .attr("transform", `translate(${Math.max(60, width - 235)},18)`);

  [["Account return", COLORS.nominal], ["Return after inflation", COLORS.real]].forEach((item, i) => {
    const row = legend.append("g")
      .attr("transform", `translate(0,${i * 18})`);

    row.append("line")
      .attr("x1", 0)
      .attr("x2", 16)
      .attr("y1", 0)
      .attr("y2", 0)
      .attr("stroke", item[1])
      .attr("stroke-width", 2.4);

    row.append("text")
      .attr("x", 21)
      .attr("y", 4)
      .attr("fill", COLORS.muted)
      .attr("font-size", 10)
      .text(item[0]);
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
        <span>Account return: ${signedPctPoints(d.nominal_return_pct)}</span>
      </div>
      <div class="pain-bar-track" aria-hidden="true">
        <div class="pain-bar" style="width:${Math.abs(d.real_return_pct) / maxAbs * 100}%"></div>
      </div>
      <div class="pain-value">${signedPctPoints(d.real_return_pct)}</div>
    </div>`).join("");

  const worst = rows[0];

  if (worst) {
    el("pain-explanation").textContent =
      `For the ${STRATEGY_LABELS[state.painStrategy]}, the largest 12-month loss of purchasing power in this sample occurred from ${monthLabel(worst.start_date)} to ${monthLabel(worst.end_date)}. The simulated account still increased by ${signedPctPoints(worst.nominal_return_pct)} before inflation, but after allowing for the rise in prices the real return was ${signedPctPoints(worst.real_return_pct)}. Put simply, the account had more naira at the end of the year, but those naira could buy less than the starting balance could buy a year earlier.`;
  }
}

async function copyResult() {
  if (!state.result?.summary) return;

  const s = state.result.summary;
  const text =
    `The Naira Illusion: ${fmtNaira.format(state.result.starting_balance)} in the ${STRATEGY_LABELS[state.result.strategy]} from ${monthLabel(state.result.start_date)} to ${monthLabel(state.result.end_date)} became ${fmtNaira.format(s.nominal)} in the account, ${fmtNaira.format(s.real)} in start-date purchasing power, and ${fmtUsd.format(s.usd)} at the CBN official/reference USD/NGN rate.`;

  try {
    await navigator.clipboard.writeText(text);

    const button = el("copy-result");
    const previous = button.textContent;
    button.textContent = "Copied";

    setTimeout(() => {
      button.textContent = previous;
    }, 1200);
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
    drawWealthChart("#overview-wealth-chart", "#overview-tooltip", state.result.series, state.scrubIndex, false, 340, "overview");
    drawInflationRateChart();
    drawRetainedChart();
  } else if (state.activePage === "simulator" && state.result?.series?.length) {
    drawWealthChart("#simulator-wealth-chart", "#simulator-tooltip", state.result.series, state.scrubIndex, false, 500, "simulator");
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