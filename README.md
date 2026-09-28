# luci-app-netview

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/zhouzhouzk/luci-app-netview?sort=semver)](https://github.com/zhouzhouzk/luci-app-netview/releases/latest)

ImmortalWrt / OpenWrt 的实时网络流量查看器（LuCI 插件）。

针对 **ImmortalWrt 24.10.6 (x86/64)** 编写，兼容 21.02 - 24.10 全系（LuCI2 / JS 版）。

界面参考 [iStoreOS](https://github.com/istoreos) 的快速设置页：左侧一块大卡片放汇总流量曲线，
右侧一列窄卡片放连接状态与接口信息，下方两张明细表。

## 功能

| 区块        | 内容                                                    | 数据来源                            |
| --------- | ----------------------------------------------------- | ------------------------------- |
| 流量统计（主图）  | 汇总 **WAN 出口**的实时上下行，平滑渐变面积曲线，保留最近 3 分钟                | `/proc/net/dev`                 |
| 连接状态      | 互联网是否连通、已连接时长                                         | `ifstatus wan`                  |
| 已连接设备     | 在线设备数量                                                | `/proc/net/arp`                 |
| IP 地址     | WAN 的 IPv4 / IPv6 / DNS，标注协议（DHCP / PPPoE / 静态）与 DNS 是否自动获取 | `ip addr`、`resolv.conf.auto`     |
| 网络接口状态    | 各网卡的协商速率（Mbit/s）与它承载的逻辑接口                             | `/sys/class/net/*/speed`        |
| 网络接口      | 每个接口的实时速率、最近 3 分钟曲线、累计收发                              | `/proc/net/dev`                 |
| 设备流量排行    | 局域网每台设备的实时速率、累计流量、连接数                                 | `/proc/net/nf_conntrack`        |

- **零额外安装**：不依赖 `nlbwmon`、`vnstat`、`collectd`，只用内核已有的 `/proc` 与 `/sys`
- **仅实时**：数据全部驻留内存，不落盘、不写数据库，重启即清空
- **WAN / LAN 自动识别**：通过 `ifstatus` 解析逻辑接口，自动打标签并优先排序
- **主图只统计 WAN**：不会把内网互传算成"上网流量"；识别不到 WAN 时退化为全部接口，保证图不空

## 依赖

以下依赖**全部包含在官方镜像里**，装这个包不会额外拉任何软件：

| 包           | 用途                                                             | 24.10.6 官方镜像       |
| ----------- | -------------------------------------------------------------- | ------------------ |
| `luci-base` | JS 视图运行时。`rpc` / `poll` / `view` 自 LuCI 23.x 起已内联进 `luci.js`，不再有独立文件；同时它提供本插件挂载的 `admin/status` 菜单父节点 | ✅ 已预装             |
| `rpcd`      | `/usr/libexec/rpcd/` 插件的执行环境，负责把脚本暴露成 ubus 对象                     | ✅ 已预装             |
| `jshn`      | `/usr/share/libubox/jshn.sh`，输入解析和输出生成都靠它                        | ✅ 已预装             |
| `netifd`    | 提供 `ifstatus`，用来把逻辑接口 wan/lan 解析成真实内核设备名                        | ✅ 已预装             |

另外还有一个**内核侧的功能前提**（不是包依赖，所以没有写进 `Depends`）：

| 内核模块                 | 用途                                      | 24.10.6 官方镜像 |
| -------------------- | --------------------------------------- | ---------- |
| `kmod-nf-conntrack`  | 设备排行需要 conntrack 的**流量记账**（`bytes=` 字段） | ✅ 已预装       |

它由 `firewall4 → kmod-nft-core → kmod-nf-conntrack6` 自动拉入，任何带防火墙的官方镜像都有。
内核默认 `nf_conntrack_acct=0`（关闭），是 OpenWrt 通过 `kmod-nf-conntrack` 附带的
`/etc/sysctl.d/11-nf-conntrack.conf` 把它打开的。如果你按某些"优化 NAT 内存"的教程把它关掉了，
页面会明确提示而不是显示一堆 0。

## 目录结构

```
luci-app-netview/
├── Makefile                                     # OpenWrt 包定义（可进 feed / SDK 编译）
├── build-ipk.py                                 # 独立 ipk 构建器（无需 SDK）
├── install.sh                                   # 免路由器编译的一键部署脚本
├── htdocs/luci-static/resources/view/netview/
│   └── overview.js                              # 前端视图
├── preview/
│   └── overview-preview.html                    # 本地界面预览（模拟数据，双击打开）
├── tools/                                       # 自检脚本，见「验证」一节
│   ├── render.test.js                           # 渲染函数、曲线几何、刻度取整
│   ├── parity.test.js                           # 预览页与视图的一致性
│   └── backend.test.sh                          # 后端 shell 辅助函数（假 sysfs 树）
└── root/
    ├── usr/libexec/rpcd/netview                 # rpcd 后端脚本（ubus 对象 netview）
    ├── usr/share/rpcd/acl.d/luci-app-netview.json
    └── usr/share/luci/menu.d/luci-app-netview.json
```

## 安装

### 方式 A：直接下载 ipk（推荐）

从 [Releases](https://github.com/zhouzhouzk/luci-app-netview/releases/latest) 下载
`luci-app-netview_1.1.0-r1_all.ipk`，传到路由器安装：

```sh
scp luci-app-netview_1.1.0-r1_all.ipk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'opkg install /tmp/luci-app-netview_1.1.0-r1_all.ipk'
```

也可以让路由器自己下载（省掉中转）：

```sh
cd /tmp
wget https://github.com/zhouzhouzk/luci-app-netview/releases/download/v1.1.0/luci-app-netview_1.1.0-r1_all.ipk
opkg install luci-app-netview_1.1.0-r1_all.ipk
```

卸载：`opkg remove luci-app-netview`。

`postinst` 会自动重建 LuCI 菜单缓存并 reload rpcd，所以装完刷新页面就能看到菜单，不用重启。
所有依赖都已预装，正常情况下 opkg 不会去联网解依赖；万一你的机器缺包且没配源，可以加
`--force-depends` 跳过检查。

> **注意 ipk 格式**：ImmortalWrt 24.10 起，`.ipk` 已不是老式的 `ar` 归档，而是
> `gzip(tar{./debian-binary, ./data.tar.gz, ./control.tar.gz})`。`build-ipk.py` 生成的就是这个新格式
> （成员名、顺序、tar 变体、八进制字段填充都与官方源里的包一致）。
> **23.05 及更早的 opkg 只认老格式**，那些版本请改用下面的方式 C 或进 SDK 编译。

### 方式 B：自己构建 ipk

需要 Python 3，不需要 OpenWrt SDK：

```sh
python build-ipk.py                    # 产物: dist/luci-app-netview_1.1.0-r1_all.ipk

scp dist/luci-app-netview_1.1.0-r1_all.ipk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'opkg install /tmp/luci-app-netview_1.1.0-r1_all.ipk'
```

### 方式 C：免编译一键部署

不想做成包、只想快点看到效果时用这个，直接 scp 四个文件上去：

```sh
cd luci-app-netview
./install.sh 192.168.1.1              # 默认 SSH 22 端口
./install.sh 192.168.1.1 2222         # 自定义端口
./install.sh --uninstall 192.168.1.1  # 卸载
```

### 方式 D：进 SDK / feed 编译

```sh
cp -r luci-app-netview package/
make package/luci-app-netview/compile V=s
# 产物: bin/packages/*/base/luci-app-netview_1.1.0-r1_all.ipk
```

装完打开 `http://192.168.1.1/cgi-bin/luci/admin/status/netview`，菜单位置：**状态 → 网络流量**。

## 构建 ipk

`build-ipk.py` 不需要 OpenWrt SDK，只依赖 Python 3。它从 `Makefile` 读元数据，所以
`PKG_VERSION` / `DEPENDS` / `postinst` 这些只需要在 Makefile 里维护一份。

```sh
python build-ipk.py                      # 默认输出到 dist/
python build-ipk.py -o /tmp/test.ipk     # 指定输出路径
python build-ipk.py --epoch 1780000000   # 指定 SOURCE_DATE_EPOCH，用于可复现构建
python build-ipk.py --list               # 只看载荷清单，不生成文件
```

构建完会自己用标准 `tarfile` 重新解包校验一遍（成员顺序、`Installed-Size`、文件路径与权限位），
校验不通过会以非零码退出。

## 实现要点

**接口速率**：rpcd 脚本把 `/proc/net/dev` 的快照写入 `/tmp/netview/if.state`，
下次调用时用 `(bytes_now - bytes_prev) / (t_now - t_prev)` 求速率。因此**第一次调用会返回 0**，
第二次（约 3 秒后）起才有真实数值。

**接口元信息**：协商速率读 `/sys/class/net/<dev>/speed`。网桥（`br-lan`）自己没有这个文件，
脚本会回落到 `/sys/class/net/br-lan/brif/` 下的成员端口，取最快的一个；无线和隧道返回空或
`-1`，统一归一成 0（前端显示 `—`）。链路状态取 `operstate`。

**WAN 面貌**：`ifstatus wan` 取 `up` / `uptime` / `proto`，但地址**不走 JSON 解析**，而是直接问
`ip -4/-6 addr show ... scope global`，DNS 读 netifd 写下的
`/tmp/resolv.conf.d/resolv.conf.auto`。这样绕开了 jshn 读嵌套数组的麻烦——jshn 把数组元素按
`key_<index>` 展平，写起来绕；更麻烦的是它的状态全在全局 shell 变量里，内层再调一次
`json_load` 会把正在拼装的输出文档冲掉，所以所有取值都在 `json_init` 开输出文档**之前**完成。

**已连接设备数**：数 `/proc/net/arp` 里 flags 为 `0x2`（complete）的条目。注意这是"在线主机数"，
和下面按 conntrack 聚合出来的"有流量的设备"不是一个口径，两个数字对不上是正常的——ARP 条目
有约一分钟残留，而 conntrack 只统计经过 NAT 转发的连接。

**设备流量**：解析内核 conntrack 表。每条连接记录有两个方向的字节计数器：

- 反向 tuple（内网 → 外网）的 bytes 计为该设备的上行
- 正向 reply（外网 → 内网）的 bytes 计为该设备的下行
- 若是外网主动发起（端口转发），则方向对调

主机名从 `/tmp/dhcp.leases` 匹配，匹配不到显示「未知设备」。

**流量记账检测**：采样前先确认 conntrack 表里存在 `bytes=` 字段。若表里有连接但没有字节计数，
说明 `nf_conntrack_acct` 被关掉了，接口直接返回 `error: "conntrack_acct_disabled"`，
前端会显示修复命令——避免"看起来正常但全是 0"这种最难排查的状态。

> 注意：conntrack 条目会随连接超时被回收，所以设备级"累计流量"是**当前存活连接的累计值**，
> 不等于该设备开机以来的总流量。这是"仅实时"方案的固有取舍 —— 想要精确的长期累计需改用 `nlbwmon`。

## 外观与主题适配

外观按 iStoreOS 快速设置页做：浅灰底 + 白色卡片 + 柔和投影，主图是蓝色（下载）/ 紫色（上传）
两个渐变面积叠加。所有颜色通过挂在 `.nv-root` 上的 `--nv-*` 自定义属性下发，取值形式统一是
`var(--oc-surface, <内置回退>)`：

- 装了 [luci-theme-argon](https://github.com/jerrykuku/luci-theme-argon) 时 `--oc-*` 生效，
  卡片、边框、文字自动融进主题。Argon 的暗色模式是**整份替换样式表**（`cascade.css` → `dark.css`），
  两套各自完整定义了 `--oc-*`，所以明暗切换不需要写任何 `prefers-color-scheme`
- 没装 Argon（或主题不定义 `--oc-*`）时回退到内置亮色值；系统偏好为深色时，由一段
  `@media (prefers-color-scheme: dark)` 换成内置暗色值
- **数据色刻意不跟随主题主色**：下载蓝 `#4a9df5`、上传紫 `#8b5cf6` 是两个系列的身份标识，
  在明暗两套下保持同一色相才便于对照

布局与渲染细节：

- 主区 `grid-template-columns: minmax(0,1fr) 344px`，窗口窄于 1000px 时塌成单列
- 主图用 `viewBox` + `preserveAspectRatio="none"`，因此不需要在渲染时测量容器宽度
- 曲线走 Catmull-Rom 转三次贝塞尔（张力 0.18），外层套 `clipPath` 防止平滑过冲溢出画布
- 纵轴刻度按 `1 / 1.25 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 / 10` 阶梯取整，并按 35% 渐进跟随，
  避免数值在档位边界来回跳；空闲时有 32 KB/s 地板值，免得把噪声放大成满屏尖峰。
  （粗档位阶梯会让 2.8 MB/s 的峰值取到 5 MB/s，曲线只占一半高度，白白浪费卡片空间）

安装 Argon 主题（可选，走官方源比下 GitHub release 省事）：

```sh
opkg update
opkg install luci-theme-argon luci-app-argon-config luci-i18n-argon-config-zh-cn
```

24.10.6 源里的版本是 `luci-theme-argon 2.4.3-r20250722`（依赖 `wget`、`jsonfilter`，
后者用于在线壁纸功能）。

本地预览页 `preview/overview-preview.html` 用模拟数据驱动同一套渲染代码，右上角可切换亮/暗模式。
它是**手工同步的副本**，改样式时两个文件都要动 —— `tools/parity.test.js` 就是用来防这件事的。

## 验证

仓库自带三组自检，只依赖 Node.js 与 POSIX shell，不需要路由器：

```sh
node tools/render.test.js     # 渲染函数 / 曲线几何 / 刻度取整 / 空数据与错误分支
node tools/parity.test.js     # 预览页与视图：CSS 与渲染输出必须逐字节一致
sh   tools/backend.test.sh    # 后端 shell 辅助函数（用假 sysfs 树跑）
```

- `render.test.js` 会把视图模块在沙箱里加载，用构造出的 ubus 报文调用各个渲染函数，
  断言输出里不出现 `NaN` / `undefined`。几何部分进一步校验曲线坐标落在画布内、
  面积在基线闭合、峰值不会离顶部太远（只查 NaN 是抓不到"曲线被压扁"的）
- `parity.test.js` 剥掉预览页独有的 `.nv-force-dark` 覆盖块后，要求两边 CSS 完全一致，
  并用同一份输入比对 `sideHtml` / `ifTableHtml` / `chartSvg` / 格式化函数的输出
- `backend.test.sh` 把脚本里硬编码的 `/sys/class/net` 重定向到临时假目录，
  真实执行 `if_speed` / `if_roles` / `addr_of`，覆盖网桥成员口回退、无线空值、
  隧道 `-1`、`wan` 与 `wan6` 落在同一物理口等边界


## 排错

| 现象                            | 处理                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| 菜单里没有「网络流量」                   | `rm -f /tmp/luci-indexcache* && rm -rf /tmp/luci-modulecache && /etc/init.d/rpcd reload`，再强制刷新浏览器（Ctrl+F5） |
| 页面空白 / 报 `netview` 未找到        | 登录路由器执行 `ubus -v list netview`，无输出说明 rpcd 插件没加载成功，检查 `/usr/libexec/rpcd/netview` 是否有执行权限 |
| 速率一直显示 0 B/s                   | 正常，第一次采样没有基准值，等 3 秒后自动出数                                                                 |
| 设备排行提示「未开启流量记账」               | 执行 `sysctl -w net.netfilter.nf_conntrack_acct=1`；并在 `/etc/sysctl.d/11-nf-conntrack.conf` 里确认该值为 1，否则重启后失效 |
| 设备排行显示「暂无活动的 NAT / 转发连接」      | 只有经过 NAT 转发的连接会被统计，路由器自身发起的流量不计入；确认 `lsmod \| grep nf_conntrack` 有输出                    |
| 设备排行只有 IP 没有主机名               | `/tmp/dhcp.leases` 里没有该 IP 的记录（静态 IP 或 DHCP 租约过期）                                       |
| `opkg install` 报依赖无法满足         | 用 `opkg install --force-depends <包>`；正常情况下四个依赖都已预装，不需要联网                             |
| 主图一直停在"正在采集数据"             | 首次采样没有基准值，等 3 秒；若一直如此说明后端没返回，登录路由器执行 `ubus call netview interfaces` 看输出           |
| 连接状态显示"未连接互联网"但其实能上网      | 判断依据是 `ifstatus wan` 的 `up`。WAN 接口不叫 `wan`（多 WAN / 自定义名）时就会误报                       |
| IP 地址显示"未获取"                 | 确认 `ip -4 addr show dev <wan设备> scope global` 有输出；WAN 设备名取自 `ifstatus` 的 `l3_device`      |
| 网卡速率显示"—"                    | 无线、隧道以及部分虚拟设备没有 `speed` 属性；网桥会回落到成员端口，都没有就显示 `—`                          |
| 曲线看起来太"平"                    | 空闲链路上纵轴有 32 KB/s 地板值，避免噪声被放大成满屏尖峰；有实际流量时曲线才会撑起来                            |
| "已连接设备"数与设备排行条数对不上        | 两个口径不同：前者数 ARP 在线主机，后者只统计经过 NAT 转发且有流量的设备                                     |

## License

[Apache License 2.0](LICENSE)

Copyright 2026 zhouzhouzk
