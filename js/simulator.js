/* The Naira Illusion — browser calculation engine for D3.js.
 *
 * Assumptions mirror naira_illusion_engine.py:
 * - Savings: monthly compounding using annualized CBN savings rate / 12.
 * - Fixed deposits: lock the tenor rate at term start, use simple-interest
 *   accrual, roll principal + interest at maturity using the then-current rate.
 * - Missing rollover rates are never imputed; simulation returns missing_rate.
 * - Real wealth is expressed in start-month naira.
 * - USD equivalent uses CBN official/reference NGN per USD.
 */

export const STRATEGIES = ["savings", "3m", "6m", "12m"];
export const TENORS = { "3m": 3, "6m": 6, "12m": 12 };

export function parseMonthlyRow(d) {
  const num = (v) => (v === "" || v == null ? null : +v);
  return {
    date: d.date,
    cpi: num(d.cpi_index),
    savings: num(d.savings_rate),
    "3m": num(d.deposit_3m),
    "6m": num(d.deposit_6m),
    "12m": num(d.deposit_12m),
    usd_ngn: num(d.usd_ngn)
  };
}

export function validateMonthlyData(data) {
  if (!data.length) throw new Error("Dataset is empty.");
  for (const d of data) {
    if (d.cpi == null || d.savings == null || d.usd_ngn == null) {
      throw new Error(`Core field missing at ${d.date}.`);
    }
  }
  return true;
}

function enrich(series, startIndex, startingBalance, data, index) {
  const startCpi = data[startIndex].cpi;
  const startFx = data[startIndex].usd_ngn;
  const startUsd = startingBalance / startFx;

  return series.map((point) => {
    const j = index.get(point.date);
    const nominal = point.nominal;
    const real = nominal * startCpi / data[j].cpi;
    const usd = nominal / data[j].usd_ngn;
    return {
      ...point,
      cpi_index: data[j].cpi,
      usd_ngn: data[j].usd_ngn,
      real,
      usd,
      nominal_index: nominal / startingBalance * 100,
      real_index: real / startingBalance * 100,
      usd_index: usd / startUsd * 100
    };
  });
}

export function simulate(data, {
  strategy = "savings",
  startDate = data[0]?.date,
  endDate = data[data.length - 1]?.date,
  startingBalance = 1_000_000
} = {}) {
  if (!STRATEGIES.includes(strategy)) throw new Error(`Unknown strategy: ${strategy}`);

  const index = new Map(data.map((d, i) => [d.date, i]));
  const s = index.get(startDate);
  const e = index.get(endDate);
  if (s == null || e == null) throw new Error("Start/end month not found in dataset.");
  if (e < s) throw new Error("End month must not precede start month.");

  const rawSeries = [];
  let status = "ok";
  let missingDate = null;

  if (strategy === "savings") {
    let balance = startingBalance;
    rawSeries.push({ date: data[s].date, nominal: balance });
    for (let i = s; i < e; i += 1) {
      const rate = data[i].savings;
      if (rate == null) {
        status = "missing_rate";
        missingDate = data[i].date;
        break;
      }
      balance *= 1 + rate / 1200;
      rawSeries.push({ date: data[i + 1].date, nominal: balance });
    }
  } else {
    const tenor = TENORS[strategy];
    let principal = startingBalance;
    let termStart = s;
    let rate = data[termStart][strategy];

    if (rate == null) {
      status = "missing_rate";
      missingDate = data[termStart].date;
    } else {
      for (let j = s; j <= e; j += 1) {
        if (j > termStart && (j - termStart) === tenor) {
          principal *= 1 + (rate / 100) * (tenor / 12);
          termStart = j;
          if (j < e) {
            rate = data[j][strategy];
            if (rate == null) {
              rawSeries.push({ date: data[j].date, nominal: principal });
              status = "missing_rate";
              missingDate = data[j].date;
              break;
            }
          }
        }
        const elapsed = j - termStart;
        const value = principal * (1 + (rate / 100) * (elapsed / 12));
        rawSeries.push({ date: data[j].date, nominal: value });
      }
    }
  }

  const series = rawSeries.length
    ? enrich(rawSeries, s, startingBalance, data, index)
    : [];

  let summary = null;
  if (status === "ok" && series.length && series.at(-1).date === endDate) {
    const last = series.at(-1);
    const startUsd = startingBalance / data[s].usd_ngn;
    summary = {
      nominal: last.nominal,
      real: last.real,
      usd: last.usd,
      interest_earned: last.nominal - startingBalance,
      inflation_erosion: last.nominal - last.real,
      nominal_return: last.nominal / startingBalance - 1,
      real_return: last.real / startingBalance - 1,
      usd_change: last.usd / startUsd - 1
    };
  }

  return {
    strategy,
    start_date: startDate,
    end_date: endDate,
    starting_balance: startingBalance,
    status,
    missing_date: missingDate,
    series,
    summary
  };
}

export function rolling12Months(data, startingBalance = 1_000_000) {
  const rows = [];
  for (let s = 0; s + 12 < data.length; s += 1) {
    const startDate = data[s].date;
    const endDate = data[s + 12].date;
    for (const strategy of STRATEGIES) {
      const result = simulate(data, { strategy, startDate, endDate, startingBalance });
      rows.push({
        strategy,
        start_date: startDate,
        end_date: endDate,
        status: result.status,
        missing_date: result.missing_date,
        ...(result.summary ? {
          nominal_return_pct: result.summary.nominal_return * 100,
          real_return_pct: result.summary.real_return * 100,
          usd_change_pct: result.summary.usd_change * 100,
          end_nominal_ngn: result.summary.nominal,
          end_real_start_ngn: result.summary.real,
          end_usd: result.summary.usd
        } : {})
      });
    }
  }
  return rows;
}