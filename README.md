# ioBroker.freshtomato

[![NPM version](https://img.shields.io/npm/v/iobroker.freshtomato.svg)](https://www.npmjs.com/package/iobroker.freshtomato)
[![Downloads](https://img.shields.io/npm/dm/iobroker.freshtomato.svg)](https://www.npmjs.com/package/iobroker.freshtomato)
![Number of Installations](https://iobroker.live/badges/freshtomato-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/freshtomato-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.freshtomato.png?downloads=true)](https://nodei.co/npm/iobroker.freshtomato/)

**Tests:** ![Test and Release](https://github.com/urdl/iobroker.freshtomato/workflows/Test%20and%20Release/badge.svg)

## freshtomato adapter for ioBroker

Monitor and control FreshTomato based routers via their local HTTP API

A longer manual, covering every setting and the adapter's quirks in detail, is
available in German: [docs/de/README.md](docs/de/README.md).

## Requirements

* A router running [FreshTomato](https://freshtomato.org/) with the web interface reachable from your ioBroker host
* The web interface user name and password
* The router's **HTTP ID**, a CSRF token found in the router UI under *Administration → Admin Access → Web Admin ID*. It looks like `TID1a2b3c4d5e6f7890`.

No SSH or Telnet access is needed; the adapter only talks to the web interface.

## Configuration

| Setting | Default | Description |
|---|---|---|
| Host name or IP address | – | Address of the router web interface |
| Port | `80` | Port of the web interface |
| Use HTTPS | off | Enable only if the web interface is configured for TLS. Switching this moves the port between 80 and 443. |
| Accept a self-signed certificate | off | Shown when HTTPS is on. See below. |
| User name | `root` | Web interface user |
| Password | – | Web interface password, stored encrypted |
| HTTP ID | – | CSRF token, stored encrypted |
| Poll interval | `30` s | How often the router is queried, between 10 and 600 seconds |
| Request timeout | `15` s | How long a single request may take, between 5 and 120 seconds. Raise it for an older router or a slow link. |
| Offline timeout | `120` s | Grace before a device without a live signal is marked offline, between 0 and 3600 seconds. See *Presence* below. |
| Create one channel per connected device | on | Turn off on busy networks; the full list stays available as JSON. Per-device traffic logging needs these channels. |
| Allow rebooting the router | off | Until this is set, `system.reboot` exists but cannot be written |
| InfluxDB instance | disabled | Which InfluxDB adapter instance records the KPIs. See *InfluxDB logging* below. |
| Datapoint prefix | – | Stored as the InfluxDB alias, e.g. `freshtomato.system.load1`. Empty uses the real datapoint id. |
| Log … KPIs | off | Four group switches: system, network, WLAN, device counts. |

Which devices have their traffic logged is no longer set here. It is a switch
per device in the object tree; see *Per device traffic* below.

A wrong HTTP ID does not produce an authentication error. The router closes the
connection without answering, which looks like a network problem. The adapter
detects this and logs *"Router closed the connection without answering"* with a
pointer to the HTTP ID, so check that setting first when you see it.

The adapter warns when it connects over plain HTTP, because basic auth then puts
the router password on the wire in base64. On a trusted LAN that is the usual
FreshTomato setup; enable HTTPS if the web interface is configured for it.

### HTTPS and the router's certificate

FreshTomato generates a self-signed certificate for its web interface. Node
rejects such a certificate, so enabling HTTPS on its own makes every poll fail
with *"Router certificate not trusted"*.

Ticking **Accept a self-signed certificate** makes the adapter connect anyway.
That is a real trade-off and worth understanding: the traffic is encrypted, so
nobody can read the password off the wire, but the adapter no longer checks that
the certificate belongs to the router. Anything able to answer on that address
would be accepted, which is what makes a machine-in-the-middle attack possible —
someone positioned between ioBroker and the router could present their own
certificate, receive the credentials and relay the traffic, and nothing would
look wrong.

On a network you control that risk is usually acceptable, and it is still an
improvement over plain HTTP, where the password travels in the clear. It is not
a substitute for a certificate the system actually trusts. The adapter logs a
warning for as long as the option is active.

There is no way around this by supplying a better certificate. FreshTomato
generates its own and offers no field for uploading one; the settings under
*Administration → Admin Access* only cover the common name (`https_crt_cn`),
whether the certificate is kept across reboots (`https_crt_save`) and a trigger
to regenerate it (`https_crt_gen`). Whatever it produces is signed by itself, so
this option is the only way to use HTTPS at all.

The generated certificate does list the router under both its IP address and its
configured name, so the host name you enter here is not the problem — only the
missing signature is. Note that with `https_crt_save` enabled the certificate is
stored and reused, so changing the common name takes effect only after
regenerating it.

## Objects

| Object | Contents |
|---|---|
| `info` | `connection`, `firmware`, `model`, `routerName`, `uptime`, `lastUpdate` |
| `system` | CPU temperature, load averages, memory, swap, NVRAM usage, processes, CPU and bootloader details, `reboot` |
| `network.wan`, `network.wan2` … | IP, netmask, gateway, DNS, domain, host name, protocol, MAC, MTU, connected flag, connection uptime, DHCP lease remaining. Only the WANs reported as in use are created. |
| `network.lan` | IP, netmask, MAC, gateway, bridge interface, DHCP range |
| `wlan.2G`, `wlan.5G` | SSID, channel, centre frequency, channel width, maximum rate, noise floor, radio temperature, security mode, encryption, hidden flag, client count |
| `interfaces.<name>` | `rxBytes` and `txBytes` per interface |
| `ports.<name>` | Link state, speed and duplex for each switch port |
| `usb.<disk+partition>` | Vendor, product, disk, partition number, volume label, mount point, file system, total/free/used bytes, used percent, `attached`. One entry per mounted partition; unplugging keeps the last known size and only clears `attached`. |
| `devices` | `count`, `wirelessCount` and `json` with the full device list |
| `devices.<mac>` | IP, host name, interface, `online`, `presenceSource`, `lastSeen`, and for wireless clients the signal strength, link rates, band and connection time. Traffic counters when the device is selected, see below. |

Device channels are keyed by MAC address, so a client keeps its object when its
IP changes. Devices are never deleted, so history stays intact; a device that
is no longer around simply has its `online` state set to `false`.

### Presence

`online` reflects whether a device is actually reachable, not merely whether the
router still lists it. The router's ARP table keeps entries long after a device
has gone — a deleted DHCP reservation, for instance, can linger there until the
next reboot — and the table carries no timestamp, so ARP presence alone cannot
be trusted.

A device is therefore counted as present only on a **live signal**: it is
associated as a wireless client, or its traffic counters grew since the previous
poll. `presenceSource` records which applied: `wireless`, `traffic`, `arp` (see
below), `grace` (no signal this poll but still inside the timeout) or `offline`.

#### Routers without traffic accounting

Not every router reports per-address traffic counters. A box in **access point
mode** bridges rather than routes, so it has nothing to account and returns an
empty list. On such a router a wired device can never produce a live signal, and
demanding one would report every one of them as permanently offline.

When the router reports no counters at all, presence therefore falls back to the
router's own tables, and those devices report `presenceSource: arp`. It is
weaker evidence — a stale entry can keep a departed device online — but far
better than declaring a device that is plainly there to be gone. The fallback is
automatic and applies per router: a router that does account traffic keeps the
strict rules, and the adapter logs once which mode it is in. Per-device traffic
states cannot be filled on such a router either, since the data does not exist.

The **offline timeout** is the grace between the last live signal and `online`
turning `false`. It bridges the gaps between polls and, for a wired device,
between bursts of traffic. Raising it keeps devices online through longer quiet
spells; `0` turns a device offline the moment a poll shows no activity.

Three consequences worth knowing. They apply on a router that **does** account
traffic; where the `arp` fallback is in effect none of them do, since that path
needs no counters at all. A device that is on but completely silent — no
wireless association and no traffic — falls offline once the timeout passes; the
ioBroker `ping` adapter is the tool for that case. A stale ARP entry, having no
live signal at all, settles to offline on its own rather than showing online
forever. And a purely wired device can read as offline for one interval after
the adapter restarts: its presence comes from traffic counters growing, which
needs two readings, and the first poll only establishes the baseline.

`lastSeen` is stamped only on a confirmed presence, so it points at the last
sign of life rather than the last poll. Where the `arp` fallback applies it
follows that same rule and so is only as strong as the evidence behind it —
which is still better than leaving it empty on a router that can offer nothing
else.

Because the traffic counters are the activity signal, the traffic page is now
read on every poll even when no device has per-device logging switched on. It is
one small request against the router; on very old hardware with a short poll
interval it is worth being aware of.

## Control

Three states can be written to:

| State | Effect | Guarded |
|---|---|---|
| `wlan.<band>.radioEnabled` | Switches that radio on or off | – |
| `network.<wan>.renewLease` | Renews the DHCP lease of that WAN | – |
| `system.reboot` | Restarts the router | requires an opt-in, see below |

**Switching a radio off disconnects every client on that band**, so a Wi-Fi
device cannot switch it back on afterwards. Keep a wired path to the router, or
to ioBroker, before using it.

Writes are only acted on when they arrive unacknowledged, which is how ioBroker
distinguishes a user's intent from the adapter's own reporting. The reported
value is not set optimistically: the adapter re-reads the router a few seconds
later, so what you see is what the router did rather than what was asked of it.

Those few seconds are deliberate. The router answers before the radio has
actually come up, and an immediate poll would report the previous value and look
like the command had been ignored.

### Rebooting

`system.reboot` restarts the router. It is guarded twice, because for most
installations the router is the only way anything reaches the internet.

The state exists whether or not rebooting is allowed, so it can be found in the
object browser, but it is **not writable** until *Allow rebooting the router* is
ticked in the instance settings. The handler checks the same setting again
before acting, in case the object was made writable some other way — an imported
configuration, a manual edit, an older release. Only the value `true` triggers
it; a stray truthy write does nothing.

The adapter logs a warning before sending the command and sets `info.connection`
to false afterwards. It does not poll again straight away: the router is gone
for a minute or more, and the normal interval picks it up when it answers.

Note that the command is not verified against real hardware, unlike the rest of
the adapter. Rebooting a router to test rebooting takes the household offline,
so what is tested is that the request matches the one the router's own web
interface sends.

## Per device traffic

Each device channel carries a writable `trafficEnabled` switch, off by default.
Turn it on and the device gains four extra states:

| State | Meaning |
|---|---|
| `bytesIn`, `bytesOut` | Cumulative counters, as the router reports them |
| `rateIn`, `rateOut` | Bytes per second since the previous poll |

The switch takes effect live, without restarting the adapter, and its setting
survives restarts. Nothing is measured, and the extra request is not even sent,
until at least one device is switched on — on a busy network this would
otherwise add several hundred states nobody asked for. Turning a device back off
drops its rate baseline, so a later re-enable does not report one huge spike
across the gap.

What the columns mean was established by measurement rather than assumed. Two
samples 45 seconds apart, checked against the byte counters of the LAN bridge,
give 748 and 209 bytes per packet for the two directions, and the larger figure
tracks what the bridge sent towards the LAN. Six further columns are left
untouched: some of them were seen *decreasing*, so they are not counters at all,
and what they do mean was not established.

Counters restart at zero when the router reboots. A reading below its
predecessor is treated as a restart: no rate is reported for that interval
rather than a negative one, or the very large positive one that a subtraction
would produce if the result were treated as unsigned.

A device is matched to its counters through its current IP address. One without
an address is skipped rather than guessed at, since an address handed to someone
else by DHCP would otherwise attribute a stranger's traffic to it. In practice
not every device has counters — on the network this was developed against, 49 of
75 did; the rest appear in the ARP table but generate no traffic through the
router.

Note that this shows how much a device sends, not where it sends it. The router
offers no per device destination data: its web monitor only records plain HTTP
host headers and unencrypted DNS, and on a current network it stays empty. For
destinations, a DNS resolver that logs per client is the tool.

## InfluxDB logging

For long-term graphs in Grafana, selected KPIs can be recorded to InfluxDB. The
adapter does not write to InfluxDB itself and never handles InfluxDB
credentials — that would duplicate the InfluxDB adapter, which already does it
well. Instead it tells the InfluxDB adapter which datapoints to record, through
that adapter's own `enableHistory` interface. The InfluxDB adapter then logs
them with its configured connection.

Pick the InfluxDB instance in the settings and switch on the KPI groups you
want:

| Group | Datapoints |
|---|---|
| System | CPU temperature, load averages, free/available/total memory |
| Network | interface `rxBytes`/`txBytes`, WAN `connected` |
| WLAN | per-band client count, radio temperature, noise floor |
| Device counts | `devices.count`, `devices.wirelessCount` |

Per-device traffic is deliberately not offered here: it is dynamic and would add
a time series per device. Enable those individually on the device's own
`bytesIn`/`bytesOut` states if you need them.

The **datapoint prefix** becomes each point's InfluxDB alias, so a prefix of
`freshtomato` stores `system.load1` as `freshtomato.system.load1`. Leave it
empty to store under the real datapoint id.

The adapter only ever disables logging it enabled itself — it keeps a record in
`info.influxManaged` — so a datapoint you switched on by hand in the object
browser is left untouched.

### Limitations

One consequence of how the selection is applied: **it is resolved once, at
startup.** A datapoint that only comes into existence later — a WAN that
connects after the adapter started, a new interface — is not picked up until the
adapter restarts. The curated groups cover states that already exist by then, so
this rarely shows.

Setting the instance to "disabled", or moving to a different one, does switch
the logging off where it was enabled: the adapter records which instance owns
its datapoints and retracts them there on the next start.

If a datapoint cannot be switched off — the InfluxDB instance is unresponsive
at that moment, say — it stays on the managed list and is retried on the next
start, rather than being dropped while it is still logging.

## Notes on the router API

FreshTomato does not offer a JSON API. Its status pages return JavaScript source
containing variable assignments, which this adapter parses with a small
tokenizer rather than by evaluating the response.

Some values need interpretation that is not obvious from the raw data:

* Load averages are Linux fixed point values and are divided by 65536.
* Interface byte counters arrive as hexadecimal literals.
* Per radio temperatures are only available inside a pre-rendered UI string.
* Wireless link rates are reported in kbit/s and converted to Mbit/s.

## Secrets in the log

The password and the HTTP ID are stored encrypted, and neither is written to the
ioBroker log. Two paths could otherwise expose the HTTP ID and are filtered:

* The adapter sends it as `_http_id` in a query string, so a runtime error that
  quotes the request URL would carry it.
* The router sends it back. `status-data.jsx` includes `http_id` in its nvram
  dump, so a parse error whose excerpt covered that key would reproduce it.

The second path also means the filter cannot rely on the configured value alone:
if that value is wrong, the response still contains the real token, which the
adapter has never seen. Anything that looks like an `http_id` assignment or a
basic auth header is masked as well.

Note that a wrong HTTP ID is reported as *"Router closed the connection without
answering"* rather than as an authentication error, because that is how the
router behaves.

## Credits

This adapter builds on the groundwork of
[ha-freshtomato](https://github.com/mx5gr/ha-freshtomato) by **mx5gr**, a
FreshTomato integration for Home Assistant, licensed under the MIT License.

That project is where the shape of the router's interface was first worked out:
which endpoints exist, that `update.cgi` takes an `exec` action, and that the
`_http_id` token has to accompany every request. Without it this adapter would
have started from a blank page.

No code was taken. ha-freshtomato is written in Python for Home Assistant, while
the HTTP client, the tokenizer and the data model here were written from scratch
against responses recorded from a real router. A few conclusions differ as a
result:

* The responses are parsed with a recursive tokenizer rather than with regular
  expressions, which is what nested structures such as `wlstats` require.
* The `Referer` header turned out not to be checked by FreshTomato 2026.3.
* A rejected `_http_id` does not produce an empty response body; the router
  closes the connection without answering.

These are observations from one router on one firmware version, not corrections
to the upstream project, which targets a different range of devices.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### 0.8.1 (2026-08-09)
* (U.R.D.L) Fixed: the InfluxDB `deviceCounts` group was missing the `onlineCount`/`offlineCount` states added in 0.8.0

### 0.8.0 (2026-08-09)
* (U.R.D.L) Added CPU usage as a percentage, derived from two `sysinfo.jiffies` samples
* (U.R.D.L) Added `devices.onlineCount`/`devices.offlineCount`, an aggregate over the existing per-device presence states

### 0.7.2 (2026-08-08)
* (U.R.D.L) Replaced the scaffold placeholder icon with an actual logo
* (U.R.D.L) Fixed: the product name was machine-translated per language instead of staying "FreshTomato" everywhere

### 0.7.1 (2026-08-08)
* (U.R.D.L) Fixed: a router without USB/NAS support was misdiagnosed as having a wrong HTTP ID, because that call answers with an empty body when there is nothing to report and every other call was expected to never do that

### 0.7.0 (2026-08-07)
* (U.R.D.L) Added WAN connection uptime and DHCP lease remaining, read from the same `stats` object the router's own status page uses
* (U.R.D.L) Added attached USB storage: one object per mounted partition with vendor, product, size, free space and mount point

### 0.6.0 (2026-08-03)
* (U.R.D.L) The request timeout is configurable, 5 to 120 seconds, and no longer tied to the poll interval
* (U.R.D.L) The per-address traffic page is skipped once a router has shown it accounts nothing, which took a poll against a slow router from 8.7 s to 0.1 s
* (U.R.D.L) A timeout on a host name now says a name lookup is a candidate, since one that never returns hits the same deadline
* (U.R.D.L) Fixed: a port set by hand was overwritten whenever HTTPS was toggled; only the defaults 80 and 443 are swapped now
* (U.R.D.L) Fixed: setting the InfluxDB instance to disabled, or changing it, left the logging running; the adapter now records which instance owns its datapoints and retracts them there
* (U.R.D.L) Added a German manual covering every setting and the adapter's quirks

### 0.5.2 (2026-08-02)
* (U.R.D.L) Fixed: on a router that accounts no traffic, such as one in access point mode, wired devices were reported offline while plainly present; presence there now falls back to the router tables and reports presenceSource `arp`

### 0.5.1 (2026-08-02)
* (U.R.D.L) Fixed: a datapoint whose InfluxDB logging could not be switched off was dropped from the managed list anyway and kept logging unnoticed; it now stays on the list and is retried
* (U.R.D.L) Messages carrying no command are answered instead of leaving the caller waiting

### 0.5.0 (2026-08-01)
* (U.R.D.L) Optional InfluxDB logging: enable the per-datapoint logging option for selected KPI groups through the InfluxDB adapter, with a configurable prefix stored as the alias; the adapter never logs to InfluxDB itself

### 0.4.0 (2026-08-01)
* (U.R.D.L) Presence is judged from live signals (wireless association or a change in traffic counters) instead of the router's ARP table, with a configurable offline timeout and a new presenceSource state per device

### 0.3.0 (2026-08-01)
* (U.R.D.L) Per-device traffic logging is now a writable switch per device instead of a table in the settings, toggleable live without a restart; an existing selection is migrated automatically

### 0.2.0 (2026-08-01)
* (U.R.D.L) Control: switch a wireless radio on or off, renew a WAN DHCP lease
* (U.R.D.L) Reboot the router, behind an explicit opt-in
* (U.R.D.L) Per device traffic counters and rates, for devices you select

### 0.1.0 (2026-08-01)
* (U.R.D.L) Read-only monitoring: system, WAN, LAN, wireless radios, switch ports, interface counters and connected devices
* (U.R.D.L) Keep the router CSRF token out of the ioBroker log
* (U.R.D.L) Support HTTPS with the router's self-signed certificate, behind an explicit opt-in
* (U.R.D.L) Switch the suggested port between 80 and 443 when HTTPS is toggled
* (U.R.D.L) Record when each device was last seen

## License
MIT License

Copyright (c) 2026 U.R.D.L

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
