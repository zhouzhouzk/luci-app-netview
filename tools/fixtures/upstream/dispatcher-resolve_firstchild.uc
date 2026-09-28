/* ---------------------------------------------------------------------------
 * 来源：openwrt/luci，分支 openwrt-24.10，文件 modules/luci-base/ucode/dispatcher.uc
 *   https://raw.githubusercontent.com/openwrt/luci/openwrt-24.10/modules/luci-base/ucode/dispatcher.uc
 *   分支上该文件最近一次改动：d0400718c508 (2026-07-21)
 *   抓取时整份文件的 sha256：5866f9b08729dab3a22956483f506a24ebf8e99003c8a47d958e8b7bcff50c3a
 *   ImmortalWrt 的 immortalwrt/luci@openwrt-24.10 里这份文件与上游字节一致。
 *
 * 为什么存这段：**菜单的 order 同时决定了"登录后落在哪一页"**，这个契约在
 * menu.d 里完全看不出来（改 order 表面上只是挪了一下菜单顺序）。tools/menu.test.js
 * 把下面的逻辑翻译成 JS 去跑，这份原文就是它的依据；上游一旦改动（比如开始读取
 * admin/status 上的 "preferred" 字段），测试里的漂移断言会失败，提醒重新核对。
 *
 * 下面是逐段摘录，不是完整文件；每段的起止行号对应上面那一版。
 * ------------------------------------------------------------------------ */

/* ---- build_pagetree(): 把 menu.d 的 "a/b/c" 展开成节点树 (L386-411) ----
 * 关键点：中间节点（admin、admin/status）只是 `{ satisfied: true }`，
 * 没有 title 也没有 action —— 除非有人显式声明了 "admin/status" 这个 key。
 */
		if (type(data) == 'object') {
			for (let path, spec in data) {
				if (type(spec) == 'object') {
					let node = tree;

					for (let s in match(path, /[^\/]+/g)) {
						if (s[0] == '*') {
							node.wildcard = true;
							break;
						}

						node.children ??= {};
						node.children[s[0]] ??= { satisfied: true };
						node = node.children[s[0]];
					}

					if (node !== tree) {
						for (let k, t in schema)
							if (type(spec[k]) == t)
								node[k] = spec[k];

						node.satisfied = check_depends(spec);
					}
				}
			}
		}

/* ---- node_weight(): 越小越优先 (L547-554) ----
 * order 缺省按 9999 算；要求登录的节点额外 +10000，所以未登录时它永远排在
 * 不需要登录的节点后面。
 */
function node_weight(node) {
	let weight = min(node.order ?? 9999, 9999);

	if (node.auth?.login)
		weight += 10000;

	return weight;
}

/* ---- resolve_firstchild(): 挑出默认落地项 (L574-616) ----
 * 逐条看：
 *   - 只有同时有 title 和 action 的节点才是候选（中间节点因此被跳过）
 *   - action 是 firstchild 的节点会被递归进去，取它子树里的结果
 *   - 其它节点要 firstchild_ineligible 不为真才参与比较（admin/logout 就靠它出局）
 *   - 多个候选取 node_weight 最小者；相等时保留先遍历到的那个，
 *     而遍历顺序是 menu.d 文件的加载顺序 —— 所以**不要靠 order 打平**，
 *     要赢就得严格更小
 * 注意里边并没有读 action.preferred。
 */
function resolve_firstchild(node, session, login_allowed, ctx) {
	let candidate, candidate_ctx;

	for (let name, child in node.children) {
		if (!child.satisfied)
			continue;

		if (!session)
			session = is_authenticated(node.auth);

		let cacl = child.depends?.acl;
		let login = !session && (login_allowed || child.auth?.login);

		if (login || check_acl_depends(cacl, session?.acls?.["access-group"]) != null) {
			if (child.title && type(child.action) == "object") {
				let child_ctx = ctx_append(clone(ctx), name, child);
				if (child.action.type == "firstchild") {
					if (!candidate || node_weight(candidate) > node_weight(child)) {
						let have_grandchild = resolve_firstchild(child, session, login, child_ctx);
						if (have_grandchild) {
							candidate = child;
							candidate_ctx = child_ctx;
						}
					}
				}
				else if (!child.firstchild_ineligible) {
					if (!candidate || node_weight(candidate) > node_weight(child)) {
						candidate = child;
						candidate_ctx = child_ctx;
					}
				}
			}
		}
	}

	if (!candidate)
		return false;

	for (let k, v in candidate_ctx)
		ctx[k] = v;

	return true;
}

/* ---- 登录成功后跳去哪 (L944-948) ----
 * redirect 回 resolved.ctx.request_path，也就是**首次访问时解析出的那条路径**。
 * 所以访问 /cgi-bin/luci（无路径）→ firstchild 解析 → 登录页 → 登录成功 → 跳解析结果。
 * 这就是"菜单 order 决定登录落地页"的最后一环。
 */
				let cookie_name = (http.getenv('HTTPS') == 'on') ? 'sysauth_https' : 'sysauth_http',
				    cookie_secure = (http.getenv('HTTPS') == 'on') ? '; secure' : '';

				http.header('Set-Cookie', `${cookie_name}=${session.sid}; path=${build_url()}; SameSite=strict; HttpOnly${cookie_secure}`);
				http.redirect(build_url(...resolved.ctx.request_path));
