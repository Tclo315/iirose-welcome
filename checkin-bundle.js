/* ============================================================
 * iiRose 每日签到插件 v2（checkin-bundle.js）
 * 由 loader 从远端加载，装在 iirose 工具-终端里
 *
 * 逻辑：每 30 秒检查一次，三个条件全满足才发 /z——
 *   ① 到达每天 06:00（含补发：过点后打开页面也有效）
 *   ② 今天还没发过（localStorage 记录，刷新/多标签不会重复）
 *   ③ 目标成员（默认"小椰"）在房间名单里，且与你在同一房间
 *      —— 名单直接读客户端内存里的全站成员表（Objs.mapHolder.Assets.userJson），
 *         包含"你进房前就已在线"的人；小椰上线后 ≤30 秒会被检测到
 *   条件③不满足就静默等待，满足的瞬间自动补签。
 *   名单读不到（iirose 改版）时：保守模式，不发送，控制台提示。
 *
 * 控制台临时调整（改完立即生效，刷新后恢复默认）：
 *  __CHECKIN__.enabled = false            暂停 / true 恢复
 *  __CHECKIN__.time = '07:30'             改触发时间
 *  __CHECKIN__.targetName = '小椰'        改在场判定的成员
 *  __CHECKIN__.trigger()                  立即按当前条件试签一次（测试用，忽略时间）
 *  __CHECKIN__.status()                   查看当前各条件状态
 *  localStorage.removeItem('iirose_checkin_last')   清除"今天已发"（测试用）
 * ============================================================ */
(function () {
  if (window.__CHECKIN_LOADED__) { console.log('[签到] 本页面已加载过一次'); return; }
  window.__CHECKIN_LOADED__ = true;

  var CONFIG = {
    time: '06:00',        // 每天发送的时刻（本机时间，24小时制）
    message: '/z',        // 发送的内容
    color: 'ffffff',      // 消息颜色，6位十六进制，不带#
    enabled: true,        // 总开关
    catchUp: true,        // 补发：过了时间点打开页面时，当天没发就等条件满足立即补
    targetName: '小椰',   // 在场判定：这个人且与你同房间才签
    strictList: true      // 名单读不到时 true=不发送（保守），false=照常发送
  };
  window.__CHECKIN__ = CONFIG;

  var KEY = 'iirose_checkin_last';   // localStorage 里记录"最后发送日期"

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function getLast() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setLast(v) { try { localStorage.setItem(KEY, v); } catch (e) { } }
  function clearLast() { try { localStorage.removeItem(KEY); } catch (e) { } }

  // 客户端把 WebSocket 挂在 window.socket 上；真实聊天页可能在 mainFrame 框架里
  function findSock() {
    if (window.socket && typeof window.socket._onmessage === 'function') {
      return { sock: window.socket, win: window };
    }
    var f = document.getElementById('mainFrame');
    try {
      if (f && f.contentWindow && f.contentWindow.socket &&
          typeof f.contentWindow.socket._onmessage === 'function') {
        return { sock: f.contentWindow.socket, win: f.contentWindow };
      }
    } catch (e) { /* 跨框架受限时忽略 */ }
    return null;
  }

  // 协议要求 i 字段是 12 位随机数
  function randomId() {
    var s = String(Math.random()).replace('0.', '');
    while (s.length < 12) s += '0';
    return s.slice(0, 12);
  }

  function toast(msg) {
    try {
      var found = findSock();
      var doc = (found && found.win.document) || document;
      var d = doc.createElement('div');
      d.textContent = msg;
      d.style.cssText = 'position:fixed;left:50%;top:15%;transform:translateX(-50%);'
        + 'background:rgba(0,0,0,.75);color:#fff;padding:10px 18px;border-radius:8px;'
        + 'font-size:14px;z-index:99999;pointer-events:none;transition:opacity .4s;';
      doc.body.appendChild(d);
      setTimeout(function () { d.style.opacity = '0'; }, 1800);
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2400);
    } catch (e) { }
    console.log('[签到提示] ' + msg);
  }

  // 当前所在房间 id：优先读全局变量 roomn，读不到再翻 cookie roomsave
  function roomOf(win) {
    try { if (win.roomn) return String(win.roomn); } catch (e) { }
    try {
      var m = win.document.cookie.match(/(?:^|;\s*)roomsave=([^;]*)/);
      if (m) return decodeURIComponent(m[1]);
    } catch (e) { }
    return null;
  }

  // 目标成员在场判定。
  // 返回 true=在名单且与你同房间；false=不在/在别的房间；null=名单或房间读不到
  function targetHere(win) {
    try {
      var assets = win.Objs && win.Objs.mapHolder && win.Objs.mapHolder.Assets;
      if (!assets || !assets.userJson) return null;
      var myRoom = roomOf(win);
      if (!myRoom) return null;
      var rec = assets.userJson[String(CONFIG.targetName || '').toLowerCase()];
      if (!rec) return false;
      return String(rec[4]) === myRoom;    // 记录第5个字段=所在房间id
    } catch (e) { return null; }
  }

  // 现在是否已过了当天的触发时刻
  function timeReached() {
    var t = String(CONFIG.time || '06:00').split(':');
    var h = parseInt(t[0], 10) || 0, mi = parseInt(t[1], 10) || 0;
    var now = new Date();
    return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= mi);
  }

  // 补发关闭时，只在触发时刻后 60 分钟内发（过了窗口就等明天）
  function inWindow() {
    if (CONFIG.catchUp) return true;
    var t = String(CONFIG.time || '06:00').split(':');
    var h = parseInt(t[0], 10) || 0, mi = parseInt(t[1], 10) || 0;
    var now = new Date();
    var passed = (now.getHours() - h) * 60 + (now.getMinutes() - mi);
    return passed >= 0 && passed <= 60;
  }

  function sendCheckin(found) {
    try {
      found.sock.send(JSON.stringify({ m: CONFIG.message, mc: CONFIG.color, i: randomId() }));
      return true;
    } catch (e) { return false; }
  }

  var lastState = '';   // 去重打印：状态变化才输出日志
  function noteState(s) {
    if (s === lastState) return;
    lastState = s;
    console.log('[签到] ' + s);
  }

  function attemptSend(ignoreTime) {
    var found = findSock();
    if (!found) { noteState('等待连接（未登录或未进房）…'); return; }
    if (!CONFIG.enabled) return;
    if (!ignoreTime && (!timeReached() || !inWindow())) return;
    if (getLast() === todayStr()) return;   // 今天已发过

    var p = targetHere(found.win);
    if (p === null) {
      if (CONFIG.strictList) {
        noteState('读不到房间名单（iirose 可能改版），保守模式暂不签到——请反馈给开发者');
        return;
      }
      p = true;   // 宽松模式：读不到当作在场
    }
    if (!p) {
      noteState('到点了，但 ' + CONFIG.targetName + ' 还不在房间，等待中…');
      return;
    }

    setLast(todayStr());                    // 先占住日期，多标签/刷新不会重复发
    if (sendCheckin(found)) {
      toast('【签到】已发送 ' + CONFIG.message + ' ✔');
      lastState = 'sent';
    } else {
      clearLast();                          // 没发出去，下个周期重试
      noteState('发送失败，稍后重试…');
    }
  }

  CONFIG.status = function () {
    var found = findSock();
    var p = found ? targetHere(found.win) : null;
    console.log('[签到状态]', {
      时间: CONFIG.time,
      已到点: timeReached(),
      今天已发: getLast() === todayStr(),
      判定成员: CONFIG.targetName,
      成员在场: p === true ? '在，且与你同房间' : (p === false ? '不在/在别的房间' : '名单读不到'),
      当前房间: found ? roomOf(found.win) : '未连接',
      开关: CONFIG.enabled ? '开' : '关'
    });
  };
  CONFIG.trigger = function () { attemptSend(true); };

  // 主循环：每 30 秒查一次"到点没发"。
  // 前台精确到半分钟内；后台标签页浏览器会把定时器降到至少 1 分钟一次，
  // 也就晚一两分钟，可接受。电脑睡眠唤醒后靠这个循环自然补上。
  setInterval(function () { attemptSend(false); }, 30000);
  setTimeout(function () { attemptSend(false); }, 1000);   // 加载完先查一次（补发场景）

  console.log('%c[签到插件 v2] 已启动：每天 ' + CONFIG.time + '，' + CONFIG.targetName + ' 在房间时自动发 ' + CONFIG.message,
    'background:#08c;color:#fff;padding:2px 6px');
  console.log('[签到插件] __CHECKIN__.status() 看状态；__CHECKIN__.trigger() 立即试签（测试用）');
})();
