/* 默认落地页回归测试 —— 「登录后第一眼看到哪一页」。
 *
 * 为什么值得单独测：menu.d 里的 "order" 看着只是"在侧边栏排第几"，但它同时决定了
 * 访问 /cgi-bin/luci（不带路径）时的默认落地项，也就是登录页提交后的跳转目标。
 * 把 order 调大一点，功能看着没坏、菜单也在，但登录后的首页会悄悄变回去 ——
 * 这类回归最容易在"顺手改个排序"时发生，所以钉死。
 *
 * 整条链路是四段上游代码串起来的（原文见 tools/fixtures/upstream/）：
 *
 *   1. dispatcher.uc  build_pagetree()      把 menu.d 的 "a/b/c" 展开成节点树
 *   2. dispatcher.uc  resolve_firstchild()  逐层挑出默认落地项（order 小者优先）
 *   3. index.uc / dispatcher.uc            登录成功后 redirect 回第 2 步解析出的路径
 *   4. ui.js          ui.menu.getChildren() 侧边栏显示顺序（另一套排序，见下）
 *
 * 第 2 步和第 4 步**打平时规则不一样**：
 *   后端 order 相同 → 保留先遍历到的（取决于 menu.d 的加载顺序）
 *   前端 order 相同 → 按 L.naturalCompare(name) 排
 * 所以不能靠"和别人 order 一样"取胜，必须严格更小。下面两条链路都测。
 *
 * 这里是那两段逻辑的等价翻译，不是源码本身；翻译是否还忠实于上游，由文件末尾的
 * 漂移断言来兜底。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const UPSTREAM_MENUD = path.join(FIXTURES, 'menu.d');
const OUR_MENUD = path.join(ROOT, 'root', 'usr', 'share', 'luci', 'menu.d');

let pass = 0, fail = 0;
function check(name, cond, detail) {
	if (cond) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name + (detail ? '  << ' + detail : '')); }
}

/* ===================== 一、dispatcher.uc 的等价翻译 ===================== */

/* build_pagetree()：{"a/b/c": spec} → 节点树。
 * 中间节点只补成 `{ satisfied: true }`（没有 title、没有 action）；
 * 字段按 schema 的类型逐个套用，同名路径的后一份会**逐字段**覆盖前一份。 */
const SCHEMA = {
	action: 'object', auth: 'object', cors: 'bool', css: 'string',
	depends: 'object', order: 'int', setgroup: 'string', setuser: 'string',
	title: 'string', wildcard: 'bool', firstchild_ineligible: 'bool'
};

function uctype(v) {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';

	switch (typeof v) {
	case 'boolean': return 'bool';
	case 'string':  return 'string';
	case 'number':  return Number.isInteger(v) ? 'int' : 'double';
	case 'object':  return 'object';
	}

	return 'unknown';
}

function buildTree(specs) {
	const tree = { action: { type: 'firstchild' }, children: {} };

	for (const [p, spec] of Object.entries(specs)) {
		if (uctype(spec) !== 'object')
			continue;

		let node = tree, wildcard = false;

		for (const seg of String(p).split('/')) {
			if (seg[0] == '*') { node.wildcard = true; wildcard = true; break; }

			node.children = node.children || {};
			node.children[seg] = node.children[seg] || { satisfied: true };
			node = node.children[seg];
		}

		if (wildcard || node === tree)
			continue;

		for (const [k, t] of Object.entries(SCHEMA))
			if (uctype(spec[k]) === t)
				node[k] = spec[k];

		/* 上游这里调的是 check_depends(spec)，要查 acl / 文件系统 / uci。
		 * 测试环境里没有路由器，一律按"满足"算 —— 这是**候选最多**的情形，
		 * 候选越多越难赢，能赢才说明稳。 */
		node.satisfied = true;
	}

	return tree;
}

/* node_weight()：order 越小越优先；缺省按 9999；要求登录的额外 +10000。 */
function nodeWeight(node) {
	let weight = Math.min(node.order ?? 9999, 9999);

	if (node.auth && node.auth.login)
		weight += 10000;

	return weight;
}

/* resolve_firstchild()：挑出默认落地项，改写 ctx 成完整路径。
 *   - 只有同时有 title 和 action 的节点才参与（中间节点因此被跳过）
 *   - action 为 firstchild 的节点递归进去取子树结果
 *   - 其余节点要 firstchild_ineligible 不为真才作数
 *   - 多个候选取 weight 最小者；相等时保留先遍历到的（即 menu.d 加载顺序）
 * 注意其中并没有读 action.preferred。 */
function resolveFirstchild(node, ctx) {
	let candidate = null, candidateCtx = null;

	for (const name of Object.keys(node.children || {})) {
		const child = node.children[name];

		if (!child.satisfied)
			continue;

		if (!(child.title && child.action && uctype(child.action) == 'object'))
			continue;

		const childCtx = ctx.concat(name);

		if (child.action.type == 'firstchild') {
			if (!candidate || nodeWeight(candidate) > nodeWeight(child)) {
				if (resolveFirstchild(child, childCtx)) {
					candidate = child;
					candidateCtx = childCtx;
				}
			}
		}
		else if (!child.firstchild_ineligible) {
			if (!candidate || nodeWeight(candidate) > nodeWeight(child)) {
				candidate = child;
				candidateCtx = childCtx;
			}
		}
	}

	if (!candidate)
		return false;

	ctx.length = 0;
	Array.prototype.push.apply(ctx, candidateCtx);

	return true;
}

/* ===================== 二、ui.js 的等价翻译 ===================== */

/* L.naturalCompare()：把字符串切成数字段/非数字段逐段比，数字按数值。
 * 我们的节点名都是纯字母，这里是简化实现，但保留"逐段自然序"的语义。 */
function naturalCompare(a, b) {
	const ax = String(a).match(/\d+|\D+/g) || [];
	const bx = String(b).match(/\d+|\D+/g) || [];

	for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
		const x = ax[i], y = bx[i];

		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;

		if (/^\d+$/.test(x) && /^\d+$/.test(y))
			return Number(x) - Number(y);

		return x < y ? -1 : 1;
	}

	return 0;
}

/* ui.menu.getChildren() 的排序部分：先剔除未满足依赖和没有 title 的，
 * 再按 `order ?? 1000` 排，打平按名字自然序。
 * 注意是 `??` 不是 `||` —— order: 0 是有效值。 */
function menuSort(entries) {
	return entries
		.filter(e => e.node.satisfied && Object.prototype.hasOwnProperty.call(e.node, 'title'))
		.sort((a, b) => {
			const wA = a.node.order ?? 1000;
			const wB = b.node.order ?? 1000;

			if (wA != wB)
				return wA - wB;

			return naturalCompare(a.name, b.name);
		});
}

/* ============================ 三、载入数据 ============================ */

/* 逐字段合并，模拟上游"同名路径的后一份覆盖字段"的行为。
 * 文件按名字排序读入，与实际 glob 的字母序一致。 */
function loadMenuDir(dir) {
	const merged = {};

	for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
		const spec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

		for (const [p, node] of Object.entries(spec))
			merged[p] = Object.assign(merged[p] || {}, node);
	}

	return merged;
}

const UPSTREAM = loadMenuDir(UPSTREAM_MENUD);
const OURS = loadMenuDir(OUR_MENUD);

function specsWith(extra) {
	const out = {};

	for (const src of [UPSTREAM, OURS, extra || {}])
		for (const [p, node] of Object.entries(src))
			out[p] = Object.assign(out[p] || {}, node);

	return out;
}

/* 后端口径：登录后落在哪一页 */
function landing(extra) {
	const ctx = [];
	const ok = resolveFirstchild(buildTree(specsWith(extra)), ctx);

	return ok ? ctx.join('/') : null;
}

/* 前端口径：某个分组下侧边栏的显示顺序 */
function sidebar(groupPath, extra) {
	let node = buildTree(specsWith(extra));

	for (const seg of groupPath.split('/'))
		node = node.children?.[seg];

	if (!node)
		return [];

	return menuSort(Object.entries(node.children || {})
		.map(([name, child]) => ({ name, node: child })))
		.map(e => e.name);
}

/* ============================== 四、测试 ============================== */

console.log('\n-- 基线 --');
check('载入了上游 menu.d 基线', !!UPSTREAM['admin'] && !!UPSTREAM['admin/status/overview']);
check('载入了本插件的菜单项', !!OURS['admin/status/netview']);
check('上游基线含 admin/logout 的 firstchild_ineligible 用法',
	UPSTREAM['admin/logout']?.firstchild_ineligible === true);

console.log('\n-- 后端：登录落地点 --');
const LANDING = landing();
check('能解析出默认落地项', LANDING !== null);
check('登录后落在实时流量页 admin/status/netview',
	LANDING === 'admin/status/netview', LANDING);

const REVERTED = landing({ 'admin/status/netview': { order: 30 } });
check('反证：order 调回改动前的 30 就会退回概况页',
	REVERTED === 'admin/status/overview', REVERTED);

const DASH = landing({
	'admin/dashboard': { title: 'Dashboard', order: 1, action: { type: 'view', path: 'dashboard/index' } }
});
check('装了 luci-mod-dashboard 时由它接管首页（我们不抢）',
	DASH === 'admin/dashboard', DASH);

/* 严格最小 —— 后端靠"先遍历到的"、前端靠"名字自然序"，打平结果不一致，
 * 会让侧边栏和落地页对不上。 */
const statusCandidates = Object.entries(buildTree(specsWith()).children['admin'].children['status'].children)
	.filter(([, n]) => n.title && n.action && uctype(n.action) == 'object')
	.filter(([, n]) => !n.firstchild_ineligible)
	.map(([name, n]) => ({ name, w: nodeWeight(n) }))
	.sort((a, b) => a.w - b.w);

check('netview 是同层里 weight 最小的',
	statusCandidates[0]?.name === 'netview', JSON.stringify(statusCandidates.slice(0, 3)));
check('而且严格小于第二名（不是打平）',
	statusCandidates.length > 1 && statusCandidates[0].w < statusCandidates[1].w,
	JSON.stringify(statusCandidates.slice(0, 2)));

console.log('\n-- 前端：侧边栏顺序 --');
const STATUS_SIDEBAR = sidebar('admin/status');
check('「状态」组里排第一', STATUS_SIDEBAR[0] === 'netview', STATUS_SIDEBAR.slice(0, 4).join(' / '));

/* order: 0 是个容易被写错的地方 —— 如果上游哪天把 `?? 1000` 改成 `|| 1000`，
 * 0 会被当成 falsy 顶到末尾。这条合成用例把这个前提单独钉住。 */
const SYNTH = menuSort([
	{ name: 'zzz-late', node: { title: 'Z', order: 5, satisfied: true } },
	{ name: 'aaa-zero', node: { title: 'A', order: 0, satisfied: true } }
]);
check('order: 0 被当作有效值（不是 falsy）', SYNTH[0].name === 'aaa-zero',
	SYNTH.map(e => e.name).join(' / '));

check('「状态」组里原有的概况页仍在，只是退到第二位',
	STATUS_SIDEBAR.indexOf('overview') === 1, STATUS_SIDEBAR.slice(0, 4).join(' / '));

console.log('\n-- 菜单项自身 --');
const NV = OURS['admin/status/netview'];
check('有 title（没有 title 的节点不参与默认页选举）', typeof NV.title == 'string' && !!NV.title);
check('action 是 view 而非 firstchild', NV.action?.type === 'view', NV.action?.type);
check('view 路径指向本插件页面', NV.action?.path === 'netview/overview', NV.action?.path);
check('没有被打上 firstchild_ineligible（否则永不参选）', !NV.firstchild_ineligible);
check('declared order 为 0', NV.order === 0, String(NV.order));
check('ACL 依赖指向本插件的权限组', NV.depends?.acl?.[0] === 'luci-app-netview',
	JSON.stringify(NV.depends));

console.log('\n-- 上游依据漂移检查 --');
const DISP = fs.readFileSync(path.join(FIXTURES, 'upstream', 'dispatcher-resolve_firstchild.uc'), 'utf8');
const UICODE = fs.readFileSync(path.join(FIXTURES, 'upstream', 'ui-menu-getchildren.js'), 'utf8');
const DISP_CODE = DISP.replace(/\/\*[\s\S]*?\*\//g, '');
const UI_CODE = UICODE.replace(/\/\*[\s\S]*?\*\//g, '');

check('dispatcher 摘录含 node_weight 与 resolve_firstchild',
	DISP_CODE.includes('function node_weight') && DISP_CODE.includes('function resolve_firstchild'));
check('dispatcher 摘录含登录后的 redirect',
	DISP_CODE.includes('http.redirect(build_url(...resolved.ctx.request_path))'));
check('基线 dispatcher 不读 action.preferred —— 仍靠 order 决胜',
	!DISP_CODE.includes('preferred'));
check('ui.js 摘录用的是 `order ?? 1000`（不是 `|| 1000`）',
	UI_CODE.includes('a.order ?? 1000') && !UI_CODE.includes('a.order || 1000'));
check('ui.js 的打平规则是 naturalCompare（与后端"先遍历到的"不同）',
	UI_CODE.includes('L.naturalCompare(a.name, b.name)'));

/* 上游 admin/status 上挂着 "preferred": "overview"，但 24.10 的 dispatcher 不读它。
 * 记录下来：哪天这一条变了，前面「靠 order 拿默认页」的做法就要重新评估。 */
check('已记录 admin/status 上挂着 preferred 字段这一潜在变数',
	UPSTREAM['admin/status']?.action?.preferred === 'overview',
	JSON.stringify(UPSTREAM['admin/status']?.action));

console.log('\n======================================');
console.log('  pass ' + pass + '   fail ' + fail);
console.log('======================================');
process.exit(fail ? 1 : 0);
