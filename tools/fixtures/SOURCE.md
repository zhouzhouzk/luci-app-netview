# 测试基线文件的来源

这里的文件不是本项目的代码，是从上游原样抓下来的**测试基线**。
`tools/menu.test.js` 拿它们跑「登录后落在哪一页」的回归测试。

## menu.d/

| 文件 | 来源 |
| --- | --- |
| `luci-base.json` | openwrt/luci @ `openwrt-24.10` → `modules/luci-base/root/usr/share/luci/menu.d/luci-base.json` |
| `luci-mod-status.json` | openwrt/luci @ `openwrt-24.10` → `modules/luci-mod-status/root/usr/share/luci/menu.d/luci-mod-status.json` |

这两个文件定义了 `admin`、`admin/status` 这两个中间节点，以及「状态」组下各页面的
`order`。默认落地页就是在它们和本插件的 menu.d 之间比出来的，所以测试必须带上它们，
不能自己编一份简化的。

固件里的菜单顺序（概况 1 / 路由 2 / 防火墙 3 / 系统日志 4 / 进程 6 / 实时信息 7）与
这份 `luci-mod-status.json` 完全吻合，可以用作交叉验证。

## upstream/

### `dispatcher-resolve_firstchild.uc`

openwrt/luci @ `openwrt-24.10` → `modules/luci-base/ucode/dispatcher.uc`

- 分支上该文件最近一次改动：`d0400718c508` (2026-07-21)
- 抓取时整份文件 sha256：`5866f9b08729dab3a22956483f506a24ebf8e99003c8a47d958e8b7bcff50c3a`
- `immortalwrt/luci@openwrt-24.10` 里这份文件与上游**字节一致**

摘录的是 `build_pagetree()` 的节点展开、`node_weight()`、`resolve_firstchild()`，
外加登录成功后那句 `http.redirect(...)`。**这四段合起来才解释了「菜单 order 决定登录
落地页」** —— 少了哪一段都串不起来。

### `ui-menu-getchildren.js`

openwrt/luci @ `openwrt-24.10` → `modules/luci-base/htdocs/luci-static/resources/ui.js`

- 抓取时整份文件 sha256：`50a9e92586a6fc0f5793f586a7082dbf27b027e00e5e25b30e262d8480665977`
- 摘录 `ui.menu.getChildren()` 全函数

侧边栏的排序在这里，不在后端。它和后端 `resolve_firstchild()` 的**打平规则不同**，
这个差异正是测试要盯住的东西之一，详见文件头的注释。

## 更新基线时

换掉文件、跑一遍 `node tools/menu.test.js`，看漂移断言是否还成立。
特别要确认这两件事没有变：

1. `resolve_firstchild()` 里**没有**开始读 `action.preferred`（那会让 order 失去意义）
2. `getChildren()` 里**仍然是** `order ?? 1000` 而不是 `order || 1000`
   （后者会把 `order: 0` 当成 falsy 丢到末尾）
