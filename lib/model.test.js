'use strict';

const { expect } = require('chai');
const {
	buildModel,
	buildSystem,
	buildWans,
	buildUsb,
	buildDevices,
	buildRadios,
	parseRadioTemperatures,
	parsePortState,
	bandFromMhz,
	macToId,
	toIdSegment,
	buildTraffic,
	rateFrom,
	cpuUsageFromJiffies,
	influxTargets,
	influxAlias,
	num,
} = require('./model');

describe('model => helpers', () => {
	it('normalises MAC addresses into object ids', () => {
		expect(macToId('AA:BB:CC:DD:EE:FF')).to.equal('aabbccddeeff');
	});

	it('maps unusable numbers to null rather than zero', () => {
		expect(num('')).to.equal(null);
		expect(num('abc')).to.equal(null);
		expect(num('70')).to.equal(70);
		expect(num(0)).to.equal(0);
		expect(num(null)).to.equal(null);
		expect(num(undefined)).to.equal(null);
	});

	it('does not turn a whitespace only nvram field into a reading of zero', () => {
		// Number(' ') is 0, which would look like a genuine measurement
		expect(num(' ')).to.equal(null);
		expect(num('\t')).to.equal(null);
		expect(num(' 42 ')).to.equal(42);
	});

	it('keeps ordinary interface names unchanged', () => {
		expect(toIdSegment('eth0')).to.equal('eth0');
		expect(toIdSegment('vlan31')).to.equal('vlan31');
		expect(toIdSegment('br0')).to.equal('br0');
	});

	it('stops a VLAN sub-interface name from creating an extra object level', () => {
		// '.' is the ioBroker level separator, so eth0.1 would nest silently
		expect(toIdSegment('eth0.1')).to.equal('eth0_1');
	});

	it('replaces characters ioBroker rejects in object ids', () => {
		// the trailing separator is stripped, so no id ends in an underscore
		expect(toIdSegment('port[1]')).to.equal('port_1');
		expect(toIdSegment('we ird')).to.equal('we_ird');
		expect(toIdSegment('a**b')).to.equal('a_b');
	});

	it('classifies bands by centre frequency', () => {
		expect(bandFromMhz(2437)).to.equal('2G');
		expect(bandFromMhz(5660)).to.equal('5G');
		expect(bandFromMhz(6135)).to.equal('6G');
		expect(bandFromMhz(null)).to.equal('unknown');
	});

	it('decodes switch port states', () => {
		expect(parsePortState('1000FD')).to.deep.equal({
			state: '1000FD',
			up: true,
			speed: 1000,
			duplex: 'full',
		});
		expect(parsePortState('100HD').duplex).to.equal('half');
		expect(parsePortState('DOWN')).to.deep.equal({
			state: 'DOWN',
			up: false,
			speed: null,
			duplex: null,
		});
	});

	it('pulls per radio temperatures out of the pre-rendered wlsense string', () => {
		const wlsense = 'eth1: 2.4G - 49&#176;C&nbsp;/&nbsp;120&#176;F&nbsp;eth2: 5G - 55&#176;C';
		expect(parseRadioTemperatures(wlsense)).to.deep.equal({ eth1: 49, eth2: 55 });
	});

	it('survives a missing wlsense field', () => {
		expect(parseRadioTemperatures(undefined)).to.deep.equal({});
	});
});

describe('model => buildSystem', () => {
	it('converts the fixed point load averages Linux reports', () => {
		const system = buildSystem({ loads: [15264, 17376, 19904] }, {});
		expect(system.load1).to.equal(0.23);
		expect(system.load5).to.equal(0.27);
		expect(system.load15).to.equal(0.3);
	});

	it('reports the CPU temperature as a number even though nvram sends a string', () => {
		expect(buildSystem({ cputemp: '70' }, {}).cpuTemperature).to.equal(70);
	});
});

describe('model => buildWans', () => {
	it('reports only the WANs that are actually in use', () => {
		const wans = buildWans({ mwan_num: '1', wan_ipaddr: '203.0.113.7', wan2_ipaddr: '' });
		expect(wans).to.have.lengthOf(1);
		expect(wans[0].id).to.equal('wan');
	});

	it('names additional WANs the way nvram does', () => {
		const wans = buildWans({ mwan_num: '2' });
		expect(wans.map(w => w.id)).to.deep.equal(['wan', 'wan2']);
	});

	it('treats an all zero address as disconnected', () => {
		expect(buildWans({ wan_ipaddr: '0.0.0.0' })[0].connected).to.equal(false);
		expect(buildWans({ wan_ipaddr: '203.0.113.7' })[0].connected).to.equal(true);
	});

	it('reports the router-formatted uptime and lease remaining per WAN slot', () => {
		const wans = buildWans({ mwan_num: '2' }, ['11 days, 20h 01m 23s', '--'], ['00h 23m 26s', '']);
		expect(wans[0].uptime).to.equal('11 days, 20h 01m 23s');
		expect(wans[0].leaseRemaining).to.equal('00h 23m 26s');
		expect(wans[1].uptime).to.equal('--');
		expect(wans[1].leaseRemaining).to.equal(null);
	});

	it('defaults uptime and lease remaining to null without the stats arrays', () => {
		const wans = buildWans({ mwan_num: '1' });
		expect(wans[0].uptime).to.equal(null);
		expect(wans[0].leaseRemaining).to.equal(null);
	});
});

describe('model => buildUsb', () => {
	// One physical stick, one disk, one mounted partition — the shape measured
	// against a real R7000 with a USB stick plugged in.
	const oneStick = [
		[
			'Storage',
			'0',
			'SMI',
			'USB DISK',
			'',
			[
				[-1, []],
				['sda', [['USB_STORAGE', 1, '/tmp/mnt/USB_STORAGE', 'vfat', 'rw,noatime', 8001683456, 7859720192]]],
			],
			1,
		],
	];

	it('flattens vendor, product and the mounted partition into one entry', () => {
		const usb = buildUsb(oneStick);
		expect(usb).to.have.lengthOf(1);
		expect(usb[0]).to.deep.equal({
			id: 'sda1',
			vendor: 'SMI',
			product: 'USB DISK',
			disk: 'sda',
			partition: 1,
			label: 'USB_STORAGE',
			mountpoint: '/tmp/mnt/USB_STORAGE',
			filesystem: 'vfat',
			totalBytes: 8001683456,
			freeBytes: 7859720192,
			usedBytes: 141963264,
			usedPercent: 1.8,
			attached: true,
		});
	});

	it('reports one entry per stick, and per partition on the same stick', () => {
		const twoPartitions = [
			[
				'Storage',
				'0',
				'Kingston',
				'DataTraveler',
				'',
				[
					[
						'sdb',
						[
							['DATA', 1, '/tmp/mnt/DATA', 'ext4', 'rw', 4000000000, 1000000000],
							['BACKUP', 2, '/tmp/mnt/BACKUP', 'ext4', 'rw', 4000000000, 3000000000],
						],
					],
				],
				1,
			],
		];
		const usb = buildUsb([...oneStick, ...twoPartitions]);
		expect(usb.map(p => p.id)).to.deep.equal(['sda1', 'sdb1', 'sdb2']);
	});

	it('skips a disk with nothing mounted', () => {
		const unmounted = [['Storage', '0', 'SMI', 'USB DISK', '', [[-1, []]], 1]];
		expect(buildUsb(unmounted)).to.deep.equal([]);
	});

	it('returns nothing when no USB device is attached', () => {
		expect(buildUsb([])).to.deep.equal([]);
	});
});

describe('model => buildRadios', () => {
	const nvram = {
		wl0_ssid: 'Home',
		wl0_radio: '1',
		wl0_closed: '0',
		wl1_ssid: 'Home5',
		wl1_radio: '1',
		wl1_closed: '1',
	};
	const wlstats = [
		{ radio: 1, channel: 6, mhz: 2437, rate: 144, nbw: 20, noise: -90, intf: 0 },
		{ radio: 1, channel: 132, mhz: 5660, rate: 1733, nbw: 80, noise: -92, intf: 0 },
	];
	const wldev = [
		['eth1', 'AA:BB:CC:DD:EE:01', -52, 1000, 24000, 100, 0],
		['eth2', 'AA:BB:CC:DD:EE:02', -56, 866667, 866667, 200, 1],
		['eth2', 'AA:BB:CC:DD:EE:03', -58, 400000, 24000, 300, 1],
	];

	it('labels radios by band and links them to their interface', () => {
		const radios = buildRadios(nvram, wlstats, { eth1: 49, eth2: 55 }, wldev);
		expect(radios.map(r => r.id)).to.deep.equal(['2G', '5G']);
		expect(radios[0].interface).to.equal('eth1');
		expect(radios[1].temperature).to.equal(55);
	});

	it('counts the clients attached to each radio', () => {
		const radios = buildRadios(nvram, wlstats, {}, wldev);
		expect(radios[0].clients).to.equal(1);
		expect(radios[1].clients).to.equal(2);
	});

	it('reports a hidden SSID', () => {
		const radios = buildRadios(nvram, wlstats, {}, wldev);
		expect(radios[0].hidden).to.equal(false);
		expect(radios[1].hidden).to.equal(true);
	});

	it('keeps ids unique when two radios share a band', () => {
		const sameBand = [wlstats[0], { ...wlstats[0] }];
		expect(buildRadios(nvram, sameBand, {}, []).map(r => r.id)).to.deep.equal(['2G', '2G_1']);
	});
});

describe('model => buildDevices', () => {
	const radios = [
		{ id: '2G', unit: 0 },
		{ id: '5G', unit: 1 },
	];

	it('merges ARP, wireless and lease data for the same MAC into one entry', () => {
		const devices = buildDevices(
			[['192.168.1.10', 'AA:BB:CC:DD:EE:01', 'br0', 'laptop']],
			[['eth2', 'AA:BB:CC:DD:EE:01', -58, 400000, 24000, 300, 1]],
			[['laptop', '192.168.1.10', 'AA:BB:CC:DD:EE:01', '01h 00m 00s']],
			radios,
		);
		expect(devices).to.have.lengthOf(1);
		expect(devices[0]).to.include({
			ip: '192.168.1.10',
			hostname: 'laptop',
			wireless: true,
			band: '5G',
			rssi: -58,
			leaseExpires: '01h 00m 00s',
		});
	});

	it('converts link rates from kbit/s to Mbit/s', () => {
		const devices = buildDevices([], [['eth1', 'AA:BB:CC:DD:EE:01', -52, 72222, 24000, 1, 0]], [], radios);
		expect(devices[0].txRate).to.equal(72);
		expect(devices[0].rxRate).to.equal(24);
	});

	it('marks wired devices as not wireless', () => {
		const devices = buildDevices([['192.168.1.20', 'AA:BB:CC:DD:EE:02', 'br0', 'nas']], [], [], radios);
		expect(devices[0].wireless).to.equal(false);
		expect(devices[0].band).to.equal(null);
	});

	it('ignores the placeholder host name the router emits', () => {
		const devices = buildDevices([['192.168.1.30', 'AA:BB:CC:DD:EE:03', 'br0', '<unknown>']], [], [], radios);
		expect(devices[0].hostname).to.equal(null);
	});

	it('falls back to the lease host name when ARP has none', () => {
		const devices = buildDevices(
			[['192.168.1.40', 'AA:BB:CC:DD:EE:04', 'br0', '<unknown>']],
			[],
			[['printer', '192.168.1.40', 'AA:BB:CC:DD:EE:04', '02h 00m 00s']],
			radios,
		);
		expect(devices[0].hostname).to.equal('printer');
	});

	it('drops rows without a usable MAC', () => {
		expect(buildDevices([['192.168.1.50', '', 'br0', 'x']], [], [], radios)).to.have.lengthOf(0);
	});

	it('sorts by IP address rather than by discovery order', () => {
		const devices = buildDevices(
			[
				['192.168.1.20', 'AA:BB:CC:DD:EE:02', 'br0', 'b'],
				['192.168.1.3', 'AA:BB:CC:DD:EE:01', 'br0', 'a'],
			],
			[],
			[],
			radios,
		);
		expect(devices.map(d => d.ip)).to.deep.equal(['192.168.1.3', '192.168.1.20']);
	});
});

describe('model => buildModel', () => {
	it('produces an empty but complete model when the router sends nothing', () => {
		const model = buildModel();
		expect(model.deviceCount).to.equal(0);
		expect(model.wirelessDeviceCount).to.equal(0);
		expect(model.radios).to.deep.equal([]);
		expect(model.interfaces).to.deep.equal([]);
		expect(model.info.firmware).to.equal(null);
	});

	it('counts wireless clients separately from the total', () => {
		const model = buildModel({
			arplist: [
				['192.168.1.10', 'AA:BB:CC:DD:EE:01', 'br0', 'a'],
				['192.168.1.11', 'AA:BB:CC:DD:EE:02', 'br0', 'b'],
			],
			wldev: [['eth1', 'AA:BB:CC:DD:EE:01', -52, 1000, 1000, 5, 0]],
			wlstats: [{ mhz: 2437, channel: 6 }],
		});
		expect(model.deviceCount).to.equal(2);
		expect(model.wirelessDeviceCount).to.equal(1);
	});

	it('exposes interface counters as numbers', () => {
		const model = buildModel({ netdev: { eth0: { rx: 16, tx: 32 } } });
		expect(model.interfaces).to.deep.equal([{ id: 'eth0', name: 'eth0', rxBytes: 16, txBytes: 32 }]);
	});

	it('gives interfaces and ports a safe id alongside their reported name', () => {
		const model = buildModel({
			netdev: { 'eth0.1': { rx: 1, tx: 2 } },
			etherstates: { 'port.0': '1000FD' },
		});
		expect(model.interfaces[0]).to.include({ id: 'eth0_1', name: 'eth0.1' });
		expect(model.ports[0]).to.include({ id: 'port_0', name: 'port.0', up: true });
	});
});

describe('model => buildTraffic', () => {
	it('maps the four columns whose meaning was measured', () => {
		const t = buildTraffic([['192.168.1.10', 1416956, 486014, 1893, 2327, 70, 87, 13, 13, 4, 23]]);
		expect(t.get('192.168.1.10')).to.deep.equal({
			bytesIn: 1416956,
			bytesOut: 486014,
			packetsIn: 1893,
			packetsOut: 2327,
		});
	});

	it('ignores the columns whose meaning was not established', () => {
		// Columns 5 to 10 were observed decreasing, so they are not counters
		const t = buildTraffic([['192.168.1.10', 1, 2, 3, 4, 999, 999, 999, 999, 999, 999]]);
		expect(Object.keys(t.get('192.168.1.10'))).to.have.members(['bytesIn', 'bytesOut', 'packetsIn', 'packetsOut']);
	});

	it('skips rows without a usable address', () => {
		expect(buildTraffic([['', 1, 2, 3, 4]]).size).to.equal(0);
	});

	it('survives an empty or absent response', () => {
		expect(buildTraffic([]).size).to.equal(0);
		expect(buildTraffic(undefined).size).to.equal(0);
	});
});

describe('model => rateFrom', () => {
	it('derives bytes per second from two readings', () => {
		expect(rateFrom(1000, 4000, 30)).to.equal(100);
	});

	it('reports no rate when the counter went backwards', () => {
		// The router restarted: differentiating would give a large negative
		// number, or an absurd positive one if treated as unsigned
		expect(rateFrom(5000, 100, 30)).to.equal(null);
	});

	it('treats an unchanged counter as zero, not as a restart', () => {
		expect(rateFrom(5000, 5000, 30)).to.equal(0);
	});

	it('refuses to divide by a zero or negative interval', () => {
		expect(rateFrom(0, 100, 0)).to.equal(null);
		expect(rateFrom(0, 100, -5)).to.equal(null);
	});

	it('refuses values that are not finite numbers', () => {
		expect(rateFrom(NaN, 100, 30)).to.equal(null);
		expect(rateFrom(0, Infinity, 30)).to.equal(null);
	});
});

describe('model => cpuUsageFromJiffies', () => {
	// Two samples taken 3 s apart from a live router (porta), rather than made
	// up numbers: `jiffies` is the raw `/proc/stat` cpu line, and getting the
	// column that means "idle" wrong would silently invert the percentage.
	const sample1 = '22997628 0 8254896 199445552 1813869 0 6918708 0 0 0';
	const sample2 = '22997744 0 8254915 199446004 1813871 0 6918733 0 0 0';

	it('derives a usage percentage from two real readings', () => {
		// diffTotal 614, diffIdle 452 -> (614-452)/614 = 26.4 %
		expect(cpuUsageFromJiffies(sample1, sample2)).to.equal(26.4);
	});

	it('reports nothing on the first poll, since there is no baseline yet', () => {
		expect(cpuUsageFromJiffies(undefined, sample1)).to.equal(null);
		expect(cpuUsageFromJiffies(null, sample1)).to.equal(null);
	});

	it('reports nothing when the counters went backwards, as after a reboot', () => {
		expect(cpuUsageFromJiffies(sample2, sample1)).to.equal(null);
	});

	it('reports nothing for a reading that is not the expected shape', () => {
		expect(cpuUsageFromJiffies(sample1, 'not jiffies')).to.equal(null);
		expect(cpuUsageFromJiffies(sample1, '1 2 3')).to.equal(null);
		expect(cpuUsageFromJiffies(sample1, undefined)).to.equal(null);
	});

	it('reports 0% when nothing but idle time passed', () => {
		expect(cpuUsageFromJiffies('0 0 0 1000 0 0 0 0 0 0', '0 0 0 2000 0 0 0 0 0 0')).to.equal(0);
	});
});

describe('model => influxTargets', () => {
	const ids = [
		'system.cpuTemperature',
		'system.load1',
		'system.cpuType',
		'interfaces.vlan1.rxBytes',
		'interfaces.vlan1.txBytes',
		'interfaces.vlan1.name',
		'network.wan.connected',
		'network.wan.ip',
		'network.wan2.connected',
		'wlan.2G.clients',
		'wlan.2G.temperature',
		'wlan.2G.ssid',
		'devices.count',
		'devices.wirelessCount',
		'devices.onlineCount',
		'devices.offlineCount',
		'devices.aabbccddeeff.rateIn',
	];

	it('selects only the ids of the enabled groups', () => {
		expect(influxTargets(ids, { system: true })).to.deep.equal(['system.cpuTemperature', 'system.load1']);
	});

	it('includes cpuUsage and the presence aggregate counts in their groups', () => {
		expect(influxTargets(['system.cpuUsage', 'system.cpuType'], { system: true })).to.deep.equal([
			'system.cpuUsage',
		]);
		expect(influxTargets(['devices.onlineCount', 'devices.offlineCount'], { deviceCounts: true })).to.deep.equal([
			'devices.offlineCount',
			'devices.onlineCount',
		]);
	});

	it('matches dynamic interface and multi-wan ids for the network group', () => {
		expect(influxTargets(ids, { network: true })).to.deep.equal([
			'interfaces.vlan1.rxBytes',
			'interfaces.vlan1.txBytes',
			'network.wan.connected',
			'network.wan2.connected',
		]);
	});

	it('never selects per-device traffic, even with every group on', () => {
		const all = influxTargets(ids, { system: true, network: true, wlan: true, deviceCounts: true });
		expect(all).to.not.include('devices.aabbccddeeff.rateIn');
		expect(all).to.include.members([
			'devices.count',
			'devices.wirelessCount',
			'devices.onlineCount',
			'devices.offlineCount',
			'wlan.2G.clients',
		]);
	});

	it('returns nothing when no group is enabled or ids are absent', () => {
		expect(influxTargets(ids, {})).to.deep.equal([]);
		expect(influxTargets(undefined, { system: true })).to.deep.equal([]);
	});
});

describe('model => influxAlias', () => {
	it('prefixes the relative id', () => {
		expect(influxAlias('freshtomato', 'system.load1')).to.equal('freshtomato.system.load1');
	});

	it('returns an empty alias for an empty prefix, so the real id is used', () => {
		expect(influxAlias('', 'system.load1')).to.equal('');
		expect(influxAlias('   ', 'system.load1')).to.equal('');
	});

	it('cleans surrounding dots and inner whitespace in the prefix', () => {
		expect(influxAlias(' my router ', 'system.load1')).to.equal('my_router.system.load1');
		expect(influxAlias('.foo.', 'system.load1')).to.equal('foo.system.load1');
	});

	it('collapses repeated dots so the alias stays well formed', () => {
		expect(influxAlias('my..router', 'system.load1')).to.equal('my.router.system.load1');
	});
});
