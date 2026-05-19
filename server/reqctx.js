const UAParser = require("ua-parser-js");
let geoip = null;
try { geoip = require("geoip-lite"); } catch { /* optional */ }

function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  return (req.ip || "").replace(/^::ffff:/, "");
}

function parseDevice(uaHeader) {
  const ua = uaHeader || "";
  if (!ua) return { ua: "", browser: null, os: null, device: null, deviceLabel: "unknown" };
  const p = new UAParser(ua);
  const b = p.getBrowser();
  const o = p.getOS();
  const d = p.getDevice();
  const browser = b.name ? `${b.name}${b.version ? " " + b.version.split(".")[0] : ""}` : null;
  const os = o.name ? `${o.name}${o.version ? " " + o.version : ""}` : null;
  const device = d.vendor || d.model || d.type || null;
  const label = [browser, os, device].filter(Boolean).join(" · ") || "unknown";
  return { ua, browser, os, device, deviceLabel: label };
}

function lookupGeo(ip) {
  if (!geoip || !ip) return null;
  if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("172.")) {
    return { local: true };
  }
  const g = geoip.lookup(ip);
  if (!g) return null;
  return {
    country: g.country || null,
    region: g.region || null,
    city: g.city || null,
    timezone: g.timezone || null,
    label: [g.city, g.region, g.country].filter(Boolean).join(", ")
  };
}

function build(req) {
  const ip = clientIp(req);
  const ua = req.headers["user-agent"] || "";
  const device = parseDevice(ua);
  const geo = lookupGeo(ip);
  return {
    ip,
    ua,
    browser: device.browser,
    os: device.os,
    device: device.device,
    deviceLabel: device.deviceLabel,
    geo,
    geoLabel: geo && geo.local ? "(local network)" : (geo && geo.label) || null,
    acceptLanguage: req.headers["accept-language"] || null
  };
}

module.exports = { build, clientIp, parseDevice, lookupGeo };
