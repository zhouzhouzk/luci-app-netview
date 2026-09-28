'use strict';
'require view';
'require rpc';
'require poll';

/*
 * luci-app-netview -- realtime traffic overview
 *
 * Interface cards  : per-interface rx/tx rate + lifetime counters + sparkline
 * Device ranking   : LAN clients ranked by aggregated conntrack traffic
 *
 * Data is kept in memory only (no persistence) -- history holds the last
 * MAXPOINTS samples, i.e. roughly 3 minutes at a 3 second poll interval.
 *
 * Styling follows luci-theme-argon design tokens (--oc-* CSS variables):
 * argon switches between cascade.css and dark.css, both of which redefine the
 * whole --oc-* set, so consuming those variables gives automatic light/dark
 * support. Every var() carries a fallback so the view still looks sane on
 * themes that do not define them.
 */

var callInterfaces = rpc.declare({
	object: 'netview',
	method: 'interfaces'
});

var callDevices = rpc.declare({
	object: 'netview',
	method: 'devices'
});

var POLL_INTERVAL = 3;
var MAXPOINTS = 60;
var MAX_DEVICES = 20;

var history = {};

var CSS = [
	'.nv-root { padding: 2px 0 26px; }',

	/* ---- header ---- */
	'.nv-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 12px;',
	'           margin: 0 0 16px; }',
	'.nv-head h2 { margin: 0; font-size: 19px; font-weight: 500;',
	'              color: var(--oc-text, #525f7f); }',
	'.nv-sub { font-size: 12px; color: var(--oc-text-muted, #8898aa); }',
	'.nv-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;',
	'          background: var(--success, #2dce89); margin-right: 6px;',
	'          vertical-align: baseline; }',

	/* ---- interface cards ---- */
	'.nv-grid { display: grid; gap: 14px;',
	'           grid-template-columns: repeat(auto-fill, minmax(252px, 1fr)); }',
	'.nv-card { background: var(--oc-surface, #fff);',
	'           border: 1px solid var(--oc-border, #dee2e6);',
	'           border-radius: 4px; padding: 14px 16px 12px;',
	'           transition: box-shadow .2s ease, transform .2s ease; }',
	'.nv-card:hover { box-shadow: 3px 4px 8px rgba(94, 114, 228, .16);',
	'                 transform: translateY(-1px); }',

	'.nv-card-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }',
	'.nv-ifname { font-size: 13px; font-weight: 500; color: var(--oc-text, #525f7f);',
	'             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
	'.nv-badge { flex: 0 0 auto; padding: 2px 7px; border-radius: 3px;',
	'            font-size: 10px; font-weight: 500; line-height: 1.4;',
	'            letter-spacing: .04em; color: #fff; }',
	'.nv-badge.nv-wan { background: var(--oc-accent, #5e72e4); }',
	'.nv-badge.nv-lan { background: var(--success, #2dce89); }',

	'.nv-rates { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-bottom: 8px; }',
	'.nv-rate { display: flex; align-items: baseline; gap: 5px; min-width: 0; }',
	'.nv-arrow { font-size: 13px; line-height: 1; }',
	'.nv-c-dn { color: var(--oc-accent, #5e72e4); }',
	'.nv-c-up { color: var(--warning, #fb6340); }',
	'.nv-num { font-size: 16px; font-weight: 500; white-space: nowrap;',
	'          font-variant-numeric: tabular-nums;',
	'          color: var(--oc-text, #525f7f); }',

	'.nv-spark { display: block; width: 100%; height: 44px; margin: 2px 0 10px; }',
	'.nv-spark path { fill: none; }',
	'.nv-spark .nv-a-d { fill: var(--oc-accent-a10, rgba(94, 114, 228, .12)); }',
	'.nv-spark .nv-l-d { stroke: var(--oc-accent, #5e72e4); }',
	'.nv-spark .nv-l-u { stroke: var(--warning, #fb6340); }',

	'.nv-total { display: flex; justify-content: space-between; gap: 10px;',
	'            font-size: 11px; color: var(--oc-text-muted, #8898aa); }',
	'.nv-total b { font-weight: 500; color: var(--oc-text, #525f7f);',
	'              font-variant-numeric: tabular-nums; }',

	/* ---- device table ---- */
	'.nv-h3 { font-size: 15px; font-weight: 500; margin: 26px 0 12px;',
	'         color: var(--oc-text, #525f7f); }',
	'.nv-tablewrap { overflow-x: auto; border-radius: 4px;',
	'                border: 1px solid var(--oc-border, #dee2e6);',
	'                background: var(--oc-surface, #fff); }',
	'.nv-table { width: 100%; border-collapse: collapse; font-size: 13px; }',
	'.nv-table th { text-align: left; padding: 9px 12px; white-space: nowrap;',
	'               font-size: 11px; font-weight: 500; text-transform: uppercase;',
	'               letter-spacing: .04em; color: var(--oc-text-muted, #8898aa);',
	'               background: var(--oc-surface-muted, #f6f9fc);',
	'               border-bottom: 1px solid var(--oc-border, #dee2e6); }',
	'.nv-table td { padding: 9px 12px; vertical-align: middle;',
	'               color: var(--oc-text, #525f7f);',
	'               border-bottom: 1px solid var(--oc-border, #dee2e6); }',
	'.nv-table tbody tr:last-child td { border-bottom: none; }',
	'.nv-table tbody tr { transition: background .15s ease; }',
	'.nv-table tbody tr:hover { background: var(--oc-surface-muted, #f6f9fc); }',
	'.nv-devname { font-weight: 500; }',
	'.nv-tnum { font-variant-numeric: tabular-nums; }',
	'.nv-bar-cell { min-width: 190px; }',
	'.nv-bar { height: 5px; border-radius: 3px; overflow: hidden; margin-bottom: 5px;',
	'          background: var(--oc-border, #dee2e6); }',
	'.nv-bar i { display: block; height: 100%; border-radius: 3px;',
	'            background: var(--oc-accent, #5e72e4);',
	'            transition: width .3s ease; }',

	'.nv-empty { padding: 26px; text-align: center; font-size: 13px;',
	'            border-radius: 4px; border: 1px dashed var(--oc-border, #dee2e6);',
	'            background: var(--oc-surface, #fff);',
	'            color: var(--oc-text-muted, #8898aa); }',
	'.nv-hint { display: block; margin-top: 7px; font-size: 11px; }',
	'.nv-empty code { font-size: 12px; padding: 1px 6px; border-radius: 3px;',
	'                 background: var(--oc-surface-muted, #f6f9fc); }'
].join('\n');

/* ------------------------------------------------------------- formatting --- */

function fmtBytes(n) {
	n = Number(n) || 0;
	var units = [ 'B', 'KB', 'MB', 'GB', 'TB', 'PB' ];
	var i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return (i === 0 ? Math.round(n) : n.toFixed(2)) + ' ' + units[i];
}

function fmtRate(n) {
	return fmtBytes(n) + '/s';
}

function esc(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/* -------------------------------------------------------------- sparkline --- */

function sparkline(points) {
	var W = 200, H = 44;

	if (!points || points.length < 2)
		return '<svg class="nv-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"></svg>';

	var max = 1;
	points.forEach(function(p) {
		if (p.d > max) max = p.d;
		if (p.u > max) max = p.u;
	});

	function line(key) {
		var n = points.length, out = [];
		for (var i = 0; i < n; i++) {
			var x = (i / (n - 1)) * W;
			var y = H - 2 - (points[i][key] / max) * (H - 5);
			out.push((i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1));
		}
		return out.join(' ');
	}

	var downLine = line('d');

	return '<svg class="nv-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
		'<path class="nv-a-d" d="' + downLine + ' L' + W + ',' + H + ' L0,' + H + ' Z"/>' +
		'<path class="nv-l-d" d="' + downLine + '" stroke-width="1.5" ' +
			'vector-effect="non-scaling-stroke"/>' +
		'<path class="nv-l-u" d="' + line('u') + '" stroke-width="1.5" ' +
			'vector-effect="non-scaling-stroke"/>' +
	'</svg>';
}

/* ---------------------------------------------------------- interface view --- */

function renderInterfaces(box, data) {
	if (!data || !data.interfaces)
		return;

	var order = { 'WAN': 0, 'LAN': 1, '': 2 };
	var list = data.interfaces.slice(0).sort(function(a, b) {
		var oa = order[a.role] != null ? order[a.role] : 2;
		var ob = order[b.role] != null ? order[b.role] : 2;
		if (oa !== ob) return oa - ob;
		return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
	});

	list.forEach(function(it) {
		var h = history[it.name] || (history[it.name] = []);
		h.push({ d: Number(it.rx_rate) || 0, u: Number(it.tx_rate) || 0 });
		while (h.length > MAXPOINTS) h.shift();
	});

	var html = '';
	list.forEach(function(it) {
		var badge = it.role
			? '<span class="nv-badge nv-' + it.role.toLowerCase() + '">' + esc(it.role) + '</span>'
			: '';

		html += '<div class="nv-card">' +
			'<div class="nv-card-hd">' +
				'<span class="nv-ifname">' + esc(it.name) + '</span>' + badge +
			'</div>' +
			'<div class="nv-rates">' +
				'<div class="nv-rate"><span class="nv-arrow nv-c-dn">\u2193</span>' +
					'<span class="nv-num">' + fmtRate(it.rx_rate) + '</span></div>' +
				'<div class="nv-rate"><span class="nv-arrow nv-c-up">\u2191</span>' +
					'<span class="nv-num">' + fmtRate(it.tx_rate) + '</span></div>' +
			'</div>' +
			sparkline(history[it.name]) +
			'<div class="nv-total">' +
				'<span>累计收 <b>' + fmtBytes(it.rx) + '</b></span>' +
				'<span>累计发 <b>' + fmtBytes(it.tx) + '</b></span>' +
			'</div>' +
		'</div>';
	});

	box.innerHTML = html || '<div class="nv-empty">未检测到网络接口</div>';
}

/* ------------------------------------------------------------- device view --- */

function renderDevices(box, data) {
	if (!data)
		return;

	if (data.error === 'conntrack_unavailable') {
		box.innerHTML = '<div class="nv-empty">内核 conntrack 表不可用，无法统计设备流量</div>';
		return;
	}

	/* Netfilter defaults to acct=0 and only OpenWrt's
	 * /etc/sysctl.d/11-nf-conntrack.conf turns it on; without it conntrack
	 * lines carry no byte counters at all. Report that instead of drawing a
	 * table full of zeros. */
	if (data.error === 'conntrack_acct_disabled') {
		box.innerHTML = '<div class="nv-empty">' +
			'内核 conntrack 未开启流量记账，无法统计设备流量' +
			'<span class="nv-hint">在路由器上执行 ' +
			'<code>sysctl -w net.netfilter.nf_conntrack_acct=1</code> 即可恢复' +
			'（只对之后新建的连接生效）</span></div>';
		return;
	}

	var list = (data.devices || []).slice(0).sort(function(a, b) {
		return ((b.down + b.up) - (a.down + a.up));
	}).slice(0, MAX_DEVICES);

	if (!list.length) {
		box.innerHTML = '<div class="nv-empty">暂无活动的 NAT / 转发连接</div>';
		return;
	}

	var max = (list[0].down + list[0].up) || 1;

	var html = '<div class="nv-tablewrap"><table class="nv-table"><thead><tr>' +
		'<th>设备</th><th>IP</th><th>下行</th><th>上行</th><th>累计流量</th><th>连接数</th>' +
	'</tr></thead><tbody>';

	list.forEach(function(d) {
		var total = d.down + d.up;
		var pct = Math.max(2, Math.min(100, (total / max) * 100));

		html += '<tr>' +
			'<td class="nv-devname">' + esc(d.host && d.host !== '-' ? d.host : '未知设备') + '</td>' +
			'<td class="nv-tnum">' + esc(d.ip) + '</td>' +
			'<td class="nv-tnum nv-c-dn">' + fmtRate(d.down_rate) + '</td>' +
			'<td class="nv-tnum nv-c-up">' + fmtRate(d.up_rate) + '</td>' +
			'<td class="nv-bar-cell">' +
				'<div class="nv-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
				'<span class="nv-tnum">' + fmtBytes(total) + '</span>' +
			'</td>' +
			'<td class="nv-tnum">' + (Number(d.conns) || 0) + '</td>' +
		'</tr>';
	});

	html += '</tbody></table></div>';
	box.innerHTML = html;
}

/* -------------------------------------------------------------------- view --- */

return view.extend({
	render: function() {
		var ifBox = E('div', { 'class': 'nv-grid' });
		var devBox = E('div', { 'class': 'nv-devbox' });

		var root = E('div', { 'class': 'nv-root' }, [
			E('style', {}, CSS),
			E('div', { 'class': 'nv-head' }, [
				E('h2', {}, '实时流量'),
				E('span', { 'class': 'nv-sub' }, [
					E('span', { 'class': 'nv-dot' }),
					'每 ' + POLL_INTERVAL + ' 秒刷新 · 曲线保留最近 ' +
						(MAXPOINTS * POLL_INTERVAL) + ' 秒'
				])
			]),
			ifBox,
			E('h3', { 'class': 'nv-h3' }, '设备排行'),
			devBox
		]);

		function refresh() {
			return Promise.all([
				callInterfaces().catch(function() { return null; }),
				callDevices().catch(function() { return null; })
			]).then(function(res) {
				renderInterfaces(ifBox, res[0]);
				renderDevices(devBox, res[1]);
			});
		}

		refresh();
		poll.add(refresh, POLL_INTERVAL);
		/* LuCI's built-in poll only self-starts once its ticker exists, while
		 * the standalone poll.js older releases shipped never auto-started at
		 * all. Calling start() explicitly is idempotent and covers both. */
		if (typeof poll.start === 'function')
			poll.start();

		return root;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
