#!/usr/bin/env node
/**
 * 生成 preview/argon-harness.html —— 把预览页塞进 Argon 的主题骨架里。
 *
 * 为什么需要这个：Argon 的全局样式会改造插件自己的 DOM，有两处会直接打架，
 * 而这两处在"纯预览页"里都看不出来，只有装到路由器上才会暴露：
 *
 *   1) h2 { padding: 1rem 1.25rem; background: var(--white); box-shadow: … }
 *      Argon 把**每一个** h2 都当成"页面标题卡片"。而本插件里 h2 是
 *      .nv-head（flex 容器）的 flex item，会被收缩成内容宽 —— 于是标题变成
 *      一块窄白卡，副标题被挤到卡片外面的主色横带上。
 *
 *   2) header::after { position: absolute; height: 2rem;
 *                      background: var(--primary) !important }
 *      Argon 在页头下方画一条 2rem 高的主色横带。它绝对定位、静态位置正好落在
 *      页头底边，于是向下压进内容区 2rem。标题区自己没有底色时，副标题就会
 *      落在横带上：#8898aa 叠 #5e72e4 对比度只有 1.42:1，字等于隐形。
 *
 *   3) h1..h6 { font-weight: normal; line-height: 1.1 !important }
 *      line-height 带 !important，会在中文标题上把行高压瘪。
 *
 *   4) 样式加载顺序：Argon 的 header.ut 是「cascade.css 常驻 + 按需叠加
 *      dark.css」，而 **dark.css 并没有全局重定义 --oc-*** —— 全局的
 *      --oc-surface 在暗色下仍然是 #fff。所以插件在暗色块里
 *      var(--oc-surface, …) 会拿到白色，卡片直接变白。暗色那套值必须写死。
 *      这个测试页照原来的方式挂两张表，才能如实复现这一点。
 *
 * 用法：
 *   node tools/argon-harness.js
 *
 * 产物一个文件同时覆盖明暗：cascade.css 常驻、dark.css 挂
 * media="(prefers-color-scheme: dark)"，与 Argon 的 mode == 'normal' 一致。
 * 想看暗色就把浏览器/无头浏览器切到暗色偏好（Chrome 用 --force-dark-mode）。
 *
 * 产物是生成物，不要手改 —— 改 preview/overview-preview.html 后重新跑一遍。
 * .nv-root 及其之后的脚本是**原样搬运**的，所以两边永远同源；
 * tools/parity.test.js 会盯着这一点。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'preview', 'overview-preview.html');

/* 锁版本，避免上游改了样式导致复现结果飘 */
const ARGON_VERSION = '2.4.7';
const CSS_BASE = 'https://cdn.jsdelivr.net/gh/jerrykuku/luci-theme-argon@' +
	ARGON_VERSION + '/htdocs/luci-static/argon/css/';

const OUT = path.join(ROOT, 'preview', 'argon-harness.html');

let html = fs.readFileSync(SRC, 'utf8');

function must(cond, msg) {
	if (!cond) {
		console.error('生成失败：' + msg);
		process.exit(1);
	}
}

/* ---- 1. 换掉预览自己的页面外壳样式，挂上 Argon 官方 CSS ---- */

const headStyle = html.match(/<style>[\s\S]*?<\/style>\n/);
must(headStyle, '找不到 head 里的 <style> 块');

html = html.replace(headStyle[0],
	/* 与 Argon header.ut 的 mode == 'normal' 分支一致：
	 * cascade.css 常驻，dark.css 挂 media 查询叠上去。 */
	'<link rel="stylesheet" href="' + CSS_BASE + 'cascade.css">\n' +
	'<link rel="stylesheet" href="' + CSS_BASE + 'dark.css" media="(prefers-color-scheme: dark)">\n' +
	'<style>\n' +
	'\t/* 只补 Argon 不管的最基础一条：预览页不是 LuCI 的 index，没有 reset */\n' +
	'\thtml, body { margin: 0; padding: 0; }\n' +
	'</style>\n');

/* ---- 2. 用 Argon 的 DOM 骨架替换 .pg-bar + .pg-wrap ---- */

/* 骨架照抄 ucode/template/themes/argon/header.ut：
 *   body > .main > .main-right > header.bg-primary + #maincontent > .container
 * .main-left 在模板里初始 display:none（侧栏收起态），这里保持一样。
 * #tabmenu 是 LuCI 放页签的地方，模板里也是 display:none。 */
const chrome = html.match(
	/<div class="pg-bar">[\s\S]*?<main class="pg-wrap">\n/);
must(chrome, '找不到 .pg-bar / .pg-wrap 外壳');

html = html.replace(chrome[0],
	'<div class="main">\n' +
	'\t<div class="main-left" id="mainmenu" style="display:none"></div>\n' +
	'\t<div class="main-right">\n' +
	'\t\t<header class="bg-primary">\n' +
	'\t\t\t<div class="fill">\n' +
	'\t\t\t\t<div class="container">\n' +
	'\t\t\t\t\t<div class="flex1">\n' +
	'\t\t\t\t\t\t<button type="button" class="showSide" aria-label="切换导航"></button>\n' +
	'\t\t\t\t\t\t<a class="brand" href="#">ImmortalWrt</a>\n' +
	'\t\t\t\t\t</div>\n' +
	'\t\t\t\t\t<div class="status" id="indicators"></div>\n' +
	'\t\t\t\t</div>\n' +
	'\t\t\t</div>\n' +
	'\t\t</header>\n' +
	'\t\t<div class="darkMask"></div>\n' +
	'\t\t<div id="maincontent">\n' +
	'\t\t\t<div class="container">\n' +
	'\t\t\t\t<div id="tabmenu" style="display:none"></div>\n' +
	'\t\t\t\t<!-- ↓↓↓ 以下 .nv-root 由 overview-preview.html 原样搬运 ↓↓↓ -->\n');

must(html.includes('\n</main>\n'), '找不到 </main>');
html = html.replace('\n</main>\n',
	'\n\t\t\t\t<!-- ↑↑↑ .nv-root 结束 ↑↑↑ -->\n' +
	'\t\t\t</div>\n' +
	'\t\t</div>\n' +
	'\t</div>\n' +
	'</div>\n');

/* ---- 3. 摘掉预览专属的亮/暗切换按钮逻辑（骨架里没有 #tg） ---- */

const toggle = html.match(/\n\/\* 亮 \/ 暗切换 \*\/[\s\S]*?\n<\/script>/);
must(toggle, '找不到亮/暗切换脚本块');
html = html.replace(toggle[0], '\n</script>');

/* ---- 4. 标题与开头注释 ---- */

html = html.replace(/<title>[^<]*<\/title>/,
	'<title>luci-app-netview — Argon 主题下的渲染结果</title>');

html = html.replace('<!DOCTYPE html>',
	'<!DOCTYPE html>\n' +
	'<!--\n' +
	'  由 tools/argon-harness.js 生成，请勿手改。\n' +
	'  用途：在真实的 Argon 主题（v' + ARGON_VERSION + '）骨架下渲染 netview 页面，\n' +
	'  用来看主题的全局样式有没有把插件带歪。\n' +
	'  cascade.css 常驻、dark.css 挂 prefers-color-scheme —— 与 Argon 一致，\n' +
	'  所以一个文件同时覆盖明暗：切浏览器暗色偏好即可看暗色。\n' +
	'  重新生成：node tools/argon-harness.js\n' +
	'-->\n');

/* ---- 5. 自检：产物必须真的是一个 Argon 骨架页面 ---- */

const need = [
	['Argon 页头', '<header class="bg-primary">'],
	['主内容区', '<div id="maincontent">'],
	['插件根节点', '<div class="nv-root" id="root">'],
	['插件样式表', '<style>'],           /* .nv-root 里的 <style id="nvcss"> 之外还有 CSS 数组 */
	['Argon 亮色样式链接', 'argon/css/cascade.css'],
	['Argon 暗色样式链接', 'argon/css/dark.css" media="(prefers-color-scheme: dark)'],
	['残留的预览外壳', null],
];

for (const [label, needle] of need) {
	if (needle === null) {
		must(!html.includes('class="pg-wrap"') && !html.includes('class="pg-bar"'),
			'预览外壳没清干净');
	} else {
		must(html.includes(needle), '产物里缺少' + label);
	}
}
must(!html.includes("getElementById('tg')"), '切换按钮的脚本没摘干净');
must(!html.includes('</main>'), '还留着 </main>');

fs.writeFileSync(OUT, html);

const lines = html.split('\n').length;
console.log('已生成 ' + path.relative(ROOT, OUT).replace(/\\/g, '/') +
	'  (' + lines + ' 行, ' + Buffer.byteLength(html) + ' 字节)');
console.log('Argon v' + ARGON_VERSION + ' / cascade.css + dark.css(prefers-color-scheme)');
