/* Smoke-test the netview view render functions against mock ubus payloads.
 * Loads overview.js in a sandbox with stubbed LuCI globals, then exercises the
 * pure render helpers and asserts that no NaN / undefined leaks into the HTML.
 */
const fs = require('fs');
const vm = require('vm');

const SRC = require('path').join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'netview', 'overview.js');

let src = fs.readFileSync(SRC, 'utf8');
// drop the LuCI 'require' pragmas (they are not valid JS by themselves)
src = src.replace(/^'require [^']*';$/gm, '');
// the module ends in `return view.extend({...})` -- turn it into a plain
// expression statement so the export appended below is actually reachable
src = src.replace('return view.extend(', 'view.extend(');

const EXPORT = '\n;return { sideHtml, ifTableHtml, chartSvg, sparkSvg, aggregate,' +
	' renderDevices, fmtBytes, fmtRate, fmtDuration, fmtProto, fmtSpeed, CSS,' +
	' truthy, niceMax, smoothPath };\n';

const viewStub = { extend: (o) => o };
const rpcStub  = { declare: () => () => Promise.resolve(null) };
const pollStub = { add: () => {}, start: () => {} };
const EStub    = (tag, attrs, children) => ({ tag, attrs, children, innerHTML: '' });

const factory = new Function('view', 'rpc', 'poll', 'E', src + EXPORT);
const API = factory(viewStub, rpcStub, pollStub, EStub);

let pass = 0, fail = 0;
function check(name, cond, detail) {
	if (cond) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name + (detail ? '  << ' + detail : '')); }
}
function dirty(html) {
	const m = String(html).match(/NaN|undefined|Infinity|\[object/);
	return m ? m[0] : null;
}

/* ------------------------------------------------------------------ mocks --- */

const IF_FULL = {
	timestamp: 1758000000, wan: 'eth0', lan: 'br-lan', clients: 12,
	wan_info: {
		connected: true, uptime: 411567, proto: 'dhcp', device: 'eth0',
		ipv4: '192.168.9.231', mask: 24, ipv6: '2408:8207:1234:5678::1',
		gateway: '192.168.9.1', dns: '192.168.9.1 223.5.5.5', dns_auto: true
	},
	interfaces: [
		{ name: 'eth0',    role: 'WAN', roles: 'WAN,WAN6', state: 'up',   speed: 10000,
		  rx: 12345678901, tx: 987654321, rx_rate: 5242880, tx_rate: 314572 },
		{ name: 'br-lan',  role: 'LAN', roles: 'LAN',      state: 'up',   speed: 10000,
		  rx: 555555555,   tx: 666666666, rx_rate: 1048576, tx_rate: 262144 },
		{ name: 'docker0', role: '',    roles: '',         state: 'down', speed: 0,
		  rx: 1000,        tx: 2000,     rx_rate: 0,       tx_rate: 0 }
	]
};

const IF_NO_WAN = {
	timestamp: 1, wan: '', lan: 'br-lan', clients: 0,
	wan_info: { connected: false, uptime: 0, proto: '', device: '', ipv4: '', mask: 0,
	            ipv6: '', gateway: '', dns: '', dns_auto: false },
	interfaces: [
		{ name: 'br-lan', role: 'LAN', roles: 'LAN', state: 'up', speed: 1000,
		  rx: 10, tx: 20, rx_rate: 0, tx_rate: 0 }
	]
};

function hist(n, scale) {
	const out = [];
	for (let i = 0; i < n; i++)
		out.push({ d: Math.abs(Math.sin(i / 5)) * scale, u: Math.abs(Math.cos(i / 7)) * scale / 3 });
	return out;
}

/* --------------------------------------------------------- 1. side column --- */

console.log('\n=== side column ===');
let html = API.sideHtml(IF_FULL);
check('含连通状态', html.includes('已连接互联网'));
check('含连接时长', html.includes('4 天'), /4 天/.test(html) ? '' : html.slice(0, 200));
check('含设备数', html.includes('>12<'));
check('含 WAN 设备名', html.includes('IP 地址（eth0）'));
check('含 IPv4 + DHCP 标注', html.includes('192.168.9.231') && html.includes('DHCP'));
check('含 IPv6', html.includes('2408:8207'));
check('含 DNS + 自动获取', html.includes('223.5.5.5') && html.includes('自动获取'));
check('含网卡瓦片 10000 Mbit/s', html.includes('10000 Mbit/s'));
check('瓦片带角色标注', html.includes('（WAN,WAN6）'));
check('无 NaN/undefined 泄漏', dirty(html) === null, dirty(html));

html = API.sideHtml(IF_NO_WAN);
check('无 WAN 时不抛错且提示未连接', html.includes('未连接互联网'));
check('无 IPv4 时显示"未获取"', html.includes('未获取'));
check('无 NaN/undefined 泄漏', dirty(html) === null, dirty(html));

html = API.sideHtml({ interfaces: [], wan_info: {}, wan: 'wan', clients: 0 });
check('wan_info 为空对象不抛错', typeof html === 'string' && html.length > 0);
check('无 NaN/undefined 泄漏', dirty(html) === null, dirty(html));

/* 后端返回的布尔可能是 true 也可能是字符串 "1" —— 两种都要认 */
check('connected="1" 视为已连接', API.sideHtml({
	interfaces: [], clients: 0, wan: 'wan', wan_info: { connected: '1' }
}).includes('已连接互联网'));
check('connected=false 视为未连接', !API.sideHtml({
	interfaces: [], clients: 0, wan: 'wan', wan_info: { connected: false }
}).includes('已连接互联网'));

/* ---------------------------------------------------- 2. interface table --- */

console.log('\n=== interface table ===');
html = API.ifTableHtml(IF_FULL);
check('WAN 排在 LAN 前', html.indexOf('eth0') < html.indexOf('br-lan'));
check('含 WAN 徽章', html.includes('>WAN</span>'));
check('含速率', html.includes('MB/s') || html.includes('KB/s'));
check('含 sparkline', html.includes('<svg'));
check('docker0 也列出', html.includes('docker0'));
check('无 NaN/undefined 泄漏', dirty(html) === null, dirty(html));

check('空接口列表走空态', API.ifTableHtml({ interfaces: [] }).includes('未检测到网络接口'));
check('interfaces 缺失不抛错', API.ifTableHtml({}).includes('未检测到网络接口'));

/* ------------------------------------------------------- 3. hero chart --- */

console.log('\n=== hero chart ===');
check('0 点走占位提示', API.chartSvg([]).includes('正在采集数据'));
check('1 点走占位提示', API.chartSvg(hist(1, 1e6)).includes('正在采集数据'));

html = API.chartSvg(hist(60, 6e6));
check('60 点输出 svg', html.startsWith('<svg'));
check('含两条渐变面积', (html.match(/<path /g) || []).length === 2);
check('含两个线性渐变', (html.match(/<linearGradient/g) || []).length === 2);
check('含裁剪以免过冲溢出', html.includes('<clipPath'));
check('曲线用三次贝塞尔', html.includes(' C'));
check('无 NaN/undefined 泄漏', dirty(html) === null, dirty(html));

html = API.chartSvg(hist(2, 0));   /* 全零 —— 空闲链路 */
check('全零数据不产生 NaN', dirty(html) === null, dirty(html));

/* 几何校验：坐标必须落在画布内、面积必须闭合到基线、峰值不能贴不到顶
 * —— 只查 NaN 是抓不到"曲线被压扁在底部"这种问题的 */
(function () {
	var W = 900, H = 292, PAD = 6, BASE = H - PAD;

	var h = [];
	for (var i = 0; i < 60; i++) h.push({ d: 1.15e7 * (0.55 + 0.45 * Math.sin(i / 6)), u: 4e6 });
	var svg = API.chartSvg(h);

	var ds = (svg.match(/ d="([^"]+)"/g) || []).map(function (s) { return s.slice(4, -1); });
	check('输出两条面积路径', ds.length === 2, 'actual ' + ds.length);

	ds.forEach(function (d, k) {
		var pts = (d.match(/(-?\d+\.\d+),(-?\d+\.\d+)/g) || []).map(function (p) {
			var a = p.split(',');
			return [ parseFloat(a[0]), parseFloat(a[1]) ];
		});
		var xs = pts.map(function (p) { return p[0]; });
		var ys = pts.map(function (p) { return p[1]; });

		check('面积 #' + k + ' 有坐标点', pts.length > 10, 'actual ' + pts.length);
		check('面积 #' + k + ' x 在画布内',
			Math.min.apply(null, xs) >= 0 && Math.max.apply(null, xs) <= W,
			'x 范围 ' + Math.min.apply(null, xs) + '..' + Math.max.apply(null, xs));
		check('面积 #' + k + ' y 在画布内',
			Math.min.apply(null, ys) >= 0 && Math.max.apply(null, ys) <= H,
			'y 范围 ' + Math.min.apply(null, ys).toFixed(1) + '..' + Math.max.apply(null, ys).toFixed(1));
		check('面积 #' + k + ' 闭合到基线', d.indexOf('L' + W + '.0,' + BASE) >= 0 || /Z$/.test(d));
		check('面积 #' + k + ' 以 Z 收尾', /Z$/.test(d));
	});

	/* 峰值应当接近顶部：留白超过 30% 就说明刻度阶梯取大了 */
	(function () {
		var d0 = ds[0];
		var ys = (d0.match(/(-?\d+\.\d+),(-?\d+\.\d+)/g) || []).map(function (p) {
			return parseFloat(p.split(',')[1]);
		});
		var top = Math.min.apply(null, ys);
		check('峰值贴近顶部（留白 < 30% 卡高）', top < H * 0.30,
			'峰值 y=' + top.toFixed(1) + ' 画布高 ' + H);
	})();

	/* 下载面积整体应当压在 / 覆盖上传面积之上 */
	check('下载面积先绘制（在上传之下）',
		svg.indexOf('#nvGDn') < svg.indexOf('#nvGUp') || svg.indexOf('nvGDn")') < svg.indexOf('nvGUp")'));
})();

/* -------------------------------------------------------- 4. sparkline --- */

console.log('\n=== sparkline ===');
check('0 点返回空 svg', API.sparkSvg([]).includes('viewBox'));
check('1 点返回空 svg', API.sparkSvg([{ d: 1, u: 1 }]).includes('viewBox'));
html = API.sparkSvg(hist(60, 1e5));
check('60 点输出路径', html.includes('<path') && html.includes('<svg'));
check('无 NaN/undefined 泄漏', dirty(html) === null, dirty(html));
html = API.sparkSvg(hist(60, 0));
check('全零 sparkline 无 NaN', dirty(html) === null, dirty(html));

/* ------------------------------------------------------- 5. aggregate --- */

console.log('\n=== aggregate ===');
let agg = API.aggregate(IF_FULL.interfaces);
check('只累加 WAN 接口', agg.d === 5242880 && agg.u === 314572, JSON.stringify(agg));
check('scope 标为 WAN', agg.scope === 'WAN');
agg = API.aggregate(IF_NO_WAN.interfaces);
check('无 WAN 时退化为全部接口', agg.d === 0 && agg.scope === '全部接口', JSON.stringify(agg));
check('空列表不抛错', API.aggregate([]).scope === '全部接口');
check('null 不抛错', API.aggregate(null).d === 0);

/* ------------------------------------------------------ 6. device table --- */

console.log('\n=== device table ===');
function box() { return { innerHTML: '' }; }

let b = box();
API.renderDevices(b, { devices: [
	{ ip: '192.168.1.101', host: 'desktop.lan', down: 5000000, up: 900000, down_rate: 4096, up_rate: 512, conns: 7 },
	{ ip: '192.168.1.102', host: '-',           down: 600,     up: 450,    down_rate: 0,    up_rate: 0,   conns: 1 }
]});
check('渲染表格', b.innerHTML.includes('desktop.lan'));
check('未知设备占位', b.innerHTML.includes('未知设备'));
check('无 NaN/undefined 泄漏', dirty(b.innerHTML) === null, dirty(b.innerHTML));

b = box(); API.renderDevices(b, { error: 'conntrack_acct_disabled' });
check('记账关闭时给修复命令', b.innerHTML.includes('nf_conntrack_acct=1'));
b = box(); API.renderDevices(b, { error: 'conntrack_unavailable' });
check('conntrack 不可用时给提示', b.innerHTML.includes('conntrack 表不可用'));
b = box(); API.renderDevices(b, { devices: [] });
check('无连接时走空态', b.innerHTML.includes('暂无活动'));
b = box(); API.renderDevices(b, null);
check('null 数据不抛错', b.innerHTML.length > 0);
b = box(); API.renderDevices(b, { devices: [{ ip: '10.0.0.1', host: '', down: 0, up: 0, down_rate: 0, up_rate: 0, conns: 0 }] });
check('空 host 不泄漏 undefined', dirty(b.innerHTML) === null, dirty(b.innerHTML));

/* ----------------------------------------------------- 7. formatting --- */

console.log('\n=== formatting ===');
check('fmtBytes 0', API.fmtBytes(0) === '0 B');
check('fmtBytes 1024', API.fmtBytes(1024) === '1.00 KB');
check('fmtBytes undefined', API.fmtBytes(undefined) === '0 B');
check('fmtBytes 负数', API.fmtBytes(-5) === '0 B');
check('fmtRate', API.fmtRate(1536) === '1.50 KB/s');
check('fmtDuration 秒', API.fmtDuration(45) === '45 秒');
check('fmtDuration 分', API.fmtDuration(125) === '2 分 5 秒');
check('fmtDuration 时', API.fmtDuration(3725) === '1 小时 2 分');
check('fmtDuration 天', API.fmtDuration(411567) === '4 天 18 小时', API.fmtDuration(411567));
check('fmtProto dhcp', API.fmtProto('dhcp') === 'DHCP');
check('fmtProto pppoe', API.fmtProto('pppoe') === 'PPPoE');
check('fmtProto 空', API.fmtProto('') === '');
check('fmtSpeed 0 显示破折号', API.fmtSpeed(0) === '—');
check('fmtSpeed 10000', API.fmtSpeed(10000) === '10000 Mbit/s');

/* --------------------------------------------------------- 8. scale --- */

console.log('\n=== y 轴刻度 ===');
check('niceMax(0) 走地板值', API.niceMax(0) === 32 * 1024);
check('niceMax 2.8MB/s 取到 3MB/s（旧阶梯会取 5MB/s 白留一半空间）',
	API.niceMax(2.8e6) === 3e6, String(API.niceMax(2.8e6)));
check('niceMax 3.1MB/s 取到 4MB/s', API.niceMax(3.1e6) === 4e6, String(API.niceMax(3.1e6)));
check('niceMax 单调不减', API.niceMax(6000) <= API.niceMax(90000));
/* 曲线至少要占到卡片高度的 2/3，否则观感上"压底" */
(function() {
	var worst = 0, worstAt = 0;
	for (var v = 1e4; v < 5e7; v *= 1.07) {
		var r = API.niceMax(v * 1.08) / v;
		if (r > worst) { worst = r; worstAt = v; }
	}
	check('任意峰值下留白不超过 50%', worst <= 1.5,
		'最差 ' + worst.toFixed(2) + 'x @ ' + Math.round(worstAt));
})();

/* ------------------------------------------------------- 9. CSS sanity --- */

console.log('\n=== CSS ===');
check('CSS 无 NaN', !/NaN|undefined/.test(API.CSS));
check('CSS 括号配对', (API.CSS.match(/\{/g) || []).length === (API.CSS.match(/\}/g) || []).length);
check('CSS 未残留未替换的拼接痕迹', !/\+\s*'\./.test(API.CSS));
check('包含响应式折叠', API.CSS.includes('max-width: 1000px'));
check('包含暗色回退', API.CSS.includes('prefers-color-scheme: dark'));

console.log('\n======================================');
console.log('  pass ' + pass + '   fail ' + fail);
console.log('======================================');
process.exit(fail ? 1 : 0);
