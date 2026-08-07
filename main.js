'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

const utils = require('@iobroker/adapter-core');
const { FreshTomatoClient, FreshTomatoError } = require('./lib/client');
const { buildModel, buildTraffic, rateFrom, influxTargets, influxAlias } = require('./lib/model');
const { createRedactor, redact } = require('./lib/redact');

/** Poll interval bounds in seconds, mirroring what the admin UI allows. */
const MIN_POLL_SECONDS = 10;
const MAX_POLL_SECONDS = 600;

/**
 * How long to wait after a command before reading the router again.
 *
 * The router acknowledges before it has applied the change — a radio answers
 * while it is still coming up — so an immediate poll reports the previous value
 * and looks like the command was ignored.
 */
const COMMAND_SETTLE_MS = 3000;

/** Request timeout bounds in seconds, mirroring what the admin UI allows. */
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 120;

/**
 * How many polls to skip the traffic page before asking again.
 *
 * Only applies once the router has proven it accounts nothing. At the default
 * interval this re-probes roughly every ten minutes, which is often enough to
 * notice a router that changed roles and rare enough not to reintroduce the
 * cost that made skipping worthwhile.
 */
const TRAFFIC_REPROBE_POLLS = 20;

/**
 * ioBroker adapter for FreshTomato based routers.
 */
class Freshtomato extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: 'freshtomato',
		});

		this.client = null;
		this.pollTimer = undefined;
		/** Object ids already created in this run, to avoid redundant calls. */
		this.knownObjects = new Set();
		/** Device channel ids seen at any point, so departures can be reported. */
		this.knownDevices = new Set();
		/** USB partition channel ids seen at any point, so unplugging is noticed. */
		this.knownUsb = new Set();
		/** Last label written per device channel, to avoid pointless renames. */
		this.deviceLabels = new Map();
		/** Set once the first poll succeeded, to log connection loss only once. */
		this.connected = false;
		/** Command states already migrated to writable in this run. */
		this.migratedCommands = new Set();
		/** Band id to wl unit, filled from the model so commands know the index. */
		this.radioUnits = new Map();
		/** WAN id to its one based index, for the DHCP prefix. */
		this.wanIndexes = new Map();
		/** Selected MACs for traffic states, lower case without separators. */
		this.trafficMacs = new Set();
		/** Last counter reading per MAC, for deriving rates. */
		this.trafficPrevious = new Map();
		/** Last traffic-counter sum per MAC, to detect activity for presence. */
		this.presenceCounters = new Map();
		/** Timestamp of the last confirmed presence per MAC, for the timeout. */
		this.lastPresent = new Map();
		/** Grace before a device without a live signal is marked offline, in ms. */
		this.offlineTimeoutMs = 120000;
		/** Whether the router accounts traffic at all; undefined until first poll. */
		this.trafficAvailable = undefined;
		/** Polls since the traffic page was last asked, while it stays empty. */
		this.trafficSkipped = 0;
		/** Guards the radio temperature warning so it appears once per run. */
		this.temperatureWarningLogged = false;
		/** True while a poll is in flight, so the interval cannot start a second. */
		this.polling = false;
		/** Set in onUnload; stops in-flight work from writing to a dead adapter. */
		this.unloaded = false;
		/** Firmware version, read once. null means the router did not report one. */
		this.firmware = undefined;
		// Replaced in onReady once the configured secrets are known. Until then
		// the pattern-only redactor applies, so nothing is logged unfiltered.
		this.redact = redact;

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Validates the configuration and starts polling.
	 */
	async onReady() {
		await this.setState('info.connection', false, true);

		const { host, port, username, password, httpId } = this.config;
		this.redact = createRedactor([httpId, password]);
		const missing = Object.entries({ host, username, password, httpId })
			.filter(([, v]) => !v)
			.map(([k]) => k);
		if (missing.length) {
			this.log.error(
				`Configuration incomplete, missing: ${missing.join(', ')}. Open the instance settings and fill them in.`,
			);
			// Nothing this adapter can do without credentials; stop instead of
			// hammering the router with requests that cannot succeed.
			this.terminate ? this.terminate(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG) : process.exit(0);
			return;
		}

		const pollSeconds = Math.min(
			Math.max(Number(this.config.pollInterval) || 30, MIN_POLL_SECONDS),
			MAX_POLL_SECONDS,
		);

		// Grace period: a device stays online this long after its last live
		// signal (a wireless association or a change in its traffic counters).
		// A stale ARP entry never produces such a signal, so it goes offline
		// once the grace has elapsed rather than lingering forever.
		const timeout = Number(this.config.offlineTimeout);
		this.offlineTimeoutMs = (Number.isFinite(timeout) && timeout >= 0 ? timeout : 120) * 1000;

		// How long a single request may take. Configurable because it depends on
		// the router and the link rather than on anything this adapter controls:
		// an old device on a slow network needed 19 s for one page that a newer
		// one answered in under 3, and the fixed 15 s cap turned that into a
		// failed poll. Not tied to the poll interval any more — a slow router is
		// not a reason to poll less often.
		const requestTimeout = Number(this.config.requestTimeout);
		const timeoutSeconds = Math.min(
			Math.max(Number.isFinite(requestTimeout) && requestTimeout > 0 ? requestTimeout : 15, MIN_TIMEOUT_SECONDS),
			MAX_TIMEOUT_SECONDS,
		);

		this.client = new FreshTomatoClient({
			host,
			port: Number(port) || 80,
			https: !!this.config.https,
			username,
			password,
			httpId,
			allowSelfSigned: !!this.config.allowSelfSigned,
			timeout: timeoutSeconds * 1000,
		});

		if (this.config.https && this.config.allowSelfSigned) {
			// TLS without verification still stops passive eavesdropping, but it
			// cannot tell the router apart from anything else answering on that
			// address. Worth stating rather than hiding behind a checkbox.
			this.log.warn(
				'Accepting any TLS certificate: traffic is encrypted, but the identity of the router is not verified, which leaves room for a machine-in-the-middle. Only reasonable on a network you trust.',
			);
		}

		if (!this.config.https) {
			// Basic auth over plain HTTP puts the router password on the wire in
			// base64. On a trusted LAN that is the normal FreshTomato setup, but
			// the user should know it rather than discover it.
			this.log.warn(
				'Connecting over plain HTTP: the router password is sent base64 encoded and readable by anyone who can see this traffic. Enable HTTPS in the instance settings if the router web interface supports it.',
			);
		}

		this.log.info(`Polling ${host}:${port || 80} every ${pollSeconds} s`);

		await this.createStaticObjects();
		await this.collectKnownDevices();
		await this.initTrafficSelection();

		await this.poll();
		// Only the writable states; subscribing to everything would wake the
		// adapter for each of its own several hundred writes per poll.
		this.subscribeStates('wlan.*.radioEnabled');
		this.subscribeStates('network.*.renewLease');
		this.subscribeStates('system.reboot');
		this.subscribeStates('devices.*.trafficEnabled');
		this.pollTimer = this.setInterval(() => this.poll(), pollSeconds * 1000);

		// Last, and after the first poll so the dynamic objects (interfaces,
		// radios) exist. Deliberately after polling is already scheduled: a
		// stopped InfluxDB instance must never hold up monitoring, which is why
		// the messages below carry their own timeout.
		await this.reconcileInfluxLogging();
	}

	/**
	 * Remembers device channels created by earlier runs so devices that vanish
	 * while the adapter was stopped are still marked offline.
	 */
	async collectKnownDevices() {
		try {
			const channels = await this.getChannelsOfAsync('devices');
			for (const channel of channels || []) {
				const id = channel._id.split('.').pop();
				if (id) {
					this.knownDevices.add(id);
				}
			}
		} catch (error) {
			this.log.debug(`Could not read existing device channels: ${this.redact(error.message)}`);
		}
	}

	/**
	 * Rebuilds the set of devices whose traffic is logged.
	 *
	 * The selection lives in one writable `devices.<mac>.trafficEnabled` switch
	 * per device rather than in the instance config, so it is read back from
	 * those states on start and then kept in step by onStateChange. States
	 * survive restarts, which is why a device enabled in an earlier run is
	 * already measured on the first poll of the next.
	 */
	async initTrafficSelection() {
		try {
			const states = await this.getStatesAsync('devices.*.trafficEnabled');
			for (const [id, state] of Object.entries(states || {})) {
				if (state && state.val === true) {
					// freshtomato.0.devices.<mac>.trafficEnabled -> <mac>
					const mac = id.split('.').slice(-2)[0];
					this.trafficMacs.add(mac);
				}
			}
		} catch (error) {
			this.log.debug(`Could not read the traffic selection: ${this.redact(error.message)}`);
		}
		await this.migrateLegacyTrafficDevices();
		if (this.trafficMacs.size) {
			this.log.info(`Measuring traffic for ${this.trafficMacs.size} device(s)`);
		}
	}

	/**
	 * Carries a selection made in the old table-based config over to the new
	 * per-device switches, once. Installs from before the switch never had a
	 * value here, so this is a no-op for them; it only matters for the single
	 * release that shipped the table.
	 */
	async migrateLegacyTrafficDevices() {
		const legacy = Array.isArray(this.config.trafficDevices) ? this.config.trafficDevices : [];
		let migrated = 0;
		for (const entry of legacy) {
			const mac = String(entry && entry.mac ? entry.mac : '')
				.replace(/[^0-9a-fA-F]/g, '')
				.toLowerCase();
			if (mac.length !== 12 || this.trafficMacs.has(mac)) {
				continue;
			}
			await this.ensureDeviceObjects(mac, mac);
			await this.setState(`devices.${mac}.trafficEnabled`, true, true);
			this.trafficMacs.add(mac);
			migrated++;
		}
		if (migrated) {
			this.log.info(`Migrated ${migrated} device(s) from the old traffic list to per-device switches`);
		}
	}

	/**
	 * Creates an object unless it already exists.
	 *
	 * @param {string} id - Object id relative to the instance
	 * @param {ioBroker.SettableObject} obj - The object definition
	 */
	async ensureObject(id, obj) {
		if (this.knownObjects.has(id)) {
			return;
		}
		await this.setObjectNotExistsAsync(id, obj);
		this.knownObjects.add(id);
	}

	/**
	 * Creates a folder-like container.
	 *
	 * @param {string} id - Object id
	 * @param {'device'|'channel'} type - Object type
	 * @param {string} name - Display name
	 */
	async ensureContainer(id, type, name) {
		await this.ensureObject(id, { type, common: { name }, native: {} });
	}

	/**
	 * Creates a read-only state.
	 *
	 * @param {string} id - Object id
	 * @param {string} name - Display name
	 * @param {ioBroker.CommonType} type - Value type
	 * @param {string} role - State role
	 * @param {string} [unit] - Unit
	 */
	async ensureState(id, name, type, role, unit) {
		await this.ensureObject(id, {
			type: 'state',
			common: { name, type, role, read: true, write: false, ...(unit ? { unit } : {}) },
			native: {},
		});
	}

	/**
	 * Creates a state the user can write to in order to trigger an action.
	 *
	 * extendObject rather than setObjectNotExists: an installation upgraded from
	 * a read-only release already has these objects with write disabled, and
	 * setObjectNotExists would leave them that way — the control would be
	 * present but silently inert. Only the three keys that decide writability
	 * are touched, so a name the user changed survives.
	 *
	 * @param {string} id - Object id
	 * @param {string} name - Display name
	 * @param {ioBroker.CommonType} type - Value type
	 * @param {string} role - State role
	 * @param {boolean} [readable] - Whether the state also reports a value
	 * @param {boolean} [writable] - Whether writing is permitted at all
	 */
	async ensureCommandState(id, name, type, role, readable = true, writable = true) {
		await this.ensureObject(id, {
			type: 'state',
			common: { name, type, role, read: readable, write: writable },
			native: {},
		});
		// Re-applied on every start, so toggling the reboot option in the
		// instance settings takes effect without deleting the object by hand.
		if (!this.migratedCommands.has(id)) {
			this.migratedCommands.add(id);
			await this.extendObjectAsync(id, { common: { write: writable, read: readable, role } });
		}
	}

	/**
	 * Creates the objects that do not depend on what the router reports.
	 */
	async createStaticObjects() {
		await this.ensureState('info.firmware', 'Firmware version', 'string', 'text');
		await this.ensureState('info.model', 'Router model', 'string', 'text');
		await this.ensureState('info.routerName', 'Router name', 'string', 'text');
		await this.ensureState('info.uptime', 'Uptime', 'number', 'value', 's');
		await this.ensureState('info.uptimeText', 'Uptime, formatted', 'string', 'text');
		await this.ensureState('info.lastUpdate', 'Last successful poll', 'number', 'value.time');

		await this.ensureContainer('system', 'channel', 'System');
		const system = [
			['cpuTemperature', 'CPU temperature', 'number', 'value.temperature', '°C'],
			['load1', 'Load average, 1 minute', 'number', 'value'],
			['load5', 'Load average, 5 minutes', 'number', 'value'],
			['load15', 'Load average, 15 minutes', 'number', 'value'],
			['processes', 'Running processes', 'number', 'value'],
			['memTotal', 'Memory total', 'number', 'value', 'B'],
			['memFree', 'Memory free', 'number', 'value', 'B'],
			['memBuffers', 'Memory in buffers', 'number', 'value', 'B'],
			['memCached', 'Memory cached', 'number', 'value', 'B'],
			['memAvailable', 'Memory available', 'number', 'value', 'B'],
			['swapTotal', 'Swap total', 'number', 'value', 'B'],
			['swapFree', 'Swap free', 'number', 'value', 'B'],
			['nvramTotal', 'NVRAM total', 'number', 'value', 'B'],
			['nvramFree', 'NVRAM free', 'number', 'value', 'B'],
			['flashSize', 'Flash size', 'number', 'value', 'MB'],
			['cpuType', 'CPU type', 'string', 'text'],
			['cpuClock', 'CPU clock', 'string', 'text'],
			['cfeVersion', 'CFE bootloader version', 'string', 'text'],
		];
		for (const [id, name, type, role, unit] of system) {
			await this.ensureState(`system.${id}`, name, type, role, unit);
		}

		await this.ensureContainer('network', 'device', 'Network');
		await this.ensureContainer('network.lan', 'channel', 'LAN');
		const lan = [
			['ip', 'LAN IP address', 'info.ip'],
			['netmask', 'LAN netmask', 'text'],
			['mac', 'LAN MAC address', 'info.mac'],
			['gateway', 'LAN gateway', 'info.ip'],
			['interface', 'LAN bridge interface', 'text'],
			['dhcpStart', 'DHCP range start', 'info.ip'],
			['dhcpEnd', 'DHCP range end', 'info.ip'],
		];
		for (const [id, name, role] of lan) {
			await this.ensureState(`network.lan.${id}`, name, 'string', role);
		}

		// Always created so it is discoverable, but only writable when the owner
		// has switched the option on. Two layers: the object refuses the write,
		// and onStateChange checks the option again before acting.
		await this.ensureCommandState(
			'system.reboot',
			'Reboot the router',
			'boolean',
			'button',
			false,
			!!this.config.allowReboot,
		);

		await this.ensureContainer('devices', 'device', 'Connected devices');
		await this.ensureState('devices.count', 'Connected devices', 'number', 'value');
		await this.ensureState('devices.wirelessCount', 'Wireless clients', 'number', 'value');
		await this.ensureState('devices.json', 'Connected devices as JSON', 'string', 'json');

		// Records which datapoints this adapter switched on for InfluxDB, so the
		// reconcile only ever disables its own, never a datapoint the user
		// enabled by hand in the object browser.
		await this.ensureState('info.influxManaged', 'Datapoints logged to InfluxDB', 'string', 'json');
	}

	/**
	 * Creates the objects for one WAN interface.
	 *
	 * @param {string} id - WAN id, e.g. `wan` or `wan2`
	 */
	async ensureWanObjects(id) {
		await this.ensureContainer(`network.${id}`, 'channel', id.toUpperCase());
		const fields = [
			['ip', 'WAN IP address', 'string', 'info.ip', undefined],
			['netmask', 'WAN netmask', 'string', 'text', undefined],
			['gateway', 'WAN gateway', 'string', 'info.ip', undefined],
			['dns', 'WAN DNS servers', 'string', 'text', undefined],
			['domain', 'WAN domain', 'string', 'text', undefined],
			['hostname', 'WAN host name', 'string', 'text', undefined],
			['proto', 'WAN protocol', 'string', 'text', undefined],
			['mac', 'WAN MAC address', 'string', 'info.mac', undefined],
			['mtu', 'WAN MTU', 'number', 'value', 'B'],
			['connected', 'WAN connected', 'boolean', 'indicator.reachable', undefined],
			['uptime', 'WAN connection uptime', 'string', 'text', undefined],
			['leaseRemaining', 'WAN DHCP lease remaining', 'string', 'text', undefined],
		];
		for (const [field, name, type, role, unit] of fields) {
			await this.ensureState(`network.${id}.${field}`, name, type, role, unit);
		}
		// Write-only: a button has no state worth reading back.
		await this.ensureCommandState(`network.${id}.renewLease`, 'Renew DHCP lease', 'boolean', 'button', false);
	}

	/**
	 * Creates the objects for one wireless radio.
	 *
	 * @param {string} id - Band id, e.g. `2G`
	 */
	async ensureRadioObjects(id) {
		await this.ensureContainer('wlan', 'device', 'Wireless');
		await this.ensureContainer(`wlan.${id}`, 'channel', `Radio ${id}`);
		const fields = [
			['ssid', 'SSID', 'string', 'text', undefined],
			['channel', 'Channel', 'number', 'value', undefined],
			['frequency', 'Centre frequency', 'number', 'value', 'MHz'],
			['bandwidth', 'Channel width', 'number', 'value', 'MHz'],
			['maxRate', 'Maximum rate', 'number', 'value', 'Mbit/s'],
			['noise', 'Noise floor', 'number', 'value', 'dBm'],
			['interference', 'Interference level', 'number', 'value', undefined],
			['temperature', 'Radio temperature', 'number', 'value.temperature', '°C'],
			['hidden', 'SSID hidden', 'boolean', 'indicator', undefined],
			['security', 'Security mode', 'string', 'text', undefined],
			['crypto', 'Encryption', 'string', 'text', undefined],
			['netMode', 'Network mode', 'string', 'text', undefined],
			['mode', 'Operating mode', 'string', 'text', undefined],
			['mac', 'Radio MAC address', 'string', 'info.mac', undefined],
			['interface', 'Radio interface', 'string', 'text', undefined],
			['clients', 'Connected clients', 'number', 'value', undefined],
		];
		for (const [field, name, type, role, unit] of fields) {
			await this.ensureState(`wlan.${id}.${field}`, name, type, role, unit);
		}
		// Writable: switching it off disconnects every client on this band.
		await this.ensureCommandState(`wlan.${id}.radioEnabled`, 'Radio enabled', 'boolean', 'switch');
	}

	/**
	 * Creates the objects for one network interface counter.
	 *
	 * @param {string} id - Safe id segment
	 * @param {string} name - Interface name as reported by the router
	 */
	async ensureInterfaceObjects(id, name) {
		await this.ensureContainer('interfaces', 'device', 'Interface counters');
		await this.ensureContainer(`interfaces.${id}`, 'channel', name);
		await this.ensureState(`interfaces.${id}.rxBytes`, 'Received', 'number', 'value', 'B');
		await this.ensureState(`interfaces.${id}.txBytes`, 'Sent', 'number', 'value', 'B');
	}

	/**
	 * Creates the objects for one switch port.
	 *
	 * @param {string} id - Safe id segment
	 * @param {string} name - Port name as reported by the router
	 */
	async ensurePortObjects(id, name) {
		await this.ensureContainer('ports', 'device', 'Switch ports');
		await this.ensureContainer(`ports.${id}`, 'channel', name);
		await this.ensureState(`ports.${id}.up`, 'Link up', 'boolean', 'indicator.reachable');
		await this.ensureState(`ports.${id}.speed`, 'Link speed', 'number', 'value', 'Mbit/s');
		await this.ensureState(`ports.${id}.duplex`, 'Duplex mode', 'string', 'text');
		await this.ensureState(`ports.${id}.state`, 'Raw link state', 'string', 'text');
	}

	/**
	 * Creates the objects for one mounted USB partition.
	 *
	 * @param {string} id - Disk name plus partition number, e.g. `sda1`
	 */
	async ensureUsbObjects(id) {
		await this.ensureContainer('usb', 'device', 'USB storage');
		await this.ensureContainer(`usb.${id}`, 'channel', id);
		const fields = [
			['vendor', 'Vendor', 'string', 'text', undefined],
			['product', 'Product', 'string', 'text', undefined],
			['disk', 'Disk device', 'string', 'text', undefined],
			['partition', 'Partition number', 'number', 'value', undefined],
			['label', 'Volume label', 'string', 'text', undefined],
			['mountpoint', 'Mount point', 'string', 'text', undefined],
			['filesystem', 'File system', 'string', 'text', undefined],
			['totalBytes', 'Total size', 'number', 'value', 'B'],
			['freeBytes', 'Free space', 'number', 'value', 'B'],
			['usedBytes', 'Used space', 'number', 'value', 'B'],
			['usedPercent', 'Used space', 'number', 'value', '%'],
			['attached', 'Currently plugged in', 'boolean', 'indicator.reachable', undefined],
		];
		for (const [field, name, type, role, unit] of fields) {
			await this.ensureState(`usb.${id}.${field}`, name, type, role, unit);
		}
	}

	/**
	 * Creates the objects for one connected device.
	 *
	 * @param {string} id - MAC based channel id
	 * @param {string} label - Display name
	 */
	async ensureDeviceObjects(id, label) {
		await this.ensureContainer(`devices.${id}`, 'channel', label);
		// A device often shows up as '<unknown>' first and only gets a name once
		// its DHCP lease is seen. ensureContainer would keep the MAC as the label
		// forever, so the rename is applied separately.
		if (this.deviceLabels.get(id) !== label) {
			this.deviceLabels.set(id, label);
			await this.extendObjectAsync(`devices.${id}`, { common: { name: label } });
		}
		const fields = [
			['mac', 'MAC address', 'string', 'info.mac', undefined],
			['ip', 'IP address', 'string', 'info.ip', undefined],
			['hostname', 'Host name', 'string', 'text', undefined],
			['interface', 'Interface', 'string', 'text', undefined],
			['online', 'Currently connected', 'boolean', 'indicator.reachable', undefined],
			['wireless', 'Connected over Wi-Fi', 'boolean', 'indicator', undefined],
			['band', 'Wi-Fi band', 'string', 'text', undefined],
			['rssi', 'Signal strength', 'number', 'value.rssi', 'dBm'],
			['txRate', 'Transmit rate', 'number', 'value', 'Mbit/s'],
			['rxRate', 'Receive rate', 'number', 'value', 'Mbit/s'],
			['connectedTime', 'Connected for', 'number', 'value', 's'],
			['leaseExpires', 'DHCP lease expires in', 'string', 'text', undefined],
			['lastSeen', 'Last seen', 'number', 'value.time', undefined],
			['presenceSource', 'Why the device counts as present', 'string', 'text', undefined],
		];
		for (const [field, name, type, role, unit] of fields) {
			await this.ensureState(`devices.${id}.${field}`, name, type, role, unit);
		}
		// The one writable state per device. It selects whether traffic is
		// logged and is the only place that selection lives now. Created with
		// setObjectNotExists via ensureObject, so a value the user set in an
		// earlier run is never reset; `def` only decides the initial display.
		await this.ensureObject(`devices.${id}.trafficEnabled`, {
			type: 'state',
			common: {
				name: 'Log traffic for this device',
				type: 'boolean',
				role: 'switch.enable',
				read: true,
				write: true,
				def: false,
			},
			native: {},
		});
		this.knownDevices.add(id);
	}

	/**
	 * Writes a value, but only when it differs from what is already stored.
	 *
	 * @param {string} id - State id
	 * @param {unknown} value - Value to report
	 */
	async write(id, value) {
		if (this.unloaded) {
			return;
		}
		await this.setStateChangedAsync(id, { val: value === undefined ? null : value, ack: true });
	}

	/**
	 * Fetches everything from the router and publishes it.
	 */
	async poll() {
		if (!this.client || this.unloaded) {
			return;
		}
		// publish() writes several hundred states sequentially, and the first run
		// also creates the objects. With a short interval that can outlast the
		// timer, so a second poll must not start on top of the first.
		if (this.polling) {
			this.log.debug('Previous poll is still running, skipping this interval');
			return;
		}
		this.polling = true;
		try {
			// iptraffic feeds the optional per-device counters, and a change in
			// those counters is what tells presence detection a device is alive.
			// It is also by far the most expensive call: measured against a
			// WNR3500L in access point mode it took 7 to 19 seconds while the
			// other three stayed under 300 ms — and returned an empty list every
			// time, because a bridging router accounts nothing. Asking a router
			// that has proven it has nothing to say is what pushed polls past
			// their timeout, so once that is established the call is skipped and
			// only re-probed now and then in case the router changed roles.
			const wantTraffic = this.trafficMacs.size > 0 || this.shouldProbeTraffic();
			const [statusData, deviceList, netDev, usbDevices] = await Promise.all([
				this.client.getStatusData(),
				this.client.getDeviceList(),
				this.client.getNetDev(),
				this.client.getUsbDevices(),
			]);
			// Fetched separately, and its own failure is not fatal to the poll:
			// this is the call that timed out repeatedly on a slow router, and
			// bundling it into the Promise.all above would fail the whole poll
			// over it. trafficFetched tells publish() whether an empty result
			// here is confirmed (the router answered and had nothing) or just a
			// failed attempt — treating a timeout as confirmed-empty would teach
			// the adapter the router "accounts nothing" from a single hiccup.
			let ipTraffic = { iptraffic: [], failed: {} };
			let trafficFetched = false;
			if (wantTraffic) {
				try {
					ipTraffic = await this.client.getIpTraffic();
					trafficFetched = true;
				} catch (error) {
					this.log.warn(`Could not read per-address traffic: ${this.redact(error.message)}`);
				}
			}

			// The firmware version needs a separate page and never changes while
			// the router runs, so it is read once and then reused. It is not
			// worth failing the whole poll over: about.asp is cosmetic, while
			// the three calls above carry everything that is actually monitored.
			if (this.firmware === undefined) {
				try {
					this.firmware = await this.client.getFirmwareVersion();
				} catch (error) {
					this.log.warn(`Could not read the firmware version: ${this.redact(error.message)}`);
				}
			}

			for (const [name, message] of Object.entries({
				...statusData.failed,
				...deviceList.failed,
				...netDev.failed,
				...usbDevices.failed,
				...ipTraffic.failed,
			})) {
				this.log.warn(`Could not parse '${name}' from the router response: ${this.redact(message)}`);
			}

			const model = buildModel({
				...statusData,
				...deviceList,
				netdev: netDev.netdev,
				usbdev: usbDevices.usbdev,
				firmware: this.firmware,
			});

			this.warnAboutMissingTemperatures(statusData.sysinfo, model.radios);

			// Built once and shared: publish() uses it to judge presence, and
			// publishTraffic() uses it to write counters for selected devices.
			const trafficByIp = buildTraffic(ipTraffic.iptraffic);
			await this.publish(model, trafficByIp, trafficFetched);
			await this.publishTraffic(model.devices, trafficByIp);

			if (!this.connected) {
				this.connected = true;
				this.log.info(
					`Connected to ${model.info.model ?? 'router'} running FreshTomato ${model.info.firmware ?? '?'}`,
				);
			}
			await this.write('info.connection', true);
		} catch (error) {
			if (this.connected || !(error instanceof FreshTomatoError)) {
				this.log.error(`Poll failed: ${this.redact(error.message)}`);
			} else {
				// First contact failing is usually a configuration problem; the
				// client already put the actionable part into the message.
				this.log.error(`Cannot talk to the router: ${this.redact(error.message)}`);
			}
			this.connected = false;
			await this.write('info.connection', false);
		} finally {
			this.polling = false;
		}
	}

	/**
	 * Runs a command a user wrote to one of the writable states.
	 *
	 * ioBroker signals intent through the ack flag: a value written by a user
	 * arrives unacknowledged, while everything this adapter reports carries
	 * ack. Reacting only to the former keeps the poll from triggering itself.
	 *
	 * @param {string} id - Full state id
	 * @param {ioBroker.State | null | undefined} state - The new state
	 */
	async onStateChange(id, state) {
		if (!state || state.ack || this.unloaded || !this.client) {
			return;
		}
		const path = id.slice(`${this.namespace}.`.length);

		try {
			const radio = path.match(/^wlan\.(.+)\.radioEnabled$/);
			if (radio) {
				const unit = this.radioUnits.get(radio[1]);
				if (unit === undefined) {
					this.log.warn(`Cannot switch ${radio[1]}: the router has not reported that radio yet`);
					return;
				}
				const on = state.val === true || state.val === 'true' || state.val === 1;
				this.log.info(`Switching radio ${radio[1]} ${on ? 'on' : 'off'}`);
				await this.client.setWirelessRadio(unit, on);
				// The value is confirmed by the next poll rather than here: what
				// the router actually did is more trustworthy than what was asked.
				await this.pollAfterCommand();
				return;
			}

			const wan = path.match(/^network\.(wan\d*)\.renewLease$/);
			if (wan) {
				const index = this.wanIndexes.get(wan[1]) ?? 1;
				this.log.info(`Renewing the DHCP lease of ${wan[1]}`);
				await this.client.renewDhcpLease(index);
				await this.pollAfterCommand();
				return;
			}

			if (path === 'system.reboot') {
				await this.handleRebootRequest(state.val);
				return;
			}

			const traffic = path.match(/^devices\.([0-9a-f]{12})\.trafficEnabled$/);
			if (traffic) {
				await this.setTrafficEnabled(traffic[1], state.val === true || state.val === 'true' || state.val === 1);
				return;
			}

			this.log.debug(`Ignoring write to ${path}, no command is bound to it`);
		} catch (error) {
			this.log.error(`Command for ${path} failed: ${this.redact(error.message)}`);
		}
	}

	/**
	 * Reboots the router, if the owner has allowed it.
	 *
	 * This is the only command in the adapter that takes the household off the
	 * internet, so it is guarded twice. The object is not writable unless the
	 * option is set, and this check runs again in case the object was made
	 * writable by other means — an imported configuration, a manual edit in the
	 * object browser, an older release.
	 *
	 * Requiring the value to be exactly true rules out a stray truthy write.
	 *
	 * @param {unknown} value - What was written to the state
	 */
	async handleRebootRequest(value) {
		if (!this.config.allowReboot) {
			this.log.warn(
				'Reboot requested but not permitted. Tick "Allow rebooting the router" in the instance settings if this is intended.',
			);
			return;
		}
		if (value !== true) {
			this.log.debug(`Ignoring reboot request with value ${JSON.stringify(value)}; only true triggers it`);
			return;
		}

		this.log.warn('Rebooting the router now. Every device in this network loses its connection.');
		try {
			await this.client.reboot();
		} catch (error) {
			// The router may well drop the connection while rebooting, so a
			// failure here does not mean the command was refused.
			this.log.info(
				`The router stopped answering while rebooting, which is expected: ${this.redact(error.message)}`,
			);
			// The message alone loses the cause chain, and that is what
			// distinguishes a reboot in progress from a rejected request.
			this.log.debug(`Reboot request error detail: ${this.redact(error.stack ?? String(error))}`);
		}
		// No poll afterwards: the router is down for a minute or more, and the
		// regular interval picks it up once it answers again.
		this.connected = false;
		await this.write('info.connection', false);
	}

	/**
	 * Re-reads the router shortly after a command.
	 *
	 * See COMMAND_SETTLE_MS for why this waits instead of polling at once.
	 */
	async pollAfterCommand() {
		await new Promise(resolve => this.setTimeout(resolve, COMMAND_SETTLE_MS));
		if (!this.unloaded) {
			await this.poll();
		}
	}

	/**
	 * Turns traffic logging for one device on or off.
	 *
	 * This is a stored setting rather than a router command: the written value
	 * is the truth, so it is acknowledged straight away instead of waiting for
	 * a poll to confirm it. Enabling triggers a poll so counters appear without
	 * waiting for the next interval; the poll itself only fetches iptraffic
	 * because the set is no longer empty.
	 *
	 * @param {string} mac - MAC based channel id, lower case without separators
	 * @param {boolean} enabled - Whether traffic should be logged
	 */
	async setTrafficEnabled(mac, enabled) {
		if (enabled) {
			this.trafficMacs.add(mac);
		} else {
			this.trafficMacs.delete(mac);
			// Drop the baseline so a later re-enable does not compute a rate
			// across the gap, which would be a huge, meaningless spike.
			this.trafficPrevious.delete(mac);
		}
		await this.setState(`devices.${mac}.trafficEnabled`, enabled, true);
		this.log.info(`Traffic logging for ${mac} ${enabled ? 'enabled' : 'disabled'}`);
		if (enabled && !this.polling) {
			await this.poll();
		}
	}

	/**
	 * Warns when radio temperatures could not be read out of `wlsense`.
	 *
	 * That value is a pre-rendered UI string, not a data field, so a firmware
	 * that changes its wording breaks the extraction. Without this check the
	 * temperatures would simply turn null and the cause would be invisible.
	 * Logged once per adapter run, not once per poll.
	 *
	 * @param {Record<string, unknown>} sysinfo - Parsed `sysinfo`
	 * @param {Array<Record<string, unknown>>} radios - Radios from the model
	 */
	warnAboutMissingTemperatures(sysinfo, radios) {
		if (this.temperatureWarningLogged || !radios.length) {
			return;
		}
		const wlsense = sysinfo && sysinfo.wlsense;
		const hasSource = typeof wlsense === 'string' && wlsense.trim() !== '';
		if (hasSource && radios.every(radio => radio.temperature === null)) {
			this.temperatureWarningLogged = true;
			this.log.warn(
				'The router reports a wlsense value but no radio temperatures could be read from it. The firmware has probably changed its format; wlan.*.temperature will stay empty.',
			);
		}
	}

	/**
	 * Creates any missing objects for the current model and writes all values.
	 *
	 * @param {Record<string, unknown>} model - Result of buildModel
	 * @param {Map<string, {bytesIn: number, bytesOut: number}>} trafficByIp - Counters by IP, for presence
	 * @param {boolean} trafficFetched - Whether the traffic page was fetched and answered this poll
	 */
	async publish(model, trafficByIp, trafficFetched) {
		for (const [id, value] of Object.entries(model.info)) {
			await this.write(`info.${id}`, value);
		}
		await this.write('info.lastUpdate', Date.now());

		for (const [id, value] of Object.entries(model.system)) {
			// uptime and uptimeText are already published under info.
			if (id !== 'uptime' && id !== 'uptimeText') {
				await this.write(`system.${id}`, value);
			}
		}

		for (const wan of model.wans) {
			this.wanIndexes.set(wan.id, wan.index);
			await this.ensureWanObjects(wan.id);
			for (const field of [
				'ip',
				'netmask',
				'gateway',
				'dns',
				'domain',
				'hostname',
				'proto',
				'mac',
				'mtu',
				'connected',
				'uptime',
				'leaseRemaining',
			]) {
				await this.write(`network.${wan.id}.${field}`, wan[field]);
			}
		}

		for (const [id, value] of Object.entries(model.lan)) {
			await this.write(`network.lan.${id}`, value);
		}

		for (const radio of model.radios) {
			this.radioUnits.set(radio.id, radio.unit);
			await this.ensureRadioObjects(radio.id);
			for (const [field, value] of Object.entries(radio)) {
				if (field !== 'id' && field !== 'unit') {
					await this.write(`wlan.${radio.id}.${field}`, value);
				}
			}
		}

		for (const iface of model.interfaces) {
			await this.ensureInterfaceObjects(iface.id, iface.name);
			await this.write(`interfaces.${iface.id}.rxBytes`, iface.rxBytes);
			await this.write(`interfaces.${iface.id}.txBytes`, iface.txBytes);
		}

		for (const port of model.ports) {
			await this.ensurePortObjects(port.id, port.name);
			await this.write(`ports.${port.id}.up`, port.up);
			await this.write(`ports.${port.id}.speed`, port.speed);
			await this.write(`ports.${port.id}.duplex`, port.duplex);
			await this.write(`ports.${port.id}.state`, port.state);
		}

		const presentUsb = new Set();
		for (const partition of model.usb) {
			presentUsb.add(partition.id);
			this.knownUsb.add(partition.id);
			await this.ensureUsbObjects(partition.id);
			for (const [field, value] of Object.entries(partition)) {
				if (field !== 'id') {
					await this.write(`usb.${partition.id}.${field}`, value);
				}
			}
		}
		// Unplugged since the last poll: leave the size and mountpoint at their
		// last known value, which is what they still were the moment it left,
		// and only flip the flag that says it is not there any more.
		for (const id of this.knownUsb) {
			if (!presentUsb.has(id)) {
				await this.write(`usb.${id}.attached`, false);
			}
		}

		await this.write('devices.count', model.deviceCount);
		await this.write('devices.wirelessCount', model.wirelessDeviceCount);
		await this.write('devices.json', JSON.stringify(model.devices));

		const present = new Set(model.devices.map(device => device.id));
		const now = Date.now();

		// Whether this router accounts traffic per address at all. A router that
		// does keeps cumulative counters, so the list is populated even when
		// nothing is moving; an empty list means the feature is not there. That
		// is the normal state of a box in access point mode, which bridges rather
		// than routes and therefore has nothing to account.
		//
		// Only updated when the traffic page was actually fetched this poll and
		// answered: a failed request must not be read as "no counters", or a
		// router that merely timed out once would be mistaken for one that
		// genuinely has nothing to say, and presence would fall back to arp for
		// no reason. Until it is known, treat it as available — the strict rules
		// apply and a device without a signal just does not count as present yet.
		if (trafficFetched) {
			const observedAvailable = trafficByIp.size > 0;
			if (this.trafficAvailable !== observedAvailable) {
				this.trafficAvailable = observedAvailable;
				if (!observedAvailable) {
					this.log.info(
						'This router reports no per-address traffic counters, which is usual in access point mode. Presence for wired devices therefore falls back to the router tables; those devices report presenceSource "arp". Per-device traffic states cannot be filled on this router.',
					);
				}
			}
		}
		const trafficAvailable = this.trafficAvailable !== false;

		// Per device channels are optional, but the offline marking below is not:
		// switching the option off after a run would otherwise leave every
		// existing channel stuck at online = true forever.
		for (const device of this.config.createDeviceObjects === false ? [] : model.devices) {
			await this.ensureDeviceObjects(device.id, device.hostname ?? device.mac);
			for (const field of [
				'mac',
				'ip',
				'hostname',
				'interface',
				'wireless',
				'band',
				'rssi',
				'txRate',
				'rxRate',
				'connectedTime',
				'leaseExpires',
			]) {
				await this.write(`devices.${device.id}.${field}`, device[field]);
			}

			// Presence is judged from live signals, not from mere ARP presence:
			// an association in wldev, or traffic counters that grew since the
			// last poll. A stale ARP entry has neither, so it is not confirmed
			// present and drops offline once the grace has passed.
			const viaWireless = device.wireless === true;
			const viaTraffic = this.sawTraffic(device.id, device.ip, trafficByIp);
			// Without traffic accounting a wired device can produce no live
			// signal at all, so demanding one would report every one of them as
			// offline. Presence in the router's tables is the only evidence left,
			// and weak evidence beats reporting a device that is plainly there as
			// gone. presenceSource says which of the two applied.
			const viaArp = !trafficAvailable && !viaWireless;
			if (viaWireless || viaTraffic || viaArp) {
				this.lastPresent.set(device.id, now);
				// lastSeen tracks the last real sign of life, so it is only
				// stamped on a confirmed presence, never on every poll.
				await this.write(`devices.${device.id}.lastSeen`, now);
			}
			const last = this.lastPresent.get(device.id);
			const online = last !== undefined && now - last <= this.offlineTimeoutMs;
			// Strongest evidence first, so the value names what actually proved
			// the device is there rather than the weakest thing that also held.
			let source = 'offline';
			if (viaWireless) {
				source = 'wireless';
			} else if (viaTraffic) {
				source = 'traffic';
			} else if (viaArp) {
				source = 'arp';
			} else if (online) {
				source = 'grace';
			}
			await this.write(`devices.${device.id}.online`, online);
			await this.write(`devices.${device.id}.presenceSource`, source);
		}

		// Devices that dropped out of the router tables entirely. Their objects
		// stay so history is preserved. They keep their last online state until
		// the grace elapses, then go offline; lastSeen is left pointing at the
		// moment they were last confirmed present.
		for (const id of this.knownDevices) {
			if (present.has(id)) {
				continue;
			}
			// presenceSource is new in this version, so a channel created by an
			// older release does not have it yet. Ensure it before writing, or
			// the value would land on a state with no object. ensureState does
			// not touch the channel label, so the device keeps its name.
			await this.ensureState(
				`devices.${id}.presenceSource`,
				'Why the device counts as present',
				'string',
				'text',
			);
			const last = this.lastPresent.get(id);
			const online = last !== undefined && now - last <= this.offlineTimeoutMs;
			await this.write(`devices.${id}.online`, online);
			await this.write(`devices.${id}.presenceSource`, online ? 'grace' : 'offline');
		}
	}

	/**
	 * Decides whether this poll should ask for the traffic page.
	 *
	 * Always yes until the router has answered once, so its capability is
	 * established rather than assumed. After it has come back empty the call is
	 * skipped, because on a bridging router it is both useless and the slowest
	 * request by a wide margin. It is re-probed every so often anyway: a router
	 * can be reconfigured, and the cost of finding out late is a poll that is
	 * briefly slow, while the cost of never asking again would be a feature that
	 * silently stays broken.
	 *
	 * @returns {boolean} True when the traffic page should be requested
	 */
	shouldProbeTraffic() {
		if (this.trafficAvailable !== false) {
			return true;
		}
		if (this.trafficSkipped >= TRAFFIC_REPROBE_POLLS) {
			this.trafficSkipped = 0;
			return true;
		}
		this.trafficSkipped++;
		return false;
	}

	/**
	 * Reports whether a device's traffic counters grew since the previous poll.
	 *
	 * A growing counter is proof the device is communicating, which is the one
	 * activity signal available for wired devices. The first reading only sets
	 * the baseline; a counter that fell (a router restart) is not activity.
	 *
	 * @param {string} id - MAC based channel id
	 * @param {string|null} ip - Current IP, used to find the counters
	 * @param {Map<string, {bytesIn: number, bytesOut: number}>} trafficByIp - Counters by IP
	 * @returns {boolean} True when the counters increased
	 */
	sawTraffic(id, ip, trafficByIp) {
		if (!ip) {
			return false;
		}
		const counters = trafficByIp.get(ip);
		if (!counters) {
			return false;
		}
		const sum = counters.bytesIn + counters.bytesOut;
		const previous = this.presenceCounters.get(id);
		this.presenceCounters.set(id, sum);
		return previous !== undefined && sum > previous;
	}

	/**
	 * Publishes traffic counters for the devices the user selected.
	 *
	 * The router reports traffic per IP address while device channels are keyed
	 * by MAC, so the two are joined through the ARP table the model already
	 * carries. A device without a current IP is skipped rather than guessed at:
	 * an IP handed to somebody else by DHCP would otherwise attribute a
	 * stranger's traffic to it.
	 *
	 * @param {Array<Record<string, unknown>>} devices - Devices from the model
	 * @param {Map<string, {bytesIn: number, bytesOut: number}>} byIp - Counters by IP
	 */
	async publishTraffic(devices, byIp) {
		if (!this.trafficMacs.size) {
			return;
		}
		const now = Date.now();

		for (const device of devices) {
			if (!this.trafficMacs.has(device.id)) {
				continue;
			}
			const counters = device.ip ? byIp.get(device.ip) : undefined;
			if (!counters) {
				this.log.debug(
					`No traffic counters for ${device.mac}; the router lists none for ${device.ip ?? 'its address'}`,
				);
				continue;
			}

			await this.ensureTrafficObjects(device.id);
			await this.write(`devices.${device.id}.bytesIn`, counters.bytesIn);
			await this.write(`devices.${device.id}.bytesOut`, counters.bytesOut);

			const previous = this.trafficPrevious.get(device.id);
			this.trafficPrevious.set(device.id, { ...counters, at: now });
			if (!previous) {
				continue;
			}
			const seconds = (now - previous.at) / 1000;
			const rateIn = rateFrom(previous.bytesIn, counters.bytesIn, seconds);
			const rateOut = rateFrom(previous.bytesOut, counters.bytesOut, seconds);
			if (rateIn === null || rateOut === null) {
				// A counter below its predecessor means the router restarted.
				// Reporting the previous rate would be a lie, and reporting the
				// difference would be a very large one.
				this.log.debug(`Traffic counters for ${device.mac} restarted; no rate for this interval`);
				continue;
			}
			await this.write(`devices.${device.id}.rateIn`, rateIn);
			await this.write(`devices.${device.id}.rateOut`, rateOut);
		}
	}

	/**
	 * Creates the traffic states for one device.
	 *
	 * @param {string} id - MAC based channel id
	 */
	async ensureTrafficObjects(id) {
		const fields = [
			['bytesIn', 'Bytes received', 'B'],
			['bytesOut', 'Bytes sent', 'B'],
			['rateIn', 'Receive rate', 'B/s'],
			['rateOut', 'Send rate', 'B/s'],
		];
		for (const [field, name, unit] of fields) {
			await this.ensureState(`devices.${id}.${field}`, name, 'number', 'value', unit);
		}
	}

	/**
	 * Answers admin UI requests. Only the InfluxDB instance picker uses this so
	 * far: the select control asks for the list of installed InfluxDB instances.
	 *
	 * @param {ioBroker.Message} obj - The message
	 */
	async onMessage(obj) {
		if (!obj || typeof obj !== 'object') {
			return;
		}
		// A message without a command cannot be served, but it may still carry a
		// callback. Answering here as well, rather than only below, is the point
		// of the guard: an unanswered callback leaves the caller waiting forever.
		if (!obj.command) {
			if (obj.callback) {
				this.sendTo(obj.from, '', { error: 'Message carried no command' }, obj.callback);
			}
			return;
		}
		if (obj.command === 'getInfluxInstances') {
			const options = await this.listInfluxInstances();
			if (obj.callback) {
				this.sendTo(obj.from, obj.command, options, obj.callback);
			}
			return;
		}
		// Always answer a sender that asked for a reply, even for a command this
		// adapter does not know: leaving the callback unanswered would make the
		// caller wait for a message that never arrives.
		if (obj.callback) {
			this.sendTo(obj.from, obj.command, { error: `Unknown command '${obj.command}'` }, obj.callback);
		}
	}

	/**
	 * Lists the installed InfluxDB instances for the settings dropdown, with a
	 * leading "disabled" entry so logging can be turned off again.
	 *
	 * @returns {Promise<Array<{value: string, label: string}>>} Select options
	 */
	async listInfluxInstances() {
		const options = [{ value: '', label: 'disabled' }];
		try {
			// The range ends just past the last possible instance id: U+FFFF sorts
			// above every character an id can contain, so the view returns every
			// influxdb.<n> and nothing beyond it. Written as an escape rather than
			// the character itself, which is a Unicode noncharacter and does not
			// survive every editor or encoding intact.
			const view = await this.getObjectViewAsync('system', 'instance', {
				startkey: 'system.adapter.influxdb.',
				endkey: 'system.adapter.influxdb.\uffff',
			});
			for (const row of (view && view.rows) || []) {
				const id = row.id.replace('system.adapter.', '');
				options.push({ value: id, label: id });
			}
		} catch (error) {
			this.log.debug(`Could not list InfluxDB instances: ${this.redact(error.message)}`);
		}
		return options;
	}

	/**
	 * Enables or disables InfluxDB logging for the selected KPI groups.
	 *
	 * The logging itself is done by the InfluxDB adapter, with its own
	 * credentials and connection: this only tells it which datapoints to record,
	 * through its documented enableHistory/disableHistory messages. The prefix
	 * becomes each point's aliasId, so it is stored under <prefix>.system.load1.
	 *
	 * Only datapoints this adapter enabled are ever disabled again — the managed
	 * list in info.influxManaged makes sure a datapoint the user switched on by
	 * hand is left alone.
	 */
	async reconcileInfluxLogging() {
		const configured = String(this.config.influxInstance || '').trim();
		const previous = await this.readManagedInflux();
		// Where the logging was switched on. Setting the selection to "disabled"
		// leaves nothing to send a request to, but the datapoints are still being
		// logged over there, so the instance that owns them is remembered and
		// used to retract them. The same applies when the selection moves to a
		// different instance: the old one has to be cleaned up first.
		const instance = configured || previous.instance;

		if (!instance) {
			// Nothing configured and nothing ever enabled: genuinely nothing to do.
			return;
		}
		if (!configured || (previous.instance && previous.instance !== configured)) {
			await this.retractInflux(previous.instance || instance, previous.ids, configured);
			if (!configured) {
				return;
			}
		}

		const managed = previous.instance === configured ? previous.ids : [];

		const groups = {
			system: !!this.config.logSystem,
			network: !!this.config.logNetwork,
			wlan: !!this.config.logWlan,
			deviceCounts: !!this.config.logDeviceCounts,
		};
		const desired = influxTargets([...this.knownObjects], groups);
		const desiredSet = new Set(desired);
		const prefix = `${this.namespace}.`;

		let current = {};
		try {
			const res = await this.sendToInflux(instance, 'getEnabledDPs', {});
			current = res && typeof res === 'object' ? res : {};
		} catch (error) {
			this.log.warn(
				`Could not reach ${instance} to set up InfluxDB logging: ${this.redact(error.message)}. Is that instance running?`,
			);
			return;
		}

		let enabled = 0;
		let disabled = 0;
		for (const rel of desired) {
			const id = prefix + rel;
			const aliasId = influxAlias(this.config.influxPrefix, rel);
			// Skip if already logged with the same alias, to avoid needless churn.
			if (current[id] && (current[id].aliasId || '') === aliasId) {
				continue;
			}
			try {
				await this.sendToInflux(instance, 'enableHistory', {
					id,
					options: { changesOnly: true, debounce: 0, changesMinDelta: 0, aliasId },
				});
				enabled++;
			} catch (error) {
				this.log.warn(`Could not enable InfluxDB logging for ${rel}: ${this.redact(error.message)}`);
			}
		}
		// What the persisted list will hold afterwards. It starts as the desired
		// selection and keeps any datapoint whose disable did not go through: a
		// datapoint dropped from the list while it is still logging would be
		// orphaned — no longer wanted, no longer known to be ours, and therefore
		// never retried.
		const stillManaged = new Set(desired);

		// Disable only datapoints we enabled before and no longer want.
		for (const rel of managed) {
			if (desiredSet.has(rel)) {
				continue;
			}
			try {
				await this.sendToInflux(instance, 'disableHistory', { id: prefix + rel });
				disabled++;
			} catch (error) {
				stillManaged.add(rel);
				this.log.warn(
					`Could not disable InfluxDB logging for ${rel}: ${this.redact(error.message)}. It stays on the managed list and is retried on the next start.`,
				);
			}
		}

		await this.writeManagedInflux(instance, [...stillManaged]);
		if (enabled || disabled) {
			this.log.info(
				`InfluxDB logging on ${instance}: ${enabled} enabled, ${disabled} disabled, ${desired.length} KPI(s) selected`,
			);
		}
	}

	/**
	 * Switches off everything this adapter enabled on one instance.
	 *
	 * Used when the selection is set to "disabled" or moved to a different
	 * instance: the datapoints are still being logged over there, and only this
	 * adapter knows which of them are its own.
	 *
	 * @param {string} instance - Instance the logging was enabled on
	 * @param {Array<string>} ids - Relative ids to switch off
	 * @param {string} configured - The instance now configured, '' when disabled
	 */
	async retractInflux(instance, ids, configured) {
		if (!instance || !ids.length) {
			await this.writeManagedInflux(configured, []);
			return;
		}
		const prefix = `${this.namespace}.`;
		const left = [];
		for (const rel of ids) {
			try {
				await this.sendToInflux(instance, 'disableHistory', { id: prefix + rel });
			} catch (error) {
				left.push(rel);
				this.log.warn(
					`Could not switch off InfluxDB logging for ${rel} on ${instance}: ${this.redact(error.message)}`,
				);
			}
		}
		const tail = left.length ? '; the rest stays on the list and is retried on the next start' : '';
		this.log.info(
			`Switched off InfluxDB logging on ${instance} for ${ids.length - left.length} of ${ids.length} datapoint(s)${tail}`,
		);
		// Anything that could not be switched off stays attributed to the old
		// instance, so a later start can finish the job there.
		await this.writeManagedInflux(left.length ? instance : configured, left);
	}

	/**
	 * Reads back which datapoints this adapter enabled, and where.
	 *
	 * Older releases stored a bare array without the instance. Such a value is
	 * still read, with an empty instance, so an upgrade loses nothing.
	 *
	 * @returns {Promise<{instance: string, ids: Array<string>}>} The managed set
	 */
	async readManagedInflux() {
		try {
			const state = await this.getStateAsync('info.influxManaged');
			const parsed = state && state.val ? JSON.parse(String(state.val)) : null;
			if (Array.isArray(parsed)) {
				return { instance: '', ids: parsed };
			}
			if (parsed && typeof parsed === 'object') {
				return {
					instance: String(parsed.instance || ''),
					ids: Array.isArray(parsed.ids) ? parsed.ids : [],
				};
			}
		} catch (error) {
			this.log.debug(`Could not read the InfluxDB managed list: ${this.redact(error.message)}`);
		}
		return { instance: '', ids: [] };
	}

	/**
	 * Records which datapoints are logged and on which instance.
	 *
	 * @param {string} instance - Instance the datapoints are logged on
	 * @param {Array<string>} ids - Relative ids
	 */
	async writeManagedInflux(instance, ids) {
		await this.setState('info.influxManaged', JSON.stringify({ instance, ids: [...ids].sort() }), true);
	}

	/**
	 * Sends a message to the InfluxDB adapter with a timeout.
	 *
	 * A message to a stopped instance is queued and its callback may never fire,
	 * which would hang whatever awaits it. This rejects after a few seconds so a
	 * stopped or unreachable InfluxDB instance cannot stall the adapter.
	 *
	 * @param {string} instance - Target instance, e.g. `influxdb.0`
	 * @param {string} command - Message command
	 * @param {Record<string, unknown>} message - Message payload
	 * @returns {Promise<unknown>} The adapter's reply
	 */
	sendToInflux(instance, command, message) {
		return new Promise((resolve, reject) => {
			const timer = this.setTimeout(() => reject(new Error(`no reply from ${instance} within 8 s`)), 8000);
			this.sendToAsync(instance, command, message).then(
				result => {
					this.clearTimeout(timer);
					resolve(result);
				},
				error => {
					this.clearTimeout(timer);
					reject(error);
				},
			);
		});
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - Callback function
	 */
	onUnload(callback) {
		try {
			// Stops write() and poll(): clearing the timer does not abort a poll
			// that is already running, and its writes would land on an adapter
			// that is being torn down.
			this.unloaded = true;
			if (this.pollTimer) {
				this.clearInterval(this.pollTimer);
				this.pollTimer = undefined;
			}
			// The TLS dispatcher keeps sockets alive and would hold the adapter
			// open. Fire and forget: unload must not wait on the network.
			if (this.client) {
				this.client.close().catch(() => {});
			}
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${this.redact(error.message)}`);
			callback();
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	module.exports = options => new Freshtomato(options);
} else {
	// otherwise start the instance directly
	new Freshtomato();
}
