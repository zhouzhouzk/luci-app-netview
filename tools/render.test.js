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

/* 按真实家庭宽带摆：WAN 是 PPPoE 拨号出来的 pppoe-wan（虚拟口，operstate
 * 永远是 unknown），跑在物理口 eth0 上；另有一个已断开的 wireguard 口。
 * link 是后端综合 operstate / IFF_UP / LOWER_UP / 全局地址算出来的结论。 */
const IF_FULL = {
	timestamp: 1758000000, wan: 'pppoe-wan', lan: 'br-lan', clients: 12,
	wan_info: {
		connected: true, uptime: 411567, proto: 'pppoe', device: 'pppoe-wan',
		ipv4: '192.168.9.231', mask: 24, ipv6: '2408:8207:1234:5678::1',
		gateway: '192.168.9.1', dns: '192.168.9.1 223.5.5.5', dns_auto: true
	},
	interfaces: [
		{ name: 'pppoe-wan', role: 'WAN', roles: 'WAN', state: 'unknown', link: 'up',
		  kind: 'virtual',  speed: 0,
		  rx: 12345678901, tx: 987654321, rx_rate: 5242880, tx_rate: 314572 },
		{ name: 'eth0',      role: '',    roles: '',    state: 'up',      link: 'up',
		  kind: 'physical', speed: 10000,
		  rx: 12400000000, tx: 1012345678, rx_rate: 5400000, tx_rate: 330000 },
		{ name: 'br-lan',    role: 'LAN', roles: 'LAN', state: 'up',      link: 'up',
		  kind: 'virtual',  speed: 10000,
		  rx: 555555555,   tx: 666666666, rx_rate: 1048576, tx_rate: 262144 },
		{ name: 'awg0',      role: '',    roles: '',    state: 'unknown', link: 'down',
		  kind: 'virtual',  speed: 0,
		  rx: 4096,        tx: 2048,      rx_rate: 0,       tx_rate: 0 },
		{ name: 'docker0',   role: '',    roles: '',    state: 'down',    link: 'down',
		  kind: 'virtual',  speed: 0,
		  rx: 1000,        tx: 2000,      rx_rate: 0,       tx_rate: 0 }
	]
};

const IF_NO_WAN = {
	timestamp: 1, wan: '', lan: 'br-lan', clients: 0,
	wan_info: { connected: false, uptime: 0, proto: '', device: '', ipv4: '', mask: 0,
	            ipv6: '', gateway: '', dns: '', dns_auto: false },
	interfaces: [
		{ name: 'br-lan', role: 'LAN', roles: 'LAN', state: 'up', link: 'up',
		  kind: 'virtual', speed: 1000,
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
check('含 WAN 设备名', html.includes('IP 地址（pppoe-wan）'));
check('含 IPv4 + PPPoE 标注', html.includes('192.168.9.231') && html.includes('PPPoE'));
check('含 IPv6', html.includes('2408:8207'));
check('含 DNS + 自动获取', html.includes('223.5.5.5') && html.includes('自动获取'));
check('含网卡瓦片 10000 Mbit/s', html.includes('10000 Mbit/s'));
check('瓦片带角色标注', html.includes('（WAN）'));
check('无 NaN/undefined 泄漏', dirty(html) === null, dirty(html));

/* pppoe-wan 是虚拟口：operstate 是 unknown、没有协商速率。旧版把它画成
 * "—"，看着像这个口没状态；现在应当报"已连接"，而且不能拿 eth0 的速率
 * 冒充。 */
(function () {
	var i = html.indexOf('pppoe-wan（WAN）');
	check('瓦片里找得到 pppoe-wan', i > 0);
	var tile = html.slice(Math.max(0, i - 220), i + 20);
	check('虚拟口画成"已连接"而不是"—"', tile.includes('已连接'), tile);
	check('虚拟口不冒充协商速率', !tile.includes('Mbit/s'), tile);
})();

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
check('WAN 排在 LAN 前', html.indexOf('pppoe-wan') < html.indexOf('br-lan'));
check('含 WAN 徽章', html.includes('>WAN</span>'));
check('含速率', html.includes('MB/s') || html.includes('KB/s'));
check('含 sparkline', html.includes('<svg'));
check('docker0 也列出', html.includes('docker0'));
check('无 NaN/undefined 泄漏', dirty(html) === null, dirty(html));

/* 状态列。以前只看 operstate，而 PPP / tun / wireguard 的 operstate 永远是
 * unknown —— 于是"未连接"和"正在跑流量"挂在同一行上，这正是用户报的问题。
 * 现在按后端算好的 link 判，operstate 只作为老后端的兜底。 */
(function () {
	function rowOf(src, name) {
		var i = src.indexOf('<span class="nv-ifname">' + name + '</span>');
		if (i < 0) return '';
		var j = src.indexOf('</tr>', i);
		return src.slice(i, j < 0 ? undefined : j);
	}

	check('pppoe-wan 判运行中（operstate=unknown 但 link=up）',
		rowOf(html, 'pppoe-wan').includes('运行中'), rowOf(html, 'pppoe-wan'));
	check('pppoe-wan 不打印协商速率', !rowOf(html, 'pppoe-wan').includes('M</td>'));
	check('eth0 判运行中并带速率', rowOf(html, 'eth0').includes('运行中 · 10000M'));
	check('awg0 判未连接', rowOf(html, 'awg0').includes('未连接'));

	/* 1.1.2 及之前没有 link 字段，此时必须退回 operstate，不能全判未连接 */
	const legacy = { interfaces: [
		{ name: 'pppoe-wan', role: 'WAN', state: 'unknown', speed: 0, rx: 1, tx: 2, rx_rate: 0, tx_rate: 0 },
		{ name: 'eth0',      role: '',    state: 'up',      speed: 1000, rx: 1, tx: 2, rx_rate: 0, tx_rate: 0 }
	] };
	const lh = API.ifTableHtml(legacy);
	check('老后端：state=up 仍判运行中', rowOf(lh, 'eth0').includes('运行中'));
	check('老后端：state=unknown 判未连接', rowOf(lh, 'pppoe-wan').includes('未连接'));
})();

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
	{ ip: '192.168.1.101', host: 'desktop.lan', mac: 'aa:bb:cc:dd:ee:01', alias: '书房台式机',
	  down: 5000000, up: 900000, down_rate: 4096, up_rate: 512, conns: 7 },
	{ ip: '192.168.1.102', host: '-',           mac: '-',                 alias: '',
	  down: 600,     up: 450,    down_rate: 0,    up_rate: 0,   conns: 1 }
]});
check('渲染表格', b.innerHTML.includes('desktop.lan'));
check('未知设备占位', b.innerHTML.includes('未知设备'));
check('显示 MAC 列', b.innerHTML.includes('aa:bb:cc:dd:ee:01'));
check('显示别名列', b.innerHTML.includes('书房台式机'));
check('别名列带编辑按钮', b.innerHTML.includes('class="nv-edit"') && b.innerHTML.includes('编辑别名'));
check('无 MAC 设备不出现编辑按钮', (b.innerHTML.match(/class="nv-edit"/g) || []).length === 1);
check('无 MAC 设备别名列显示占位', b.innerHTML.includes('nv-alias-none">—'));
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

/* --------------------------------------------- 10. 主题碰撞 / 可读性回归 --- */
/* 这一节盯的是两类"在纯预览页里看不出来、只有装到路由器上才暴露"的问题：
 *
 *   a) 主题（Argon）把自己的全局样式施加到插件的标题上，把标题变成白卡、
 *      让副标题落在页头的主色横带上 —— 字等于隐形。
 *   b) 暗色令牌照搬主题的 --oc-*，而 Argon 的 dark.css 并没有全局重定义
 *      这些变量，暗色下拿到的是亮色值，卡片会变成白的。
 *
 * 都是靠"把值算出来"而不是靠看图断言，才拦得住。
 */
console.log('\n=== 主题碰撞与可读性 ===');

const css = API.CSS;
const darkAt = css.indexOf('@media (prefers-color-scheme: dark) {');
check('CSS 里有暗色媒体查询块', darkAt > 0);
const lightCss = darkAt > 0 ? css.slice(0, darkAt) : css;
const darkCss  = darkAt > 0 ? css.slice(darkAt) : '';

/* var(--name, fallback) -> fallback（够用，不会出现三层） */
function resolve(v) {
	const m = String(v == null ? '' : v).match(/^var\(\s*[^,]+,\s*([\s\S]+)\)$/);
	return m ? resolve(m[1].trim()) : String(v == null ? '' : v).trim();
}
function token(section, name) {
	const m = section.match(new RegExp('--' + name + '\\s*:\\s*([^;]+);'));
	return m ? resolve(m[1]) : null;
}
function hl(c) {
	const m = String(c).match(/^#([0-9a-fA-F]{6})$/);
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return [ (n >> 16) & 255, (n >> 8) & 255, n & 255 ];
}
function lum(rgb) {
	const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
	return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function ratio(fg, bg) {
	const a = hl(fg), b = hl(bg);
	if (!a || !b) return -1;              /* 不是纯色 → 让断言失败并暴露出来 */
	const la = lum(a), lb = lum(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function aa(label, fg, bg, min) {
	const r = ratio(fg, bg);
	check(label, r >= min, fg + ' on ' + bg + ' = ' +
		(r < 0 ? '非纯色（解析不出）' : r.toFixed(2) + ':1') + '，要求 ' + min + ':1');
}

/* ---- 标题必须从主题手里拿回来 ---- */
check('标题重置：h2/h3 去掉卡片外观',
	/\.nv-root h2, \.nv-root h3 \{[\s\S]*?background:\s*none/.test(css) &&
	/\.nv-root h2, \.nv-root h3 \{[\s\S]*?box-shadow:\s*none/.test(css));
check('标题重置：宽度收回（Argon 的 h3 带 width:100%）',
	/\.nv-root h2, \.nv-root h3 \{[\s\S]*?width:\s*auto/.test(css));
check('标题重置：行高用 !important 压过主题的 1.1 !important',
	/\.nv-root h2, \.nv-root h3 \{[\s\S]*?line-height:\s*1\.4\s*!important/.test(css));
check('标题区自带底色，主题的页头横带压不进文字',
	/\.nv-head \{[\s\S]*?background:\s*var\(--nv-card\)/.test(css));

/* ---- 次要文字：不能沿用 Argon 的 --oc-text-muted（#8898aa，白卡上仅 2.95:1） ---- */
check('亮色 --nv-muted 不沿用主题变量（#8898aa 达不到 AA）',
	token(lightCss, 'nv-muted') && !/var\(--oc-text-muted/.test(
		(lightCss.match(/--nv-muted\s*:[^;]+;/) || [''])[0]));
check('暗色 --nv-muted 为固定色', !!hl(token(darkCss, 'nv-muted')));

/* ---- 暗色块不得再引用 --oc-*（Argon dark.css 不重定义它，会拿到亮色值） ---- */
check('暗色块不引用 --oc-*',
	!/var\(--oc-/.test(darkCss),
	(darkCss.match(/var\(--oc-[a-z-]+/) || [''])[0]);
[ 'nv-bg', 'nv-card', 'nv-border', 'nv-text', 'nv-muted' ].forEach(function(t) {
	check('暗色 --' + t + ' 是纯色', !!hl(token(darkCss, t)), String(token(darkCss, t)));
});

/* ---- 实算对比度 ---- */
console.log('  -- 对比度 --');
aa('亮：次要文字 / 卡片', token(lightCss, 'nv-muted'), token(lightCss, 'nv-card'), 4.5);
aa('亮：次要文字 / 页底', token(lightCss, 'nv-muted'), token(lightCss, 'nv-bg'), 4.5);
aa('亮：主文字 / 卡片',   token(lightCss, 'nv-text'),  token(lightCss, 'nv-card'), 7);
aa('暗：次要文字 / 卡片', token(darkCss,  'nv-muted'), token(darkCss,  'nv-card'), 4.5);
aa('暗：次要文字 / 页底', token(darkCss,  'nv-muted'), token(darkCss,  'nv-bg'), 4.5);
aa('暗：主文字 / 卡片',   token(darkCss,  'nv-text'),  token(darkCss,  'nv-card'), 7);

/* 曲线用色刻意写死：它们要跨明暗两种主题标识同一条序列，不能被主题色牵走。
 * 只在 .nv-root 上定义一次、暗色块不重复定义 —— 一旦暗色块里出现它们，
 * 就说明有人开始按模式改数据色了，那不是我们想要的。 */
check('下载/上传数据色为固定值（不跟随主题色）',
	!!hl(token(lightCss, 'nv-dn')) && !!hl(token(lightCss, 'nv-up')));
check('暗色块不重复定义数据色（应沿用 .nv-root 上的同一组）',
	token(darkCss, 'nv-dn') === null && token(darkCss, 'nv-up') === null);

console.log('\n======================================');
console.log('  pass ' + pass + '   fail ' + fail);
console.log('======================================');
process.exit(fail ? 1 : 0);
