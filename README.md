# The Naira Illusion

An interactive D3.js data story about the gap between a Nigerian savings balance, inflation-adjusted purchasing power, and official-rate USD-equivalent wealth from January 2014 to December 2024.

## Run locally

Because the page loads CSV files and D3 as ES modules, serve the directory over HTTP instead of double-clicking `index.html`.

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Deploy to GitHub Pages

1. In **Settings → Pages**, choose **Deploy from a branch**.
2. Select `main` and `/ (root)`.
3. GitHub will publish the site at:

   **https://codeventurer144.github.io/the-naira-illusion/**

No build step, npm install, database, API key, or paid hosting is required.

## Data

- `data/naira_illusion_monthly.csv`: production monthly CPI, CBN deposit benchmarks, and CBN official/reference USD/NGN.
- Rolling 12-month analysis is recomputed in-browser from the monthly source data.
- `data/sources.md`: source notes, CPI-vintage handling, and unresolved fixed-deposit cells.
- `analysis/findings.txt`: validated story-ready analytical findings.

### Model conventions

- Savings: monthly compounding using the annualized CBN savings benchmark divided by 12.
- Fixed deposits: lock the tenor rate at term start, accrue simple interest, and roll principal + interest at maturity using the rate then available.
- Missing fixed-deposit rates are never imputed. A simulation stops when it requires an unresolved rate.
- Real wealth is expressed in start-month naira using NBS headline CPI on the pre-2025 basis.
- USD equivalent uses CBN official/reference NGN per USD, not the parallel market.

This is a benchmark simulation, not a reconstruction of any specific bank account or retail savings product.

## Project structure

```text
the-naira-illusion/
├── index.html
├── .nojekyll
├── css/
│   └── styles.css
├── js/
│   ├── app.js
│   └── simulator.js
├── data/
│   ├── naira_illusion_monthly.csv
│   └── sources.md
├── analysis/
│   └── findings.txt
└── README.md
```
