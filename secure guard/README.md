# SecureGuard AI

SecureGuard AI is a defensive, educational prototype for suspicious-login monitoring and account-takeover detection. It uses Flask, SQLite, Chart.js, and Lucide icons. All login events and response actions are simulated; the app does not connect to real accounts or block real IP addresses.

## Run locally

1. Use Python 3.9 or later.
2. Install the dependency: `python -m pip install -r requirements.txt`
3. Start the server: `python app.py`
4. Open `http://127.0.0.1:5000`.

The SQLite database is created as `secureguard.db` on first run and populated with sample events. Set `SECUREGUARD_DB` to use a different database path, and `PORT` to change the local server port.

## Features

- Login activity dashboard, risk distribution, and daily activity charts.
- Searchable and filterable event monitoring.
- Explainable rule-based login risk analysis (0–100).
- Account takeover alerts with simulated investigation, login-block, password-reset, and resolution actions.
- CSV report export and demo-data reset.

Risk levels are Low (0–30), Medium (31–60), and High (61–100). The rule engine uses failed-attempt count, account login history, unfamiliar IP/location/device, unusual login times, and recent login volume.

The frontend loads Chart.js, Lucide, and fonts from their public CDNs; an internet connection is needed for those assets.
