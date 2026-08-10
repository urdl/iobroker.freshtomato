# Grafana dashboard

`freshtomato-router-dashboard.json` is the exported "FreshTomato Router (ioBroker)"
dashboard (Grafana UID `freshtomato-router-iob`), sourced from InfluxDB via the
adapter's optional KPI logging (see the *InfluxDB logging* section in the main
README).

The dashboard has one templating variable, **Router**, switching the InfluxDB
measurement prefix between `main-router` and `ap-router` — replace those with
whatever each instance's *Datapoint prefix* setting actually writes under. One
set of panels covers both routers; panels specific to a second radio (5G
client count, noise, temperature) simply show no data for a router that only
has one.

Not applied automatically — the Grafana API token available to the adapter's
maintainer tooling is read-only. To update the live dashboard: Grafana →
Dashboard settings → JSON Model, paste this file's contents, save. Or import it
as a new dashboard via Dashboards → New → Import.

Kept here so a change to the adapter's datapoints (new state, renamed state)
has its matching dashboard change committed alongside the code, even though
applying it is a manual step.
