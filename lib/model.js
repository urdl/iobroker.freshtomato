'use strict';

/*
 * Turns the raw variables scraped from the router into a flat, stable model.
 *
 * Everything here is a pure function of its input, so the mapping can be tested
 * against recorded router responses without touching ioBroker or the network.
 */

/** Linux reports load averages as fixed point with 16 fractional bits. */
const SI_LOAD_SHIFT = 65536;

/** Lowest centre frequency that belongs to the 6 GHz band, in MHz. */
const BAND_6G_START_MHZ = 5925;

/** Lowest centre frequency that belongs to the 5 GHz band, in MHz. */
const BAND_5G_START_MHZ = 3000;

/**
 * Turns a MAC address into something usable as an ioBroker object id.
 *
 * @param {string} mac - MAC address in colon notation
 * @returns {string} Lower case hex without separators
 */
function macToId(mac) {
	return String(mac)
		.replace(/[^0-9a-fA-F]/g, '')
		.toLowerCase();
}

/**
 * Makes an arbitrary name safe to use as one segment of an ioBroker object id.
 *
 * The dot is the level separator, so an interface called `eth0.1` — a normal
 * Linux VLAN sub-interface name — would silently create an extra level and put
 * states where channels belong. Characters ioBroker rejects outright are mapped
 * as well.
 *
 * @param {string} name - Raw name as reported by the router
 * @returns {string} A single safe id segment
 */
function toIdSegment(name) {
	return String(name)
		.replace(/[.\][*,;'"`<>\\?\s]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '');
}

/**
 * Converts a value to a number, mapping anything unparsable to null so a bad
 * reading never silently becomes 0.
 *
 * @param {unknown} value - Raw value
 * @returns {number|null} The number, or null
 */
function num(value) {
	if (value === null || value === undefined) {
		return null;
	}
	// Number(' ') is 0, so an nvram field holding only whitespace would be
	// reported as a real reading of zero rather than as "no value".
	const raw = typeof value === 'string' ? value.trim() : value;
	if (raw === '') {
		return null;
	}
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

/**
 * Reads an nvram flag, which uses '1'/'0' strings.
 *
 * @param {unknown} value - Raw value
 * @returns {boolean} Whether the flag is set
 */
function flag(value) {
	return value === '1' || value === 1 || value === true;
}

/**
 * Returns a trimmed string, or null when there is nothing to report.
 *
 * @param {unknown} value - Raw value
 * @returns {string|null} The string, or null
 */
function str(value) {
	if (value === null || value === undefined) {
		return null;
	}
	const s = String(value).trim();
	return s === '' ? null : s;
}

/**
 * Decides the band label for a radio from its centre frequency.
 *
 * @param {number|null} mhz - Centre frequency in MHz
 * @returns {string} '2G', '5G', '6G' or 'unknown'
 */
function bandFromMhz(mhz) {
	if (mhz === null) {
		return 'unknown';
	}
	if (mhz < BAND_5G_START_MHZ) {
		return '2G';
	}
	return mhz < BAND_6G_START_MHZ ? '5G' : '6G';
}

/**
 * Extracts per radio temperatures from the `wlsense` field.
 *
 * The field is a pre-rendered UI string rather than data, for example
 * `eth1: 2.4G - 49&#176;C&nbsp;/&nbsp;120&#176;F    eth2: 5G - 55&#176;C…`.
 *
 * @param {unknown} wlsense - Raw `sysinfo.wlsense` value
 * @returns {Record<string, number>} Interface name to temperature in °C
 */
function parseRadioTemperatures(wlsense) {
	const result = {};
	if (typeof wlsense !== 'string') {
		return result;
	}
	const re = /(\w+):\s*[\d.]+G\s*-\s*(-?\d+(?:\.\d+)?)\s*(?:&#176;|°)C/g;
	let match;
	while ((match = re.exec(wlsense)) !== null) {
		result[match[1]] = Number(match[2]);
	}
	return result;
}

/**
 * Interprets a switch port state such as `1000FD` or `DOWN`.
 *
 * @param {unknown} state - Raw `etherstates` entry
 * @returns {{state: string, up: boolean, speed: number|null, duplex: string|null}} Decoded port state
 */
function parsePortState(state) {
	const raw = str(state) ?? 'DOWN';
	const match = raw.match(/^(\d+)(FD|HD)$/i);
	if (!match) {
		return { state: raw, up: false, speed: null, duplex: null };
	}
	return {
		state: raw,
		up: true,
		speed: Number(match[1]),
		duplex: match[2].toUpperCase() === 'FD' ? 'full' : 'half',
	};
}

/**
 * Builds the system section from `sysinfo` and `nvstat`.
 *
 * @param {Record<string, unknown>} sysinfo - Parsed `sysinfo`
 * @param {Record<string, unknown>} nvstat - Parsed `nvstat`
 * @returns {Record<string, unknown>} System values
 */
function buildSystem(sysinfo, nvstat) {
	const loads = Array.isArray(sysinfo.loads) ? sysinfo.loads : [];
	/**
	 * @param {number} i - Index into the load average triple
	 * @returns {number|null} Load average rounded to two decimals
	 */
	const load = i => {
		const v = num(loads[i]);
		return v === null ? null : Math.round((v / SI_LOAD_SHIFT) * 100) / 100;
	};
	return {
		uptime: num(sysinfo.uptime),
		uptimeText: str(sysinfo.uptime_s),
		load1: load(0),
		load5: load(1),
		load15: load(2),
		cpuTemperature: num(sysinfo.cputemp),
		cpuType: str(sysinfo.systemtype),
		cpuClock: str(sysinfo.cpuclk),
		cfeVersion: str(sysinfo.cfeversion),
		processes: num(sysinfo.procs),
		flashSize: num(sysinfo.flashsize),
		memTotal: num(sysinfo.totalram),
		memFree: num(sysinfo.freeram),
		memBuffers: num(sysinfo.bufferram),
		memCached: num(sysinfo.cached),
		memAvailable: num(sysinfo.totalfreeram),
		swapTotal: num(sysinfo.totalswap),
		swapFree: num(sysinfo.freeswap),
		nvramTotal: num(nvstat.size),
		nvramFree: num(nvstat.free),
	};
}

/**
 * Builds one entry per configured WAN interface.
 *
 * FreshTomato always carries nvram keys for four WANs; `mwan_num` says how many
 * are actually in use. Only those are reported, so a single WAN setup does not
 * grow three permanently empty channels.
 *
 * @param {Record<string, unknown>} nvram - Parsed nvram
 * @param {Array<string>} [wanUptime] - Parsed `stats.wanuptime`, one entry per WAN slot
 * @param {Array<string>} [wanLease] - Parsed `stats.wanlease`, one entry per WAN slot
 * @returns {Array<Record<string, unknown>>} WAN entries
 */
function buildWans(nvram, wanUptime = [], wanLease = []) {
	const count = Math.min(Math.max(num(nvram.mwan_num) ?? 1, 1), 4);
	const wans = [];
	for (let i = 1; i <= count; i++) {
		const p = i === 1 ? 'wan' : `wan${i}`;
		const ip = str(nvram[`${p}_ipaddr`]);
		// The router formats these itself ("11 days, 20h 01m 23s") and uses '--'
		// for a WAN slot that is not up, which is left as is rather than mapped
		// to null: it is already a valid thing to show.
		const uptime = str(wanUptime[i - 1]);
		const leaseRemaining = str(wanLease[i - 1]);
		wans.push({
			id: p,
			index: i,
			ip,
			netmask: str(nvram[`${p}_netmask`]),
			gateway: str(nvram[`${p}_gateway`]) ?? str(nvram[`${p}_gateway_get`]),
			dns: str(nvram[`${p}_dns`]),
			domain: str(nvram[`${p}_domain`]) ?? str(nvram[`${p}_get_domain`]),
			hostname: str(nvram[`${p}_hostname`]),
			proto: str(nvram[`${p}_proto`]),
			mac: str(nvram[`${p}_hwaddr`]),
			mtu: num(nvram[`${p}_run_mtu`]),
			// An address of 0.0.0.0 is what the router shows while a link is down.
			connected: ip !== null && ip !== '0.0.0.0',
			uptime,
			leaseRemaining,
		});
	}
	return wans;
}

/**
 * Builds the primary LAN bridge section.
 *
 * @param {Record<string, unknown>} nvram - Parsed nvram
 * @returns {Record<string, unknown>} LAN values
 */
function buildLan(nvram) {
	return {
		ip: str(nvram.lan_ipaddr),
		netmask: str(nvram.lan_netmask),
		mac: str(nvram.lan_hwaddr),
		gateway: str(nvram.lan_gateway),
		interface: str(nvram.lan_ifname),
		dhcpStart: str(nvram.dhcpd_startip),
		dhcpEnd: str(nvram.dhcpd_endip),
	};
}

/**
 * Builds one entry per mounted partition on an attached USB storage device.
 *
 * `usbdev` nests three levels: one entry per physical device, each carrying a
 * list of `[diskName, partitions]` pairs (a device can expose more than one
 * disk, e.g. a card reader), each partition again an array of fixed columns.
 * A disk with nothing mounted reports as `[-1, []]` and is skipped — there is
 * no size or mountpoint to show for it.
 *
 * Flattened to one entry per partition rather than nested further: that is
 * the unit a user actually wants to watch (free space on a mounted volume),
 * and it keeps the object tree as flat as `interfaces.<name>`/`ports.<name>`
 * instead of adding a fourth hierarchy level.
 *
 * @param {Array<Array<unknown>>} usbdev - Parsed `usbdev`
 * @returns {Array<Record<string, unknown>>} One entry per mounted partition
 */
function buildUsb(usbdev) {
	const partitions = [];
	for (const device of Array.isArray(usbdev) ? usbdev : []) {
		const [, , vendor, product, , disks, attachedFlag] = device;
		const attached = attachedFlag === 1 || attachedFlag === '1';
		for (const disk of Array.isArray(disks) ? disks : []) {
			const [diskName, diskPartitions] = Array.isArray(disk) ? disk : [];
			if (diskName === -1 || !Array.isArray(diskPartitions)) {
				continue;
			}
			for (const partition of diskPartitions) {
				const [label, partNum, mountpoint, filesystem, , totalBytes, freeBytes] = Array.isArray(partition)
					? partition
					: [];
				const total = num(totalBytes);
				const free = num(freeBytes);
				const used = total !== null && free !== null ? total - free : null;
				partitions.push({
					id: toIdSegment(`${str(diskName) ?? 'disk'}${partNum ?? ''}`),
					vendor: str(vendor),
					product: str(product),
					disk: str(diskName),
					partition: num(partNum),
					label: str(label),
					mountpoint: str(mountpoint),
					filesystem: str(filesystem),
					totalBytes: total,
					freeBytes: free,
					usedBytes: used,
					usedPercent: total ? Math.round((used / total) * 1000) / 10 : null,
					attached,
				});
			}
		}
	}
	return partitions;
}

/**
 * Builds one entry per wireless radio.
 *
 * `wlstats` is indexed by wl unit, the same index the `wl<n>_*` nvram keys use.
 *
 * @param {Record<string, unknown>} nvram - Parsed nvram
 * @param {Array<Record<string, unknown>>} wlstats - Parsed `wlstats`
 * @param {Record<string, number>} radioTemps - Interface name to temperature
 * @param {Array<Array<unknown>>} wldev - Parsed `wldev`, used to count clients
 * @returns {Array<Record<string, unknown>>} Radio entries
 */
function buildRadios(nvram, wlstats, radioTemps, wldev) {
	const stats = Array.isArray(wlstats) ? wlstats : [];
	// Interfaces appear in wldev in unit order, so the n-th distinct interface
	// name belongs to unit n. That mapping is needed for the temperatures,
	// which are keyed by interface name rather than by unit.
	const ifaceByUnit = [];
	for (const row of Array.isArray(wldev) ? wldev : []) {
		const unit = num(row[6]);
		const iface = str(row[0]);
		if (unit !== null && iface && ifaceByUnit[unit] === undefined) {
			ifaceByUnit[unit] = iface;
		}
	}

	const usedIds = new Set();
	return stats.map((s, unit) => {
		const mhz = num(s.mhz);
		let id = bandFromMhz(mhz);
		if (usedIds.has(id)) {
			id = `${id}_${unit}`;
		}
		usedIds.add(id);
		const iface = ifaceByUnit[unit] ?? null;
		return {
			id,
			unit,
			interface: iface,
			ssid: str(nvram[`wl${unit}_ssid`]),
			channel: num(s.channel),
			frequency: mhz,
			bandwidth: num(s.nbw),
			maxRate: num(s.rate),
			noise: num(s.noise),
			interference: num(s.intf),
			radioEnabled: flag(nvram[`wl${unit}_radio`]) && num(s.radio) !== 0,
			security: str(nvram[`wl${unit}_security_mode`]),
			crypto: str(nvram[`wl${unit}_crypto`]),
			netMode: str(nvram[`wl${unit}_net_mode`]),
			mode: str(nvram[`wl${unit}_mode`]),
			mac: str(nvram[`wl${unit}_hwaddr`]),
			hidden: flag(nvram[`wl${unit}_closed`]),
			temperature: iface !== null && iface in radioTemps ? radioTemps[iface] : null,
			clients: (Array.isArray(wldev) ? wldev : []).filter(r => num(r[6]) === unit).length,
		};
	});
}

/**
 * Merges ARP entries, wireless link statistics and DHCP leases into one list of
 * connected devices, keyed by MAC.
 *
 * @param {Array<Array<unknown>>} arplist - Parsed `arplist`
 * @param {Array<Array<unknown>>} wldev - Parsed `wldev`
 * @param {Array<Array<unknown>>} leases - Parsed `dhcpd_lease`
 * @param {Array<Record<string, unknown>>} radios - Result of buildRadios
 * @returns {Array<Record<string, unknown>>} Devices sorted by IP
 */
function buildDevices(arplist, wldev, leases, radios) {
	const byMac = new Map();

	/**
	 * @param {unknown} rawMac - MAC in any notation
	 * @returns {Record<string, unknown>|null} The device record, creating it if needed
	 */
	const ensure = rawMac => {
		const mac = str(rawMac);
		if (!mac) {
			return null;
		}
		const id = macToId(mac);
		if (id.length !== 12) {
			return null;
		}
		if (!byMac.has(id)) {
			byMac.set(id, {
				id,
				mac: mac.toUpperCase(),
				ip: null,
				hostname: null,
				interface: null,
				wireless: false,
				band: null,
				rssi: null,
				txRate: null,
				rxRate: null,
				connectedTime: null,
				leaseExpires: null,
			});
		}
		return byMac.get(id);
	};

	for (const row of Array.isArray(arplist) ? arplist : []) {
		const dev = ensure(row[1]);
		if (!dev) {
			continue;
		}
		dev.ip = str(row[0]) ?? dev.ip;
		dev.interface = str(row[2]) ?? dev.interface;
		const host = str(row[3]);
		// The router writes a literal '<unknown>' when it has no name.
		if (host && host !== '<unknown>') {
			dev.hostname = host;
		}
	}

	for (const row of Array.isArray(wldev) ? wldev : []) {
		const dev = ensure(row[1]);
		if (!dev) {
			continue;
		}
		const unit = num(row[6]);
		dev.wireless = true;
		dev.interface = str(row[0]) ?? dev.interface;
		dev.rssi = num(row[2]);
		// Rates are reported in kbit/s; Mbit/s is what the router's own UI shows.
		dev.txRate = num(row[3]) === null ? null : Math.round(num(row[3]) / 1000);
		dev.rxRate = num(row[4]) === null ? null : Math.round(num(row[4]) / 1000);
		dev.connectedTime = num(row[5]);
		const radio = radios.find(r => r.unit === unit);
		dev.band = radio ? radio.id : null;
	}

	for (const row of Array.isArray(leases) ? leases : []) {
		const dev = ensure(row[2]);
		if (!dev) {
			continue;
		}
		if (!dev.hostname) {
			const host = str(row[0]);
			if (host && host !== '*') {
				dev.hostname = host;
			}
		}
		dev.ip = dev.ip ?? str(row[1]);
		dev.leaseExpires = str(row[3]);
	}

	/**
	 * @param {string|null} ip - Dotted quad
	 * @returns {number} Sortable numeric form, 0 when absent
	 */
	const ipKey = ip => {
		if (!ip) {
			return 0;
		}
		const parts = ip.split('.').map(Number);
		return parts.length === 4 && parts.every(p => Number.isFinite(p))
			? ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
			: 0;
	};
	return [...byMac.values()].sort((a, b) => ipKey(a.ip) - ipKey(b.ip));
}

/**
 * Maps the `iptraffic` rows to named counters.
 *
 * Column meaning was established by measurement rather than taken on trust.
 * Two samples 45 s apart, compared against the netdev counters of the LAN
 * bridge:
 *
 *     [1] 1 416 956 bytes   [3] 1 893 packets   ->  748 bytes per packet
 *     [2]   486 014 bytes   [4] 2 327 packets   ->  209 bytes per packet
 *     br0 tx 1 918 729      br0 rx  733 026
 *
 * The larger byte column tracks what the bridge sent towards the LAN, so it is
 * what the device received. Both stay below the bridge totals, which is
 * expected: the bridge also carries traffic between local devices, which never
 * reaches a WAN counter.
 *
 * Columns 5 to 10 are deliberately not exposed. They are small, and columns 9
 * and 10 were observed *decreasing* — by as much as 106 within one interval —
 * so they are not cumulative counters and must never be differentiated. What
 * they do mean was not established, and guessing would put a wrong number in
 * front of a user.
 *
 * @param {Array<Array<unknown>>} rows - Parsed `iptraffic`
 * @returns {Map<string, {bytesIn: number, bytesOut: number, packetsIn: number, packetsOut: number}>} Counters by IP
 */
function buildTraffic(rows) {
	const byIp = new Map();
	for (const row of Array.isArray(rows) ? rows : []) {
		const ip = str(row[0]);
		if (!ip) {
			continue;
		}
		byIp.set(ip, {
			bytesIn: num(row[1]) ?? 0,
			bytesOut: num(row[2]) ?? 0,
			packetsIn: num(row[3]) ?? 0,
			packetsOut: num(row[4]) ?? 0,
		});
	}
	return byIp;
}

/**
 * Turns two counter readings into a rate, or null when that is not meaningful.
 *
 * The counters restart at zero when the router reboots. Subtracting blindly
 * would then yield a large negative number, or an absurd positive one wherever
 * the result is treated as unsigned. A reading below its predecessor is
 * therefore taken as a restart: no rate is reported for that interval and the
 * new value becomes the baseline.
 *
 * @param {number} previous - Earlier counter value
 * @param {number} current - Current counter value
 * @param {number} seconds - Time between the two readings
 * @returns {number|null} Units per second, or null if it cannot be derived
 */
function rateFrom(previous, current, seconds) {
	if (!Number.isFinite(previous) || !Number.isFinite(current) || !(seconds > 0)) {
		return null;
	}
	if (current < previous) {
		return null;
	}
	return Math.round((current - previous) / seconds);
}

/**
 * Assembles the complete model from all endpoint responses.
 *
 * @param {object} raw - Collected router data
 * @param {Record<string, unknown>} [raw.nvram] - Parsed nvram
 * @param {Record<string, unknown>} [raw.sysinfo] - Parsed `sysinfo`
 * @param {Array<Record<string, unknown>>} [raw.wlstats] - Parsed `wlstats`
 * @param {Record<string, unknown>} [raw.nvstat] - Parsed `nvstat`
 * @param {Record<string, unknown>} [raw.etherstates] - Parsed `etherstates`
 * @param {Array<Array<unknown>>} [raw.arplist] - Parsed `arplist`
 * @param {Array<Array<unknown>>} [raw.wldev] - Parsed `wldev`
 * @param {Array<Array<unknown>>} [raw.dhcpd_lease] - Parsed `dhcpd_lease`
 * @param {Record<string, {rx: number, tx: number}>} [raw.netdev] - Parsed `netdev`
 * @param {string|null} [raw.firmware] - Firmware version
 * @param {Array<string>} [raw.wanUptime] - Parsed `stats.wanuptime`
 * @param {Array<string>} [raw.wanLease] - Parsed `stats.wanlease`
 * @param {Array<unknown>} [raw.usbdev] - Parsed `usbdev`
 * @returns {Record<string, unknown>} The model
 */
function buildModel({
	nvram = {},
	sysinfo = {},
	wlstats = [],
	nvstat = {},
	etherstates = {},
	arplist = [],
	wldev = [],
	dhcpd_lease: leases = [],
	netdev = {},
	firmware = null,
	wanUptime = [],
	wanLease = [],
	usbdev = [],
} = {}) {
	const radioTemps = parseRadioTemperatures(sysinfo.wlsense);
	const radios = buildRadios(nvram, wlstats, radioTemps, wldev);
	const devices = buildDevices(arplist, wldev, leases, radios);

	return {
		info: {
			firmware,
			model: str(nvram.t_model_name),
			routerName: str(nvram.router_name),
			uptime: num(sysinfo.uptime),
			uptimeText: str(sysinfo.uptime_s),
		},
		system: buildSystem(sysinfo, nvstat),
		wans: buildWans(nvram, wanUptime, wanLease),
		lan: buildLan(nvram),
		usb: buildUsb(usbdev),
		radios,
		interfaces: Object.entries(netdev).map(([name, counters]) => ({
			id: toIdSegment(name),
			name,
			rxBytes: num(counters && counters.rx),
			txBytes: num(counters && counters.tx),
		})),
		ports: Object.entries(etherstates).map(([name, state]) => ({
			id: toIdSegment(name),
			name,
			...parsePortState(state),
		})),
		devices,
		deviceCount: devices.length,
		wirelessDeviceCount: devices.filter(d => d.wireless).length,
	};
}

/**
 * KPI groups offered for InfluxDB logging. Each test decides whether a state
 * id (relative to the instance) belongs to the group. Kept here, next to the
 * object model, so the ids and the groups cannot drift apart.
 */
const INFLUX_GROUPS = {
	system: id => /^system\.(cpuTemperature|load1|load5|load15|memFree|memAvailable|memTotal)$/.test(id),
	network: id => /^interfaces\..+\.(rxBytes|txBytes)$/.test(id) || /^network\.wan\d*\.connected$/.test(id),
	wlan: id => /^wlan\..+\.(clients|temperature|noise)$/.test(id),
	deviceCounts: id => id === 'devices.count' || id === 'devices.wirelessCount',
};

/**
 * Picks the datapoints to log to InfluxDB from the ids that actually exist,
 * according to which KPI groups are enabled. Per-device traffic is left out on
 * purpose: it is dynamic and would add a series per device.
 *
 * @param {Array<string>} ids - Existing state ids, relative to the instance
 * @param {Record<string, boolean>} groups - Enabled groups by name
 * @returns {Array<string>} The matching ids, sorted
 */
function influxTargets(ids, groups) {
	const active = Object.keys(INFLUX_GROUPS).filter(name => groups && groups[name]);
	return (Array.isArray(ids) ? ids : []).filter(id => active.some(name => INFLUX_GROUPS[name](id))).sort();
}

/**
 * Builds the InfluxDB alias for a datapoint from the configured prefix.
 *
 * The alias is the id the point is stored under, so a prefix of `freshtomato`
 * turns `system.load1` into `freshtomato.system.load1`. An empty prefix returns
 * an empty alias, which tells the InfluxDB adapter to store it under the real
 * state id.
 *
 * @param {string} prefix - Configured prefix, may be empty
 * @param {string} relativeId - State id relative to the instance
 * @returns {string} The alias, or '' for no aliasing
 */
function influxAlias(prefix, relativeId) {
	const clean = String(prefix || '')
		.trim()
		.replace(/\s+/g, '_')
		.replace(/\.+/g, '.')
		.replace(/^\.+|\.+$/g, '');
	return clean ? `${clean}.${relativeId}` : '';
}

module.exports = {
	buildModel,
	buildTraffic,
	rateFrom,
	influxTargets,
	influxAlias,
	buildSystem,
	buildWans,
	buildLan,
	buildUsb,
	buildRadios,
	buildDevices,
	parseRadioTemperatures,
	parsePortState,
	bandFromMhz,
	macToId,
	toIdSegment,
	num,
	flag,
	str,
};
