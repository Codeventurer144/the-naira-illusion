# Data sources and handling

## Coverage

132 monthly observations from January 2014 through December 2024.

- CPI: 132/132 populated.
- Savings deposit rate: 132/132 populated.
- USD/NGN: 132/132 populated.
- Fixed-deposit tenor cells intentionally unresolved: 22.

## Primary sources

- Central Bank of Nigeria — Money Market Indicators: https://www.cbn.gov.ng/rates/mnymktind.html
- CBN Money Market Indicators API: https://www.cbn.gov.ng/api/GetAllMoneyMarketIndicators
- CBN Monthly Average Exchange Rate API: https://www.cbn.gov.ng/api/GetAllMonthlyAvgExchRates
- CBN Daily Exchange Rate API: https://www.cbn.gov.ng/api/GetAllExchangeRates
- National Bureau of Statistics — December 2024 CPI tables: https://microdata.nigerianstat.gov.ng/index.php/catalog/154/download/1127

## CPI vintage

The historical module uses NBS headline All Items CPI on the pre-2025 basis (November 2009 = 100). The 2025 rebased CPI series is not spliced into this history.

Where the source historical table had isolated gaps, CPI was algebraically reconstructed using the NBS year-on-year rate:

`CPI_t = CPI_(t-12) × (1 + YoY_t / 100)`

## Known unresolved fixed-deposit cells

- 2019-12: 3-month tenor only.
- 2024-05 through 2024-10: 3-, 6-, and 12-month tenors.
- 2024-12: 3-, 6-, and 12-month tenors.

The simulator never forward-fills, interpolates, or substitutes another deposit benchmark for these cells.
