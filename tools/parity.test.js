/* Cross-check that the preview page carries the same CSS and the same render
 * helpers as the shipped LuCI view -- the preview is a hand-maintained copy, so
 * drift is the real risk. Only the preview-only .nv-force-dark block is
 * expected to differ.
 *
 * Note: only the *render layer* of the preview is evaluated. Its top-level
 * simulation (prefill loop + refresh() + setInterval) would otherwise mutate
 * ifHist / heroHist / yScale at load time and make the two sides incomparable.
 */
const fs = require('fs');
const vm = require('vm');

const VIEW = require('path').join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'netview', 'overview.js');
const PREV = require('path').join(__dirname, '..', 'preview', 'overview-preview.html');

const viewSrc = fs.readFileSync(VIEW, 'utf8');
const prevRaw = fs.readFileSync(PREV, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
	if (cond) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

/* first index where two strings differ, with a little context */
function diffAt(a, b) {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++)
		if (a[i] !== b[i])
			return '第 ' + i + ' 字符起不同\n         视图 ...' + a.slice(Math.max(0, i - 40), i + 70) +
			       '\n         预览 ...' + b.slice(Math.max(0, i - 40), i + 70);
	return '长度不同 视图=' + a.length + ' 预览=' + b.length;
}
function same(label, a, b) {
	check(label, a === b, a === b ? '' : diffAt(a, b));
}

/* ---- 1. preview inline script must parse ---------------------------------- */
const scripts = [...prevRaw.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
check('预览页含 1 个 script 块', scripts.length === 1, 'found ' + scripts.length);
check('script 标签配对',
	(prevRaw.match(/<script>/g) || []).length === (prevRaw.match(/<\/script>/g) || []).length);

const prevSrc = scripts[0];
try { new vm.Script(prevSrc); check('预览脚本语法通过', true); }
catch (e) { check('预览脚本语法通过', false, e.message); }

/* ---- 2. isolate the preview's render layer -------------------------------- */
const MARKER = '以下为预览专用的模拟数据层';
const mi = prevSrc.indexOf(MARKER);
check('预览页标出了模拟数据层的分界', mi > 0);
const cut = prevSrc.lastIndexOf('/* ===', mi);
const renderLayer = prevSrc.slice(0, cut);
check('渲染层不含模拟代码', !renderLayer.includes('setInterval') && !renderLayer.includes('sampleIfaces'));

/* ---- 3. CSS parity -------------------------------------------------------- */
function extractCss(src, label) {
	const start = src.indexOf('var CSS = [');
	const end = src.indexOf("].join('\\n');", start);
	if (start < 0 || end < 0) throw new Error('没有在 ' + label + ' 里找到 CSS 数组');
	return src.slice(start, end + 1);
}
function cssText(block) {
	// eslint-disable-next-line no-new-func
	const arr = new Function('C_DOWN', 'C_UP', block + '\n; return CSS;')('#4a9df5', '#8b5cf6');
	return Array.isArray(arr) ? arr.join('\n') : arr;
}

const viewCss = cssText(extractCss(viewSrc, 'view'));
const prevCss = cssText(extractCss(renderLayer, 'preview'));

/* drop the preview-only override block, keeping everything else intact */
function stripForceDark(css) {
	const out = [];
	let depth = 0, skipping = false;
	for (const line of css.split('\n')) {
		if (!skipping && /\.nv-root\.nv-force-dark\s*\{/.test(line)) { skipping = true; depth = 1; continue; }
		if (skipping) {
			depth += (line.match(/\{/g) || []).length;
			depth -= (line.match(/\}/g) || []).length;
			if (depth <= 0) skipping = false;
			continue;
		}
		out.push(line);
	}
	return out.join('\n');
}

const prevStripped = stripForceDark(prevCss);
check('确实剥掉了 force-dark 覆盖块', prevStripped.length < prevCss.length);
same('预览 CSS 与视图 CSS 完全一致（剥掉 force-dark 后）', viewCss, prevStripped);

/* ---- 3b. Argon 测试页必须与预览页同源 ------------------------------------ */
/* preview/argon-harness.html 是 tools/argon-harness.js 生成的。它把预览页的
 * .nv-root 整块搬进 Argon 骨架，所以"搬过去的那一段"必须和预览页逐字节一致 ——
 * 否则改了预览页却忘了重新生成，测试页就会悄悄停留在旧界面上，
 * 而它恰好是用来判断"装到路由器上长什么样"的，误导性最强。
 */
const HARNESS = require('path').join(__dirname, '..', 'preview', 'argon-harness.html');

if (!fs.existsSync(HARNESS)) {
	check('Argon 测试页存在', false, '跑 node tools/argon-harness.js 生成');
} else {
	const harness = fs.readFileSync(HARNESS, 'utf8');
	check('Argon 测试页存在', true);
	check('Argon 测试页标明了是生成物', harness.includes('由 tools/argon-harness.js 生成'));

	/* 骨架照抄 header.ut，这两处缺一个就不算复现了 */
	check('测试页有 Argon 页头骨架', harness.includes('<header class="bg-primary">'));
	check('测试页有 Argon 主内容容器', harness.includes('<div id="maincontent">'));

	/* 样式挂法与 Argon 一致：cascade 常驻 + dark 挂 media 查询 */
	check('测试页挂 cascade.css', harness.includes('argon/css/cascade.css'));
	check('测试页的 dark.css 挂 prefers-color-scheme',
		harness.includes('argon/css/dark.css" media="(prefers-color-scheme: dark)"'));

	/* 搬运过来的 .nv-root 必须一模一样 */
	const A = '<!-- ↓↓↓ 以下 .nv-root 由 overview-preview.html 原样搬运 ↓↓↓ -->\n';
	const B = '\n\t\t\t\t<!-- ↑↑↑ .nv-root 结束 ↑↑↑ -->';
	const hi = harness.indexOf(A), hj = harness.indexOf(B);
	check('测试页里有搬运标记', hi > 0 && hj > hi);

	const pi = prevRaw.indexOf('<main class="pg-wrap">\n');
	const pj = prevRaw.indexOf('\n</main>\n');
	check('预览页里有对应区间', pi > 0 && pj > pi);

	if (hi > 0 && hj > hi && pi > 0 && pj > pi) {
		const inHarness = harness.slice(hi + A.length, hj);
		const inPreview = prevRaw.slice(pi + '<main class="pg-wrap">\n'.length, pj);
		same('测试页搬运的 .nv-root 与预览页逐字节一致（不一致就重新生成）',
			inPreview, inHarness);
	}

	/* 上面只盯住了 .nv-root 那段静态骨架。渲染函数和 CSS 数组在 <script>
	 * 里 —— 改了预览页却忘了重新生成时，骨架照样一致，测试页却会停在旧
	 * 界面上，而它正是用来判断"装到路由器上长什么样"的。所以脚本里的渲染
	 * 层也一起比。 */
	const hScripts = [...harness.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
	const hMain = hScripts.filter(s => s.includes(MARKER)).pop();
	check('测试页里带完整脚本', !!hMain);
	if (hMain) {
		const hCut = hMain.lastIndexOf('/* ===', hMain.indexOf(MARKER));
		same('测试页里的渲染层与预览页一致（不一致就重新生成）',
			renderLayer, hMain.slice(0, hCut));
	}
}

/* ---- 4. load both render layers ------------------------------------------ */
function loadViewApi(src) {
	let s = src.replace(/^'require [^']*';$/gm, '');
	s = s.replace('return view.extend(', 'view.extend(');
const EXPORT = '\n;return { sideHtml, ifTableHtml, chartSvg, sparkSvg, aggregate,' +
	' renderDevices, fmtBytes, fmtRate, fmtDuration, fmtProto, fmtSpeed, truthy,' +
	' connHtml, fmtInt, svcColor, CSS };\n';
const f = new Function('view', 'rpc', 'poll', 'E', s + EXPORT);
	return f({ extend: o => o }, { declare: () => () => Promise.resolve(null) },
	         { add: () => {}, start: () => {} }, () => ({}));
}

function loadPreviewApi(layer) {
	const EXPORT = '\n;return { sideHtml, ifTableHtml, chartSvg, sparkSvg, aggregate,' +
		' renderDevices, fmtBytes, fmtRate, fmtDuration, fmtProto, fmtSpeed, truthy,' +
		' connHtml, fmtInt, svcColor, CSS };\n';
	return new Function(layer + EXPORT)();
}

let viewApi, prevApi;
try { viewApi = loadViewApi(viewSrc); check('视图渲染层可加载', true); }
catch (e) { check('视图渲染层可加载', false, e.message); }
try { prevApi = loadPreviewApi(renderLayer); check('预览渲染层可加载', true); }
catch (e) { check('预览渲染层可加载', false, e.message); }

/* ---- 5. identical output for identical input ------------------------------ */
if (viewApi && prevApi) {
	const IF = {
		wan: 'eth0', lan: 'br-lan', clients: 12,
		wan_info: { connected: true, uptime: 411567, proto: 'dhcp', device: 'eth0',
		            ipv4: '192.168.9.231', mask: 24, ipv6: '2408:8207:8c1f:2a00::1',
		            gateway: '192.168.9.1', dns: '192.168.9.1 223.5.5.5', dns_auto: true },
		interfaces: [
			{ name: 'eth0', role: 'WAN', roles: 'WAN,WAN6', state: 'up', speed: 10000,
			  rx: 48234496000, tx: 5199257600, rx_rate: 5242880, tx_rate: 314572 },
			{ name: 'br-lan', role: 'LAN', roles: 'LAN', state: 'up', speed: 10000,
			  rx: 3187671040, tx: 2684354560, rx_rate: 1048576, tx_rate: 262144 },
			{ name: 'docker0', role: '', roles: '', state: 'down', speed: 0,
			  rx: 184320, tx: 40960, rx_rate: 0, tx_rate: 0 }
		]
	};

	same('sideHtml 输出一致', viewApi.sideHtml(IF), prevApi.sideHtml(IF));
	same('ifTableHtml 输出一致', viewApi.ifTableHtml(IF), prevApi.ifTableHtml(IF));

	const hist = [];
	for (let i = 0; i < 60; i++) hist.push({ d: 1.7e6 * (1 + Math.sin(i / 9)), u: 3e5 });
	same('chartSvg 输出一致', viewApi.chartSvg(hist), prevApi.chartSvg(hist));
	same('sparkSvg 输出一致', viewApi.sparkSvg(hist), prevApi.sparkSvg(hist));

	const boxA = { innerHTML: '' }, boxB = { innerHTML: '' };
	const dev = { devices: [
		{ ip: '192.168.9.101', host: 'MacBook-Pro.lan', mac: 'aa:bb:cc:dd:ee:01', alias: '我的 MacBook',
		  down: 8.4e6, up: 9.1e5, down_rate: 2.4e5, up_rate: 3.4e4, conns: 42 },
		{ ip: '192.168.9.133', host: '-', mac: '-', alias: '',
		  down: 4.1e5, up: 7.4e4, down_rate: 0, up_rate: 0, conns: 6 }
	] };
	viewApi.renderDevices(boxA, dev);
	prevApi.renderDevices(boxB, dev);
	same('renderDevices 输出一致', boxA.innerHTML, boxB.innerHTML);

	same('aggregate 一致', JSON.stringify(viewApi.aggregate(IF.interfaces)),
		JSON.stringify(prevApi.aggregate(IF.interfaces)));

	const SESS = { count: 187234, max: 262144, source: 'port', services: [
		{ name: 'HTTPS', count: 812 }, { name: 'QUIC', count: 431 },
		{ name: 'DNS', count: 129 }, { name: '其他', count: 210 }
	] };
	same('connHtml 输出一致', viewApi.connHtml(SESS), prevApi.connHtml(SESS));
	same('connHtml 输出一致（null）', viewApi.connHtml(null), prevApi.connHtml(null));
	same('connHtml 输出一致（空服务）',
		viewApi.connHtml({ count: 5, max: 100, services: [] }),
		prevApi.connHtml({ count: 5, max: 100, services: [] }));
	same('fmtInt 一致', [ 0, 999, 187234, -5 ].map(viewApi.fmtInt).join('|'),
		[ 0, 999, 187234, -5 ].map(prevApi.fmtInt).join('|'));

	const probes = [
		[ '空 WAN', { interfaces: [], clients: 0, wan: 'wan', wan_info: {} } ],
		[ '未连接', { interfaces: [], clients: 3, wan: 'pppoe-wan',
		              wan_info: { connected: false, proto: 'pppoe' } } ],
		[ 'connected 为字符串 1', { interfaces: [], clients: 1, wan: 'wan',
		                            wan_info: { connected: '1', proto: 'static', ipv4: '10.0.0.2' } } ]
	];
	probes.forEach(function(p) {
		same('sideHtml 一致（' + p[0] + '）', viewApi.sideHtml(p[1]), prevApi.sideHtml(p[1]));
	});

	/* formatting helpers must not have drifted either */
	[ 'fmtBytes', 'fmtRate', 'fmtDuration', 'fmtProto', 'fmtSpeed' ].forEach(function(fn) {
		const args = {
			fmtBytes: [ 0, 1023, 1048576, 1.5e9 ],
			fmtRate:  [ 1536, 0 ],
			fmtDuration: [ 0, 59, 3600, 411567 ],
			fmtProto: [ 'dhcp', 'pppoe', 'static', '', 'none', 'weird' ],
			fmtSpeed: [ 0, 10000 ]
		}[fn];
		const a = args.map(function(x) { return String(viewApi[fn](x)); }).join('|');
		const b = args.map(function(x) { return String(prevApi[fn](x)); }).join('|');
		same(fn + ' 一致', a, b);
	});
}

console.log('\n======================================');
console.log('  pass ' + pass + '   fail ' + fail);
console.log('======================================');
process.exit(fail ? 1 : 0);
