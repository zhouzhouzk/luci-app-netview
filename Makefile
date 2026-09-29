#
# luci-app-netview - realtime network traffic monitor for LuCI
#
# Build inside an OpenWrt / ImmortalWrt buildroot or SDK:
#   cp -r luci-app-netview package/
#   make package/luci-app-netview/compile V=s
#
# Or, with no SDK at all, use the standalone builder next to this file:
#   python build-ipk.py
#
# Tested against ImmortalWrt 24.10.6 (x86/64).
#
# Every runtime dependency below is part of a stock ImmortalWrt image, so the
# package installs without pulling anything in:
#   luci-base  JS view runtime; `require rpc/poll/view` all resolve (view, poll
#              and baseclass are built into luci.js since LuCI 23.x), and it
#              owns the admin/status menu node this app hangs under
#   rpcd       execution environment for /usr/libexec/rpcd/ plugins
#   jshn       /usr/share/libubox/jshn.sh -- used for JSON both ways
#   netifd     provides ifstatus, used to resolve the WAN/LAN l3_device
#
# Not a package dependency, but required for the device ranking: the kernel
# needs conntrack flow accounting. kmod-nf-conntrack is pulled in by firewall4
# on every stock image; see README for how the code detects it being switched
# off at runtime.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-netview
PKG_VERSION:=1.4.1
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=zhouzhouzk

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-netview
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=LuCI NetView - realtime traffic monitor
  DEPENDS:=+luci-base +rpcd +jshn +netifd
  PKGARCH:=all
endef

define Package/luci-app-netview/description
  Realtime per-interface and per-device network traffic monitor.
  Interface rates come from /proc/net/dev, device ranking is aggregated
  from the kernel conntrack table. No extra packages required.
endef

define Build/Compile
endef

define Package/luci-app-netview/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/netview
	$(CP) ./htdocs/luci-static/resources/view/netview/*.js \
		$(1)/www/luci-static/resources/view/netview/

	$(INSTALL_DIR) $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/netview $(1)/usr/libexec/rpcd/netview

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-netview.json \
		$(1)/usr/share/rpcd/acl.d/luci-app-netview.json

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-netview.json \
		$(1)/usr/share/luci/menu.d/luci-app-netview.json
endef

# Note: $$ is Make escaping -- it becomes a single $ in the installed script.
# The LuCI menu / ACL index is cached in /tmp, and rpcd only rescans
# /usr/libexec/rpcd and /usr/share/rpcd/acl.d when it is reloaded, so both have
# to happen for the new ubus object and menu entry to show up without a reboot.
define Package/luci-app-netview/postinst
#!/bin/sh
[ "$${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s "$${IPKG_INSTROOT}/lib/functions.sh" ] && {
. "$${IPKG_INSTROOT}/lib/functions.sh"
default_postinst "$$0" "$$@"
}
[ -n "$${IPKG_INSTROOT}" ] || {
rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache/
/etc/init.d/rpcd reload 2>/dev/null
}
exit 0
endef

define Package/luci-app-netview/prerm
#!/bin/sh
[ -s "$${IPKG_INSTROOT}/lib/functions.sh" ] && {
. "$${IPKG_INSTROOT}/lib/functions.sh"
default_prerm "$$0" "$$@"
}
[ -n "$${IPKG_INSTROOT}" ] || {
rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache/
/etc/init.d/rpcd reload 2>/dev/null
}
exit 0
endef

$(eval $(call BuildPackage,luci-app-netview))
