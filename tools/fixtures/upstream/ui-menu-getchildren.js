/* ---------------------------------------------------------------------------
 * 来源：openwrt/luci，分支 openwrt-24.10，
 *      文件 modules/luci-base/htdocs/luci-static/resources/ui.js
 *   https://raw.githubusercontent.com/openwrt/luci/openwrt-24.10/modules/luci-base/htdocs/luci-static/resources/ui.js
 *   抓取时整份文件的 sha256：50a9e92586a6fc0f5793f586a7082dbf27b027e00e5e25b30e262d8480665977
 *
 * 为什么存这段：菜单在侧边栏里排第几，由这份文件里的 ui.menu.getChildren() 决定，
 * 而不是后端。它和后端 dispatcher 的排序规则**并不一样**，差异就藏在"打平"上：
 *
 *   后端 resolve_firstchild()  order 相同时 —— 保留先遍历到的（取决于 menu.d 加载顺序）
 *   前端 getChildren()        order 相同时 —— 按 L.naturalCompare(name) 排
 *
 * 所以两个 order 相同的菜单项，可能出现"侧边栏里在左边、登录却落在右边"的错位。
 * 结论：要想稳，order 必须**严格小于**同层其它候选，不能靠打平。
 *
 * 另外注意这里用的是 `order ?? 1000`（nullish），不是 `order || 1000` ——
 * 也就是说 order: 0 是有效值，会被正常排到最前面，不会被当成 falsy 丢到末尾。
 * 后端那边是 `min(node.order ?? 9999, 9999)`，同样是 nullish。两边一致。
 *
 * 下面按行摘录 getChildren() 全函数（L3524-3566），未做任何改动。
 * ------------------------------------------------------------------------ */
	getChildren(node) {
		const children = [];

		if (node == null)
			node = this.menu;

		for (const k in node.children) {
			if (!node.children.hasOwnProperty(k))
				continue;

			if (!node.children[k].satisfied)
				continue;

			if (!node.children[k].hasOwnProperty('title'))
				continue;

			let subnode = Object.assign(node.children[k], { name: k });

			if (L.isObject(subnode.action) && subnode.action.path != null &&
				(subnode.action.type == 'alias' || subnode.action.type == 'rewrite')) {
				let root = this.menu;
				const path = subnode.action.path.split('/');

				for (let i = 0; root != null && i < path.length; i++)
					root = L.isObject(root.children) ? root.children[path[i]] : null;

				if (root)
					subnode = Object.assign({}, subnode, {
						children: root.children,
						action: root.action
					});
			}

			children.push(subnode);
		}

		return children.sort((a, b) => {
			const wA = a.order ?? 1000;
			const wB = b.order ?? 1000;

			if (wA != wB)
				return wA - wB;

			return L.naturalCompare(a.name, b.name);
		});
	}
