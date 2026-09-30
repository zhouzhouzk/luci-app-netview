'use strict';
'require view';
'require rpc';
'require poll';

/*
 * luci-app-netview -- realtime traffic overview
 *
 * Layout (modelled on the iStoreOS QuickStart page):
 *
 *   +---------------------------------------+----------------------+
 *   | 流量统计   [download][upload]   now:  |  已连接互联网          |
 *   |                                       |  N 已连接设备          |
 *   |        large gradient area chart      |  IP 地址 / DNS        |
 *   |                                       |  网络接口状态 (tiles)  |
 *   +---------------------------------------+----------------------+
 *   | 网络接口 -- per-interface rate + sparkline + lifetime counters |
 *   | 设备流量排行 -- LAN clients ranked by aggregated conntrack bytes|
 *
 * The hero chart aggregates all WAN-role interfaces (falling back to every
 * interface when no WAN could be identified), so "traffic" here means what
 * actually crosses the uplink.
 *
 * History lives in memory only: MAXPOINTS samples, i.e. ~3 minutes at a 3
 * second poll interval.
 *
 * Styling is self-contained: every colour resolves through a --nv-* custom
 * property declared on .nv-root, whose default is itself var(--oc-*, <light
 * value>). Argon (and any theme that defines --oc-surface / --oc-text / ...)
 * therefore still drives surfaces and text, while the iStoreOS-inspired
 * fallbacks keep the page looking right on themes that define nothing.
 * A prefers-color-scheme block swaps the fallbacks for dark values.
 */

var callInterfaces = rpc.declare({
	object: 'netview',
	method: 'interfaces'
});

var callDevices = rpc.declare({
	object: 'netview',
	method: 'devices'
});

var callSetAlias = rpc.declare({
	object: 'netview',
	method: 'set_alias',
	params: [ 'mac', 'name' ]
});

var callSessions = rpc.declare({
	object: 'netview',
	method: 'sessions'
});

var POLL_INTERVAL = 3;
var MAXPOINTS = 60;          /* 60 * 3 s = 3 minutes */
var MAX_DEVICES = 20;
var devEditing = false;      /* 编辑别名期间暂停设备表重绘，防止轮询打断输入 */

/* iStoreOS-inspired data colours. Deliberately fixed rather than derived from
 * the theme accent: they identify the two series across light and dark. */
var C_DOWN = '#4a9df5';
var C_UP   = '#8b5cf6';

/* Palette for the connection breakdown. Fixed hues rather than theme ramps:
 * the segments must stay distinguishable in light and dark, and each one is
 * named in the legend directly under the bar. 其他 is the merged tail and
 * always grey, so the bar reads the same way on every poll. All five clear
 * 3:1 against the light card and the dark one -- they carry information, so
 * they are held to the non-text contrast floor rather than to "looks fine". */
var SVC_COLORS = [ '#3b82f6', '#8b5cf6', '#16a34a', '#d97706', '#db2777' ];
var SVC_REST   = '#64748b';

/* A floor keeps an idle link from scaling its own noise to full height. */
var SCALE_FLOOR = 32 * 1024;

var heroHist = [];           /* aggregate samples */
var ifHist = {};             /* per-interface samples */
var yScale = 0;              /* smoothed vertical scale (B/s) */

var CSS = [
	/* ---- tokens ---- */
	'.nv-root {',
	'  --nv-bg:     var(--oc-surface-muted, #f2f4f8);',
	'  --nv-card:   var(--oc-surface, #ffffff);',
	'  --nv-border: var(--oc-border, #ecedf3);',
	'  --nv-text:   var(--oc-text, #2b3445);',
	/* 次要文字不再跟随 --oc-text-muted：Argon 给的是 #8898aa，在白卡上只有
	 * 2.95:1、在页底上 2.70:1，小字号中文看着就是一片糊 —— 达不到正文
	 * AA 要求的 4.5:1。下面这两个值都在各自的底上实算过：
	 *   亮 #5f6d84 → 白卡 5.24 / Argon 浅底 4.96 / Argon 页底 4.80 / 无主题页底 4.76
	 *   暗 #8a93a5 → 卡片 5.33 / 页底 5.85
	 * 最差也有 4.76:1。仍明显弱于主文字（亮 12.50、暗 11.99），层次还在。 */
	'  --nv-muted:  #5f6d84;',
	'  --nv-dn:     ' + C_DOWN + ';',
	'  --nv-up:     ' + C_UP + ';',
	'  --nv-ok:     #22c55e;',
	'  --nv-off:    #b9c0cd;',
	'  --nv-radius: 14px;',
	'  --nv-shadow: 0 1px 2px rgba(16,24,40,.04), 0 10px 28px rgba(16,24,40,.06);',
	'  color: var(--nv-text); font-size: 13px; line-height: 1.5;',
	'  padding: 2px 0 28px;',
	'}',
	/* 暗色这一套**不沿用 --oc-***，全部写死。
	 * Argon 的 header.ut 是「cascade.css 常驻 + 按需叠加 dark.css」，
	 * 而 dark.css 并没有全局重定义 --oc-*（只在 openclash 那页重定义了一套）。
	 * 也就是说暗色下全局的 --oc-surface 仍然是 #fff —— 照搬就会把卡片画成
	 * 白色、边框画成浅灰，暗色模式整个是坏的。 */
	'@media (prefers-color-scheme: dark) {',
	'  .nv-root {',
	'    --nv-bg:     #14161c;',
	'    --nv-card:   #1c1f27;',
	'    --nv-border: #2b3038;',
	'    --nv-text:   #d8dce4;',
	'    --nv-muted:  #8a93a5;',
	'    --nv-off:    #5b6373;',
	'    --nv-shadow: 0 1px 2px rgba(0,0,0,.35), 0 10px 28px rgba(0,0,0,.28);',
	'  }',
	'}',

	/* ---- generic card ---- */
	'.nv-card { background: var(--nv-card); border: 1px solid var(--nv-border);',
	'           border-radius: var(--nv-radius); box-shadow: var(--nv-shadow); }',

	/* ---- page head ---- */
	/* 主题的全局标题样式会改造这里，必须先收回控制权。以 Argon 为例：
	 *
	 *   1) h2 { padding:1rem 1.25rem; background:var(--white); box-shadow:… }
	 *      —— 它把**每一个** h2 都当成"页面标题卡片"。而本插件的标题是
	 *      .nv-head 这个 flex 容器里的 flex item，套上卡片后会被收缩成一行
	 *      窄白卡，副标题被挤到卡片外面 —— 正好落在 Argon 页头那条 2rem 高的
	 *      主色横带（header::after）上。#8898aa 叠 #5e72e4 只有 1.42:1，
	 *      那行字基本等于隐形，看着就像"字缺了一半"。
	 *   2) h3 { display:block; width:100%; background:var(--white) }
	 *      —— 同样会把区块标题撑成整条白卡，把右边的说明挤成两行。
	 *   3) h1..h6 { line-height: 1.1 !important }
	 *      —— 中文标题会被压扁。要压掉对方的 !important 只能也用 !important
	 *      （这里选择器权重更高，且本样式在 <body> 内、文档序更靠后）。
	 *
	 * 另外把标题区做成卡片：无论主题在背后画什么横带，标题和副标题都落在
	 * 确定的底色上。这既符合 Argon 自己"页面标题即卡片"的惯例，也让它成为
	 * 主题无关的解法 —— 不用去猜某个主题的横带有多高。 */
	'.nv-root h2, .nv-root h3 { margin: 0; padding: 0; width: auto; display: block;',
	'                           background: none; border: 0; box-shadow: none;',
	'                           border-radius: 0; color: inherit;',
	'                           line-height: 1.4 !important; }',
	'.nv-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px 12px;',
	'           margin: 0 0 16px; padding: 13px 18px;',
	'           background: var(--nv-card); border: 1px solid var(--nv-border);',
	'           border-radius: var(--nv-radius); box-shadow: var(--nv-shadow); }',
	'.nv-head h2 { font-size: 17px; font-weight: 600; letter-spacing: .01em; }',
	'.nv-head .nv-sub { font-size: 12px; color: var(--nv-muted); }',
	'.nv-live { display: inline-block; width: 6px; height: 6px; border-radius: 50%;',
	'           background: var(--nv-ok); margin-right: 5px; vertical-align: 1px; }',

	/* ---- hero grid ---- */
	/* 不用 align-items:start：左列必须拉伸，图表下面那张卡才能吃掉与右列的
	 * 高度差。只用内容高度的话 flex-grow 无从发力，留白还在。 */
	'.nv-hero { display: grid; gap: 16px;',
	'           grid-template-columns: minmax(0, 1fr) 364px; }',
	'@media (max-width: 1000px) { .nv-hero { grid-template-columns: minmax(0, 1fr); } }',

	/* ---- hero chart ---- */
	'.nv-chartcard { padding: 16px 18px 10px; }',
	'.nv-chart-hd { display: flex; align-items: center; flex-wrap: wrap;',
	'               gap: 6px 14px; margin-bottom: 4px; }',
	'.nv-chart-title { font-size: 14.5px; font-weight: 600; }',
	'.nv-legend { display: flex; align-items: center; gap: 16px;',
	'             font-size: 12px; color: var(--nv-muted); }',
	'.nv-lg { display: inline-flex; align-items: center; gap: 7px; }',
	'.nv-lg i { display: inline-block; width: 22px; height: 3px; border-radius: 2px; }',
	'.nv-lg i.nv-dn { background: var(--nv-dn); }',
	'.nv-lg i.nv-up { background: var(--nv-up); }',
	'.nv-now { margin-left: auto; display: flex; gap: 18px;',
	'          font-size: 11.5px; color: var(--nv-muted); white-space: nowrap; }',
	'.nv-now b { margin-left: 5px; font-weight: 600; color: var(--nv-text);',
	'            font-variant-numeric: tabular-nums; }',

	'.nv-chartwrap { margin: 0 -4px; }',
	'.nv-chart { display: block; width: 100%; height: 292px; }',
	'.nv-chart-empty { height: 292px; display: flex; align-items: center;',
	'                  justify-content: center; font-size: 12.5px;',
	'                  color: var(--nv-muted); }',

	/* ---- connection overview ---- */
	/* The side column stacks four cards and ends up taller than the chart, so
	 * the grid row is sized by the side column and the left column would stop
	 * short, leaving a hole under the chart. .nv-col is a flex column and this
	 * card takes the slack via flex-grow, which equalises the two columns
	 * without pinning the chart to a magic height. */
	'.nv-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }',
	'.nv-conn { flex: 1 1 auto; display: flex; flex-direction: column;',
	'          padding: 15px 17px 16px; min-height: 148px; }',
	'.nv-conn-hd { display: flex; align-items: baseline; flex-wrap: wrap;',
	'              gap: 4px 10px; margin-bottom: 14px; }',
	'.nv-conn-hd b { font-size: 13px; font-weight: 600; }',
	'.nv-conn-hd span { font-size: 11.5px; color: var(--nv-muted); }',
	'.nv-conn-body { flex: 1 1 auto; display: flex; align-items: center;',
	'               gap: 26px; flex-wrap: wrap; }',
	'.nv-gauge { flex: 0 0 172px; }',
	'.nv-gauge-n { font-size: 25px; font-weight: 600; line-height: 1.05;',
	'             font-variant-numeric: tabular-nums; }',
	'.nv-gauge-n i { font-style: normal; font-size: 12px; font-weight: 400;',
	'               color: var(--nv-muted); margin-left: 5px; }',
	'.nv-gauge-s { margin-top: 6px; font-size: 11.5px; color: var(--nv-muted); }',
	/* taller than the table's inline bar: this one is the page's only read on
	 * how full the connection table is, so it has to be readable at a glance */
	'.nv-conn .nv-track { height: 8px; border-radius: 4px; margin: 10px 0 0; }',
	'.nv-dist { flex: 1 1 220px; min-width: 0; }',
	'.nv-stack { display: flex; height: 12px; border-radius: 6px;',
	'           overflow: hidden; background: var(--nv-bg); }',
	'.nv-stack i { display: block; height: 100%; }',
	'.nv-keys { display: grid; gap: 7px 20px; margin-top: 13px;',
	'           grid-template-columns: repeat(2, minmax(0, 1fr)); }',
	'.nv-key { display: flex; align-items: center; gap: 7px; min-width: 0;',
	'          font-size: 11.5px; }',
	'.nv-key i { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 2px; }',
	'.nv-key em { font-style: normal; min-width: 0; overflow: hidden;',
	'            text-overflow: ellipsis; white-space: nowrap; }',
	'.nv-key b { margin-left: auto; padding-left: 6px; font-weight: 600;',
	'           color: var(--nv-muted); font-variant-numeric: tabular-nums; }',

	/* ---- side column ---- */
	'.nv-side { display: flex; flex-direction: column; gap: 16px; }',

	'.nv-mini { display: flex; align-items: center; gap: 13px; padding: 15px 17px; }',
	'.nv-ico { flex: 0 0 auto; width: 36px; height: 36px; border-radius: 11px;',
	'          display: flex; align-items: center; justify-content: center;',
	'          color: #fff; }',
	'.nv-ico.violet { background: linear-gradient(135deg, #9b7bf8, #7c4dee); }',
	'.nv-ico.cyan   { background: linear-gradient(135deg, #34d8ee, #0ea5c9); }',
	'.nv-ico.red    { background: linear-gradient(135deg, #fb8a8a, #ef4444); }',
	'.nv-mini-t { font-size: 13.5px; font-weight: 600; }',
	'.nv-mini-s { font-size: 11px; color: var(--nv-muted); margin-top: 1px; }',
	'.nv-mini-n { font-size: 23px; font-weight: 600; line-height: 1.1;',
	'             font-variant-numeric: tabular-nums; }',

	'.nv-info { padding: 15px 17px 17px; }',
	'.nv-info-hd { font-size: 13px; font-weight: 600; margin-bottom: 11px;',
	'              display: flex; align-items: center; gap: 8px; }',
	'.nv-info-hd .nv-tag { font-size: 10.5px; font-weight: 500; color: var(--nv-muted);',
	'                      border: 1px solid var(--nv-border); border-radius: 999px;',
	'                      padding: 1px 8px; }',
	'.nv-row { display: flex; gap: 9px; font-size: 12.5px; margin-bottom: 9px;',
	'          align-items: baseline; }',
	'.nv-row:last-child { margin-bottom: 0; }',
	'.nv-row-k { flex: 0 0 auto; min-width: 46px; color: var(--nv-muted); }',
	'.nv-row-v { min-width: 0; word-break: break-all; }',
	'.nv-row-v em { font-style: normal; color: var(--nv-muted); }',

	/* ---- interface tiles ---- */
	'.nv-tiles { display: grid; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }',
	'.nv-tile { display: flex; align-items: center; gap: 7px; padding: 9px 10px;',
	'           border-radius: 11px; background: var(--nv-bg);',
	'           border: 1px solid var(--nv-border); }',
	'.nv-tile-ico { flex: 0 0 auto; color: var(--nv-muted); line-height: 0; }',
	/* "eth0（WAN,WAN6）" needs ~90px and a half column only offers ~105px of
	 * content box, so the glyph stays at 20px and the name at 10px */
	'.nv-tile-ico svg { width: 20px; height: 20px; }',
	'.nv-tile-t { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;',
	'             white-space: nowrap; }',
	'.nv-tile-s { font-size: 10px; color: var(--nv-muted); margin-top: 1px;',
	'             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',

	/* ---- sections ---- */
	'.nv-sec { margin-top: 18px; }',
	'.nv-sec-hd { display: flex; align-items: baseline; gap: 10px; margin: 0 2px 10px; }',
	/* 卡片外观由上面「page head」里的 .nv-root h2/h3 全局重置收回 */
	'.nv-sec-hd h3 { font-size: 14px; font-weight: 600; }',
	'.nv-sec-hd span { font-size: 11.5px; color: var(--nv-muted); }',

	/* ---- tables ---- */
	'.nv-tablewrap { overflow-x: auto; border-radius: var(--nv-radius);',
	'                background: var(--nv-card); border: 1px solid var(--nv-border);',
	'                box-shadow: var(--nv-shadow); }',
	'.nv-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }',
	'.nv-table th { text-align: left; padding: 10px 14px; white-space: nowrap;',
	'               font-size: 11px; font-weight: 600; letter-spacing: .03em;',
	'               color: var(--nv-muted); background: var(--nv-bg);',
	'               border-bottom: 1px solid var(--nv-border); }',
	'.nv-table td { padding: 10px 14px; vertical-align: middle;',
	'               border-bottom: 1px solid var(--nv-border); }',
	'.nv-table tbody tr:last-child td { border-bottom: none; }',
	'.nv-table tbody tr { transition: background .15s ease; }',
	'.nv-table tbody tr:hover { background: var(--nv-bg); }',
	/* needs the element in the selector: ".nv-table th" alone would outrank
	 * a bare ".nv-th-r" class and keep the header left aligned */
	'.nv-table th.nv-th-r, .nv-table td.nv-r { text-align: right; }',
	'.nv-num { font-variant-numeric: tabular-nums; white-space: nowrap; }',
	'.nv-dn { color: var(--nv-dn); }',
	'.nv-up { color: var(--nv-up); }',
	'.nv-ifname { font-weight: 600; }',
	'.nv-devname { font-weight: 600; }',
	'.nv-devip { color: var(--nv-muted); font-variant-numeric: tabular-nums; }',
	'.nv-mac { color: var(--nv-muted); font-variant-numeric: tabular-nums;',
	'          font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;',
	'          font-size: 11px; letter-spacing: .02em; white-space: nowrap; }',
	'.nv-alias { white-space: nowrap; }',
	'.nv-alias-chip { display: inline-block; max-width: 160px; overflow: hidden;',
	'                text-overflow: ellipsis; vertical-align: middle;',
	'                color: var(--nv-text); font-weight: 600; }',
	'.nv-alias-none { color: var(--nv-muted); }',
	'.nv-edit { display: inline-block; cursor: pointer; border: 0; background: none;',
	'           color: var(--nv-muted); padding: 5px 8px; margin-left: 4px;',
	'           border-radius: 7px; line-height: 1; vertical-align: middle;',
	'           transition: color .15s ease, background .15s ease; }',
	'.nv-edit:hover { color: var(--nv-text); background: var(--nv-bg); }',
	'.nv-edit svg { display: block; }',
	'.nv-alias-in { width: 150px; padding: 5px 8px; font: inherit; font-size: 12.5px;',
	'               color: var(--nv-text); background: var(--nv-bg);',
	'               border: 1px solid var(--nv-border); border-radius: 7px; }',
	'.nv-save, .nv-cancel { cursor: pointer; font: inherit; font-size: 12px;',
	'                       padding: 5px 10px; margin-left: 5px; border-radius: 7px;',
	'                       border: 1px solid var(--nv-border); }',
	'.nv-save { background: var(--nv-dn); border-color: var(--nv-dn); color: #fff; }',
	'.nv-cancel { background: none; color: var(--nv-muted); }',

	'.nv-badge { display: inline-block; margin-left: 7px; padding: 1px 7px;',
	'            border-radius: 999px; font-size: 10px; font-weight: 600;',
	'            letter-spacing: .03em; vertical-align: 1px;',
	'            color: #fff; background: var(--nv-dn); }',
	'.nv-badge.lan { background: var(--nv-ok); }',
	'.nv-badge.none { background: var(--nv-off); }',

	'.nv-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;',
	'          background: var(--nv-off); margin-right: 6px; vertical-align: 1px; }',
	'.nv-dot.up { background: var(--nv-ok); }',
	'.nv-muted { color: var(--nv-muted); }',

	'.nv-spark { display: block; width: 120px; height: 30px; }',

	'.nv-track { height: 5px; border-radius: 3px; overflow: hidden;',
	'            background: var(--nv-border); margin-bottom: 5px; }',
	'.nv-track i { display: block; height: 100%; border-radius: 3px;',
	'              background: linear-gradient(90deg, var(--nv-dn), var(--nv-up));',
	'              transition: width .35s ease; }',

	'.nv-empty { padding: 30px 20px; text-align: center; font-size: 12.5px;',
	'            color: var(--nv-muted); background: var(--nv-card);',
	'            border: 1px dashed var(--nv-border); border-radius: var(--nv-radius); }',
	'.nv-hint { display: block; margin-top: 8px; font-size: 11.5px; }',
	'.nv-empty code { padding: 1px 6px; border-radius: 4px; font-size: 12px;',
	'                 background: var(--nv-bg); color: var(--nv-text); }'
].join('\n');

/* ------------------------------------------------------------------ icons --- */

var ICON = {
	check: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"' +
		' stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
		'<path d="M5 12.5l4.5 4.5L19 7"/></svg>',
	cross: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"' +
		' stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
		'<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
	users: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"' +
		' stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
		'<circle cx="9.2" cy="8" r="3.3"/><path d="M3.4 19.2c0-3.1 2.6-5.3 5.8-5.3s5.8 2.2 5.8 5.3"/>' +
		'<path d="M16.2 5.6a3.1 3.1 0 0 1 0 5.9"/><path d="M17.3 14c2.3.5 3.7 2.4 3.7 4.6"/></svg>',
	nic: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"' +
		' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
		'<rect x="2.5" y="6" width="19" height="12" rx="2.2"/>' +
		'<path d="M6.6 10v4"/><path d="M9.6 10v4"/>' +
		'<rect x="14" y="9.8" width="4.6" height="4.4" rx="1.1"/></svg>',
	pencil: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"' +
		' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
		'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>'
};

/* ------------------------------------------------------------- formatting --- */

function fmtBytes(n) {
	n = Number(n) || 0;
	if (n < 0) n = 0;
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

/* Thousands separators for a plain integer count (connection table sizes run
 * into five digits, which nobody parses at a glance without them). */
function fmtInt(n) {
	n = Math.round(Number(n) || 0);
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtDuration(sec) {
	sec = Math.max(0, Math.floor(Number(sec) || 0));
	var d = Math.floor(sec / 86400),
	    h = Math.floor(sec % 86400 / 3600),
	    m = Math.floor(sec % 3600 / 60),
	    s = sec % 60;

	if (d > 0) return d + ' 天 ' + h + ' 小时';
	if (h > 0) return h + ' 小时 ' + m + ' 分';
	if (m > 0) return m + ' 分 ' + s + ' 秒';
	return s + ' 秒';
}

function fmtSpeed(mbit) {
	var n = Number(mbit) || 0;
	if (n <= 0) return '—';
	return n + ' Mbit/s';
}

function fmtProto(p) {
	switch (p) {
		case 'dhcp':   return 'DHCP';
		case 'pppoe':  return 'PPPoE';
		case 'static': return '静态';
		case 'none':
		case '':       return '';
		default:       return String(p).toUpperCase();
	}
}

function esc(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function truthy(v) {
	return v === true || v === 1 || v === '1' || v === 'true';
}

/* 链路是否可用。
 *
 * 不能拿 operstate 当唯一判据：内核只对以太网这类按常规上报载波的驱动把
 * operstate 推到 up，pppoe-wan（PPP）、utun（OpenClash 的 tun）、
 * AmneziaWG（wireguard）这些点对点设备一辈子停在 unknown —— 早先这么判，
 * 它们全被写成"未连接"，哪怕正在跑流量。后端因此把 operstate、IFF_UP /
 * LOWER_UP 标志和"有没有拿到全局地址"合起来算出一个 link 字段。
 * 老版本后端不带 link，这时才退回 operstate。 */
function linkUp(it) {
	if (it && it.link) return it.link === 'up';
	return !!it && it.state === 'up';
}

/* 协商速率。后端只把物理网卡（以及桥的成员口）报上来，PPP / tun /
 * wireguard 这类软件接口一律给 0 —— 它们没有可协商的链路，个别内核还会
 * 拿 ethtool 的默认值 1000 顶上来，显示出来是误导。 */
function speedOf(it) {
	return Number(it && it.speed) || 0;
}

/* ---------------------------------------------------------- path building --- */

/* Catmull-Rom -> cubic Bezier. The 0.18 tension is low enough that the curve
 * stays close to the data while still reading as the smooth iStoreOS style;
 * the caller clips the result so any overshoot cannot escape the plot box. */
function smoothPath(pts) {
	if (!pts.length)
		return '';
	if (pts.length === 1)
		return 'M' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);

	var d = 'M' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
	var t = 0.18;

	for (var i = 0; i < pts.length - 1; i++) {
		var p0 = pts[i - 1] || pts[i];
		var p1 = pts[i];
		var p2 = pts[i + 1];
		var p3 = pts[i + 2] || p2;

		var c1x = p1[0] + (p2[0] - p0[0]) * t;
		var c1y = p1[1] + (p2[1] - p0[1]) * t;
		var c2x = p2[0] - (p3[0] - p1[0]) * t;
		var c2y = p2[1] - (p3[1] - p1[1]) * t;

		d += ' C' + c1x.toFixed(1) + ',' + c1y.toFixed(1) +
		     ' '  + c2x.toFixed(1) + ',' + c2y.toFixed(1) +
		     ' '  + p2[0].toFixed(1) + ',' + p2[1].toFixed(1);
	}

	return d;
}

function pointsOf(hist, key, W, H, pad, max) {
	var n = hist.length, out = [], inner = H - pad * 2;
	for (var i = 0; i < n; i++) {
		var v = Math.min(1, (Number(hist[i][key]) || 0) / max);
		out.push([ pad + (i / (n - 1)) * (W - pad * 2), H - pad - v * inner ]);
	}
	return out;
}

function areaPath(pts, baseY) {
	if (!pts.length)
		return '';
	return smoothPath(pts) +
		' L' + pts[pts.length - 1][0].toFixed(1) + ',' + baseY +
		' L' + pts[0][0].toFixed(1) + ',' + baseY + ' Z';
}

/* Round a peak up to a readable scale so the curve does not jitter when the
 * throughput hovers around a threshold.
 *
 * The mantissa ladder is deliberately fine-grained: with a coarse 1/2/2.5/5
 * ladder a 2.8 MB/s peak snaps to 5 MB/s and the curve only ever reaches 56%
 * of the height, which wastes half the card. */
function niceMax(v) {
	if (!(v > 0)) return SCALE_FLOOR;
	var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
	var m = v / e;
	var ladder = [ 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 ];
	for (var i = 0; i < ladder.length; i++)
		if (m <= ladder[i] + 1e-9)
			return ladder[i] * e;
	return 10 * e;
}

/* ------------------------------------------------------------ hero chart --- */

function chartSvg(hist) {
	var W = 900, H = 292, PAD = 6;

	if (hist.length < 2)
		return '<div class="nv-chart-empty">正在采集数据…（首次采样没有基准值，约 ' +
			POLL_INTERVAL + ' 秒后出现曲线）</div>';

	var peak = 0;
	hist.forEach(function(p) {
		if (p.d > peak) peak = p.d;
		if (p.u > peak) peak = p.u;
	});

	var target = niceMax(Math.max(peak * 1.08, SCALE_FLOOR));
	yScale = yScale ? yScale + (target - yScale) * 0.35 : target;
	if (Math.abs(target - yScale) < target * 0.02) yScale = target;

	var baseY = H - PAD;
	var dn = areaPath(pointsOf(hist, 'd', W, H, PAD, yScale), baseY);
	var up = areaPath(pointsOf(hist, 'u', W, H, PAD, yScale), baseY);

	/* Download is painted first, upload on top: the overlap blends into the
	 * purple band the reference design shows along the bottom. */
	return '<svg class="nv-chart" viewBox="0 0 ' + W + ' ' + H + '"' +
		' preserveAspectRatio="none" role="img" aria-label="实时流量曲线">' +
		'<defs>' +
			'<linearGradient id="nvGDn" gradientUnits="userSpaceOnUse"' +
				' x1="0" y1="0" x2="0" y2="' + H + '">' +
				'<stop offset="0%" stop-color="' + C_DOWN + '" stop-opacity=".55"/>' +
				'<stop offset="100%" stop-color="' + C_DOWN + '" stop-opacity=".08"/>' +
			'</linearGradient>' +
			'<linearGradient id="nvGUp" gradientUnits="userSpaceOnUse"' +
				' x1="0" y1="0" x2="0" y2="' + H + '">' +
				'<stop offset="0%" stop-color="' + C_UP + '" stop-opacity=".80"/>' +
				'<stop offset="100%" stop-color="' + C_UP + '" stop-opacity=".16"/>' +
			'</linearGradient>' +
			'<clipPath id="nvClip"><rect x="0" y="0" width="' + W + '" height="' + baseY + '"/></clipPath>' +
		'</defs>' +
		'<g clip-path="url(#nvClip)">' +
			'<path d="' + dn + '" fill="url(#nvGDn)"/>' +
			'<path d="' + up + '" fill="url(#nvGUp)"/>' +
		'</g>' +
	'</svg>';
}

/* ---------------------------------------------------------- table spark --- */

function sparkSvg(points) {
	var W = 120, H = 30, PAD = 2;

	if (!points || points.length < 2)
		return '<svg class="nv-spark" viewBox="0 0 ' + W + ' ' + H + '"></svg>';

	var max = 1;
	points.forEach(function(p) {
		if (p.d > max) max = p.d;
		if (p.u > max) max = p.u;
	});

	var dn = pointsOf(points, 'd', W, H, PAD, max);
	var up = pointsOf(points, 'u', W, H, PAD, max);

	return '<svg class="nv-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
		'<path d="' + areaPath(dn, H - PAD) + '" fill="' + C_DOWN + '" opacity=".22"/>' +
		'<path d="' + smoothPath(dn) + '" fill="none" stroke="' + C_DOWN + '"' +
			' stroke-width="1.6" vector-effect="non-scaling-stroke"/>' +
		'<path d="' + smoothPath(up) + '" fill="none" stroke="' + C_UP + '"' +
			' stroke-width="1.6" vector-effect="non-scaling-stroke"/>' +
	'</svg>';
}

/* ------------------------------------------------------------ side column --- */

/* Segment colour. 其他 is the merged tail and keeps grey wherever it lands, so
 * the bar never implies that the tail is one more named category. */
function svcColor(name, i) {
	if (name === '其他')
		return SVC_REST;
	return SVC_COLORS[Math.min(i, SVC_COLORS.length - 1)];
}

/* 连接概况：连接跟踪表的实时占用 + 这些连接都连去了哪儿。
 *
 * 占比单位是"连接数"，不是流量 —— 副标题会明说，免得误读。 */
function connHtml(s) {
	if (!s)
		return '<div class="nv-conn-hd"><b>连接概况</b>' +
			'<span>连接跟踪不可用</span></div>' +
			'<div class="nv-conn-body"><div class="nv-dist">' +
			'<div class="nv-gauge-s">后端没有返回这项数据。' +
			'需要 <b>kmod-nf-conntrack</b>，且后端版本不低于 1.1.4。</div>' +
			'</div></div>';

	var cnt = Number(s.count) || 0;
	var max = Number(s.max) || 0;
	var svcs = (Array.isArray(s.services) ? s.services : []).filter(function(x) {
		return x && x.name && Number(x.count) > 0;
	});
	var sum = svcs.reduce(function(a, x) { return a + Number(x.count); }, 0);
	var pct = max > 0 ? Math.min(100, cnt * 100 / max) : 0;

	var bars = '', keys = '';
	svcs.forEach(function(x, i) {
		var p = sum > 0 ? Number(x.count) * 100 / sum : 0;
		var col = svcColor(x.name, i);
		bars += '<i style="width:' + p.toFixed(2) + '%;background:' + col + '"></i>';
		keys += '<span class="nv-key"><i style="background:' + col + '"></i>' +
			'<em title="' + esc(x.name) + '">' + esc(x.name) + '</em>' +
			'<b>' + (p >= 10 ? Math.round(p) : p.toFixed(1)) + '%</b></span>';
	});

	/* 占用率换色卡在内核开始丢包的位置，而不是"条看起来满了"的位置：
	 * nf_conntrack 撑满会直接 dmesg 报 table full 并丢包。 */
	var lvl = pct >= 85 ? '#dc2626' : (pct >= 60 ? '#d97706' : '#16a34a');

	var html = '<div class="nv-conn-hd"><b>连接概况</b><span>' +
		'conntrack 实时占用 · 按远程端口归类' +
		'</span></div><div class="nv-conn-body">';

	html += '<div class="nv-gauge">' +
		'<div class="nv-gauge-n">' + fmtInt(cnt) +
			(max > 0 ? '<i>/ ' + fmtInt(max) + '</i>' : '') + '</div>';
	if (max > 0)
		html += '<div class="nv-track"><i style="width:' + pct.toFixed(1) +
			'%;background:' + lvl + '"></i></div>';
	html += '<div class="nv-gauge-s">' +
		(max > 0 ? '连接跟踪表占用 ' + pct.toFixed(1) + '%'
		         : '读不到连接表上限') +
		'</div></div>';

	if (sum > 0)
		html += '<div class="nv-dist"><div class="nv-stack">' + bars +
			'</div><div class="nv-keys">' + keys + '</div></div>';
	else
		html += '<div class="nv-dist"><div class="nv-gauge-s">' +
			'暂时没有可归类的连接' +
			'</div></div>';

	return html + '</div>';
}

function roleBadge(it) {
	var r = it.role;
	if (!r) return '';
	return '<span class="nv-badge' + (r === 'LAN' ? ' lan' : '') + '">' + esc(r) + '</span>';
}

function sideHtml(d) {
	var wi = d.wan_info || {};
	var conn = truthy(wi.connected);
	var clients = Number(d.clients) || 0;

	/* ---- connectivity ---- */
	var sub;
	if (conn)
		sub = Number(wi.uptime) > 0 ? '已连接 ' + fmtDuration(wi.uptime) : '连接正常';
	else
		sub = wi.proto ? 'WAN 未连接' : '正在等待 WAN 拨号';

	var html = '<div class="nv-card nv-mini">' +
		'<div class="nv-ico ' + (conn ? 'violet' : 'red') + '">' +
			(conn ? ICON.check : ICON.cross) + '</div>' +
		'<div><div class="nv-mini-t">' + (conn ? '已连接互联网' : '未连接互联网') + '</div>' +
			'<div class="nv-mini-s">' + esc(sub) + '</div></div>' +
	'</div>';

	/* ---- clients ---- */
	html += '<div class="nv-card nv-mini">' +
		'<div class="nv-ico cyan">' + ICON.users + '</div>' +
		'<div><div class="nv-mini-n">' + clients + '</div>' +
			'<div class="nv-mini-s">已连接设备</div></div>' +
	'</div>';

	/* ---- WAN addressing ---- */
	var pl = fmtProto(wi.proto);
	var rows = '';

	rows += '<div class="nv-row"><span class="nv-row-k">IPv4</span>' +
		'<span class="nv-row-v">' + (wi.ipv4
			? esc(wi.ipv4) + (pl ? ' <em>（' + esc(pl) + '）</em>' : '')
			: '<em>未获取</em>') + '</span></div>';

	if (wi.ipv6)
		rows += '<div class="nv-row"><span class="nv-row-k">IPv6</span>' +
			'<span class="nv-row-v">' + esc(wi.ipv6) + '</span></div>';

	rows += '<div class="nv-row"><span class="nv-row-k">DNS</span>' +
		'<span class="nv-row-v">' + (wi.dns
			? esc(wi.dns) + ' <em>（' + (truthy(wi.dns_auto) ? '自动获取' : '手动指定') + '）</em>'
			: '<em>未配置</em>') + '</span></div>';

	html += '<div class="nv-card nv-info">' +
		'<div class="nv-info-hd">IP 地址（' + esc(d.wan || 'wan') + '）</div>' + rows +
	'</div>';

	/* ---- interface tiles: WAN first, then LAN, then everything else ----
	 * 纯软件接口（PPP / tun / wireguard）没有协商速率可显示，早先只印一个
	 * "—"，看着就像"这个口没状态"。改成：有速率的报速率，没速率的报链路
	 * 状态词，两者的前面都带一个状态点。 */
	var order = { 'WAN': 0, 'LAN': 1 };
	var links = (d.interfaces || []).filter(function(it) {
		return it.role || speedOf(it) > 0 || linkUp(it);
	}).sort(function(a, b) {
		var oa = order[a.role] != null ? order[a.role] : 2;
		var ob = order[b.role] != null ? order[b.role] : 2;
		if (oa !== ob) return oa - ob;
		return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
	}).slice(0, 8);

	if (links.length) {
		var tiles = links.map(function(it) {
			var roles = it.roles || it.role || '';
			var spd = speedOf(it);
			var up = linkUp(it);

			return '<div class="nv-tile">' +
				'<span class="nv-tile-ico">' + ICON.nic + '</span>' +
				'<div style="min-width:0">' +
					'<div class="nv-tile-t">' +
						'<span class="nv-dot' + (up ? ' up' : '') + '"></span>' +
						(spd > 0 ? fmtSpeed(spd) : (up ? '已连接' : '未连接')) +
					'</div>' +
					'<div class="nv-tile-s" title="' + esc(it.name + (roles ? '（' + roles + '）' : '')) + '">' +
						esc(it.name) + (roles ? '（' + esc(roles) + '）' : '') + '</div>' +
				'</div>' +
			'</div>';
		}).join('');

		html += '<div class="nv-card nv-info">' +
			'<div class="nv-info-hd">网络接口状态' +
				'<span class="nv-tag">' + links.length + '</span></div>' +
			'<div class="nv-tiles">' + tiles + '</div>' +
		'</div>';
	}

	return html;
}

/* --------------------------------------------------------- interface table --- */

function ifTableHtml(d) {
	var order = { 'WAN': 0, 'LAN': 1 };
	var list = (d.interfaces || []).slice(0).sort(function(a, b) {
		var oa = order[a.role] != null ? order[a.role] : 2;
		var ob = order[b.role] != null ? order[b.role] : 2;
		if (oa !== ob) return oa - ob;
		return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
	});

	if (!list.length)
		return '<div class="nv-empty">未检测到网络接口</div>';

	var html = '<table class="nv-table"><thead><tr>' +
		'<th>接口</th><th>状态</th>' +
		'<th class="nv-th-r">下行</th><th class="nv-th-r">上行</th>' +
		'<th>最近 3 分钟</th>' +
		'<th class="nv-th-r">累计收</th><th class="nv-th-r">累计发</th>' +
	'</tr></thead><tbody>';

	list.forEach(function(it) {
		var h = ifHist[it.name] || [];
		var up = linkUp(it);
		var spd = speedOf(it);

		html += '<tr>' +
			'<td><span class="nv-ifname">' + esc(it.name) + '</span>' + roleBadge(it) + '</td>' +
			'<td class="nv-muted">' +
				'<span class="nv-dot' + (up ? ' up' : '') + '"></span>' +
				(up ? '运行中' : '未连接') +
				(spd > 0 ? ' · ' + spd + 'M' : '') +
			'</td>' +
			'<td class="nv-num nv-dn nv-r">' + fmtRate(it.rx_rate) + '</td>' +
			'<td class="nv-num nv-up nv-r">' + fmtRate(it.tx_rate) + '</td>' +
			'<td>' + sparkSvg(h) + '</td>' +
			'<td class="nv-num nv-r">' + fmtBytes(it.rx) + '</td>' +
			'<td class="nv-num nv-r">' + fmtBytes(it.tx) + '</td>' +
		'</tr>';
	});

	return html + '</tbody></table>';
}

/* ------------------------------------------------------------ device table --- */

function renderDevices(box, data) {
	/* 编辑别名时轮询仍在跑，若照常重绘会把手里的输入框整个换掉（半截名字
	 * 被覆盖、焦点丢失）。编辑期间直接跳过重绘，等保存/取消后再恢复。 */
	if (devEditing) return;

	if (!data) {
		box.innerHTML = '<div class="nv-empty">无法读取设备数据</div>';
		return;
	}

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

	var html = '<table class="nv-table"><thead><tr>' +
		'<th>设备</th><th>别名</th><th>MAC</th><th>IP</th>' +
		'<th class="nv-th-r">下行</th><th class="nv-th-r">上行</th>' +
		'<th>累计流量</th><th class="nv-th-r">连接数</th>' +
	'</tr></thead><tbody>';

	list.forEach(function(d) {
		var total = d.down + d.up;
		var pct = Math.max(3, Math.min(100, (total / max) * 100));

		html += '<tr>' +
			'<td class="nv-devname">' + esc(d.host && d.host !== '-' ? d.host : '未知设备') + '</td>' +
			'<td class="nv-alias">' + aliasCellHtml(d) + '</td>' +
			'<td class="nv-mac">' + (d.mac && d.mac !== '-' ? esc(d.mac) : '—') + '</td>' +
			'<td class="nv-devip">' + esc(d.ip) + '</td>' +
			'<td class="nv-num nv-dn nv-r">' + fmtRate(d.down_rate) + '</td>' +
			'<td class="nv-num nv-up nv-r">' + fmtRate(d.up_rate) + '</td>' +
			'<td style="min-width:180px">' +
				'<div class="nv-track"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
				'<span class="nv-num">' + fmtBytes(total) + '</span>' +
			'</td>' +
			'<td class="nv-num nv-r">' + (Number(d.conns) || 0) + '</td>' +
		'</tr>';
	});

	box.innerHTML = html + '</tbody></table>';
}

/* 别名列：设备名只读，别名是独立一列、按 MAC 归属到设备。没有 MAC 的条目
 * （静态 IP 且 ARP 没回完整条目）无法定位别名，就只显示一个破折号。 */
function aliasCellHtml(d) {
	var alias = d.alias || '';
	var mac = d.mac || '';
	if (!mac || mac === '-')
		return '<span class="nv-alias-none">—</span>';
	var label = alias
		? '<span class="nv-alias-chip" title="' + esc(alias) + '">' + esc(alias) + '</span>'
		: '<span class="nv-alias-none">未设置</span>';
	return label +
		'<button type="button" class="nv-edit" data-mac="' + esc(mac) +
			'" data-alias="' + esc(alias) + '" aria-label="编辑别名">' + ICON.pencil + '</button>';
}

function startAliasEdit(btn) {
	var td = btn.parentNode;
	var mac = btn.getAttribute('data-mac') || '';
	var orig = btn.getAttribute('data-alias') || '';
	devEditing = true;
	td.innerHTML =
		'<input class="nv-alias-in" type="text" maxlength="64" value="' + esc(orig) + '"' +
			' data-mac="' + esc(mac) + '" data-orig="' + esc(orig) + '">' +
		'<button type="button" class="nv-save">保存</button>' +
		'<button type="button" class="nv-cancel">取消</button>';
	var inp = td.querySelector('.nv-alias-in');
	if (inp) inp.focus();
}

function commitAliasEdit(btn, save) {
	var td = btn.parentNode;
	var inp = td.querySelector('.nv-alias-in');
	if (!inp) { devEditing = false; return; }
	var mac = inp.getAttribute('data-mac') || '';
	var orig = inp.getAttribute('data-orig') || '';
	var name = inp.value.replace(/^\s+|\s+$/g, '');

	save(mac, name).then(function(res) {
		if (res && res.ok)
			td.innerHTML = aliasCellHtml({ alias: name, mac: mac });
		else {
			var why = (res && (res.detail || res.reason)) || '未知错误';
			window.alert('保存失败：' + why);
			td.innerHTML = aliasCellHtml({ alias: orig, mac: mac });
		}
		devEditing = false;
	}, function(err) {
		window.alert('保存失败：' + ((err && err.message) || err));
		td.innerHTML = aliasCellHtml({ alias: orig, mac: mac });
		devEditing = false;
	});
}

function cancelAliasEdit(btn) {
	var td = btn.parentNode;
	var inp = td.querySelector('.nv-alias-in');
	var mac = inp ? inp.getAttribute('data-mac') : '';
	var orig = inp ? inp.getAttribute('data-orig') : '';
	td.innerHTML = aliasCellHtml({ alias: orig, mac: mac });
	devEditing = false;
}

/* 事件委托挂在容器上，按钮在 renderDevices 换 innerHTML 后依然命中。 */
function bindDeviceEdits(box, save) {
	if (!box || typeof box.addEventListener !== 'function') return;
	box.addEventListener('click', function(ev) {
		var t = ev.target;
		var btn = t && t.closest ? t.closest('button') : null;
		if (!btn) return;
		if (btn.classList.contains('nv-edit')) startAliasEdit(btn);
		else if (btn.classList.contains('nv-save')) commitAliasEdit(btn, save);
		else if (btn.classList.contains('nv-cancel')) cancelAliasEdit(btn);
	});
}

/* ------------------------------------------------------------------- view --- */

/* The hero chart reflects what crosses the uplink, so aggregate WAN-role
 * interfaces only; if none could be identified fall back to every interface
 * so the chart is never empty. */
function aggregate(list) {
	var wan = (list || []).filter(function(it) { return it.role === 'WAN'; });
	var src = wan.length ? wan : (list || []);
	var d = 0, u = 0;

	src.forEach(function(it) {
		d += Number(it.rx_rate) || 0;
		u += Number(it.tx_rate) || 0;
	});

	return { d: d, u: u, scope: wan.length ? 'WAN' : '全部接口' };
}

return view.extend({
	render: function() {
		var chartBox = E('div', { 'class': 'nv-chartwrap' });
		var nowBox = E('div', { 'class': 'nv-now' });
		var sideBox = E('div', { 'class': 'nv-side' });
		var connBox = E('div', { 'class': 'nv-card nv-conn' });
		var ifBox = E('div', { 'class': 'nv-tablewrap' });
		var devBox = E('div', { 'class': 'nv-tablewrap' });

		var legend = E('div', { 'class': 'nv-legend' });
		legend.innerHTML =
			'<span class="nv-lg"><i class="nv-dn"></i>下载</span>' +
			'<span class="nv-lg"><i class="nv-up"></i>上传</span>';

		var root = E('div', { 'class': 'nv-root' }, [
			E('style', {}, CSS),
			E('div', { 'class': 'nv-head' }, [
				E('h2', {}, '实时流量'),
				E('span', { 'class': 'nv-sub' }, [
					E('span', { 'class': 'nv-live' }),
					'每 ' + POLL_INTERVAL + ' 秒刷新 · 曲线保留最近 ' +
						(MAXPOINTS * POLL_INTERVAL / 60) + ' 分钟'
				])
			]),
			E('div', { 'class': 'nv-hero' }, [
				E('div', { 'class': 'nv-col' }, [
					E('div', { 'class': 'nv-card nv-chartcard' }, [
						E('div', { 'class': 'nv-chart-hd' }, [
							E('span', { 'class': 'nv-chart-title' }, '流量统计'),
							legend,
							nowBox
						]),
						chartBox
					]),
					connBox
				]),
				sideBox
			]),
			E('div', { 'class': 'nv-sec' }, [
				E('div', { 'class': 'nv-sec-hd' }, [
					E('h3', {}, '网络接口'),
					E('span', {}, '速率取自 /proc/net/dev 差分，累计值为接口开机以来的计数')
				]),
				ifBox
			]),
			E('div', { 'class': 'nv-sec' }, [
				E('div', { 'class': 'nv-sec-hd' }, [
					E('h3', {}, '设备流量排行'),
					E('span', {}, '按当前存活连接的累计字节排序，已排除路由器自身流量，最多 ' + MAX_DEVICES + ' 条')
				]),
				devBox
			])
		]);

		function refresh() {
			return Promise.all([
				callInterfaces().catch(function() { return null; }),
				callDevices().catch(function() { return null; }),
				callSessions().catch(function() { return null; })
			]).then(function(res) {
				var d = res[0];

				if (d && d.interfaces) {
					d.interfaces.forEach(function(it) {
						var h = ifHist[it.name] || (ifHist[it.name] = []);
						h.push({ d: Number(it.rx_rate) || 0, u: Number(it.tx_rate) || 0 });
						while (h.length > MAXPOINTS) h.shift();
					});

					var agg = aggregate(d.interfaces);
					heroHist.push({ d: agg.d, u: agg.u });
					while (heroHist.length > MAXPOINTS) heroHist.shift();

					chartBox.innerHTML = chartSvg(heroHist);
					nowBox.innerHTML =
						'<span>上传<b>' + fmtRate(agg.u) + '</b></span>' +
						'<span>下载<b>' + fmtRate(agg.d) + '</b></span>';
					sideBox.innerHTML = sideHtml(d);
					ifBox.innerHTML = ifTableHtml(d);
				}
				else {
					chartBox.innerHTML =
						'<div class="nv-chart-empty">无法从路由器读取接口数据</div>';
					sideBox.innerHTML = '';
					ifBox.innerHTML = '<div class="nv-empty">无法从路由器读取接口数据</div>';
				}

				/* 独立于接口数据：conntrack 读不到也不该把整列拖黑 */
				connBox.innerHTML = connHtml(res[2]);
				renderDevices(devBox, res[1]);
			});
		}

		bindDeviceEdits(devBox, callSetAlias);

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
