# Muffin

A smart pantry and meal-planning tracker, built as an installable iOS PWA.
No build step — plain ES modules, IndexedDB for storage, a service worker
for offline use. All data stays on the device.

**Features:** pantry with quick add and expiry tracking · camera barcode
scanning with Open Food Facts lookup · supermarket order-paste import ·
recipes with paste extraction and a cook mode that deducts ingredients ·
pantry-first and use-it-up recipe recommendations · budgeted weekly meal
plan with generated shopping lists and staples restock · daily nutrition
tracking with targets (Open Food Facts + USDA FoodData Central) · waste
log with over-buying insights.

Everything captured automatically (scans, pasted orders, extracted recipes,
deductions) passes through an editable review screen before it commits.

## Run locally

```
python3 tools/serve.py 8787 .
```

Then open http://localhost:8787.

## Install on iPhone

Open the deployed site in Safari → Share → **Add to Home Screen**.
