/* ============================================================
 * iiRose 进房欢迎插件 v1
 * 用法：进房间后按 F12 打开控制台，整段粘贴回车。
 * 看到绿色的"[欢迎插件] 已挂载"就说明成功了。
 * 刷新页面后插件会消失，需要重新粘贴（v1 先这样，之后升级持久化）。
 * ============================================================ */
(function () {
  if (window.__WELCOME_LOADED__) { console.log('[欢迎] 已经加载过一次，不要重复粘贴'); return; }

  /* ================= 配置区：想改就改这里 ================= */
  var CONFIG = {
    template: '，欢迎来到本房间～', // 欢迎语（插件会自动在前面帮你加 @某人）
    color: 'ffffff',               // 消息颜色，6位十六进制，不带#
    delayMs: 1500,                 // 检测到进房后延迟多少毫秒再发（像真人一点）
    cooldownMs: 300000,            // 同一个人5分钟内反复进出，只欢迎一次
    welcomeReconnect: true,        // 掉线重连回来的人要不要也欢迎
    enabled: true                  // 总开关。以后可在控制台输 __WELCOME__.enabled=false 临时关掉
  };
  window.__WELCOME__ = CONFIG;
  window.__WELCOME_LOADED__ = true;

  /* ================= 工具函数 ================= */
  // 客户端把 WebSocket 挂在 window.socket 上；真实聊天页可能在 mainFrame 框架里，
  // 所以两个地方都找一遍（同域名，跨框架操作是允许的）
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

  // 消息里的人名可能带 HTML 转义，发 @ 前先还原
  function unescapeName(s) {
    return String(s || '')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  // 协议要求 i 字段是 12 位随机数
  function randomId() {
    var s = String(Math.random()).replace('0.', '');
    while (s.length < 12) s += '0';
    return s.slice(0, 12);
  }

  function sendWelcome(name) {
    var found = findSock();
    if (!found) { console.warn('[欢迎] 要发送时找不到 socket 了'); return; }
    // iiRose 的 @ 格式： [*名字*] ，方括号星号包住，前后都必须有空格，
    // 少了空格客户端就不认为是 @，只会显示成普通文字 [*名字*]
    var text = ' [*' + name + '*] ' + CONFIG.template.replace(/^\s+/, '');
    found.sock.send(JSON.stringify({ m: text, mc: CONFIG.color, i: randomId() }));
    console.log('%c[欢迎] 已发送：' + text, 'color:#0af');
  }

  /* ================= 核心逻辑：识别进房事件 ================= */
  var lastWelcome = {};     // uid -> 上次欢迎的时间戳
  var loggedMarkers = {};   // 调试用：每种未知事件标记只打印一次，避免刷屏

  function handleFrame(text) {
    if (!CONFIG.enabled) return;
    // 只关心公屏类帧：以 " 开头；"" 开头是私聊，跳过
    if (typeof text !== 'string' || text.charAt(0) !== '"' || text.charAt(1) === '"') return;

    var f = text.split('>');
    if (f.length < 10) return;

    // 成员变动帧的特征：某一段是 '1（进房）。
    // 兼容两种字段位置（不同版本客户端见过两种排布）
    var markerIdx = 0;
    if (f[3] === "'1") markerIdx = 3;
    else if (f[4] === "'1") markerIdx = 4;
    else {
      var m = f[3] && f[3].charAt(0) === "'" ? f[3] : (f[4] && f[4].charAt(0) === "'" ? f[4] : null);
      if (m && !loggedMarkers[m]) {
        loggedMarkers[m] = true;
        console.log('[欢迎] 发现未处理的成员事件标记 ' + m + '，整帧：', text);
      }
      return;
    }

    var uid = f[8];
    var name = unescapeName(f[2]);
    if (!uid || !name) return;

    // 自己进房不打招呼
    var myUid = null;
    try { myUid = foundWin().uid || null; } catch (e) {}
    if (myUid && uid === myUid) return;

    // 是新进房还是重连：最后一个字段以 'n 结尾是新人，'d 是重连
    var last = f[f.length - 1] || '';
    var isReconnect = /'d$/.test(last);
    if (isReconnect && !CONFIG.welcomeReconnect) return;

    // 冷却：同一人短时间内只欢迎一次
    var now = Date.now();
    if (lastWelcome[uid] && now - lastWelcome[uid] < CONFIG.cooldownMs) return;
    lastWelcome[uid] = now;

    console.log('[欢迎] 检测到进房：' + name + '（' + (isReconnect ? '重连' : '新进') + '）');
    setTimeout(function () { sendWelcome(name); }, CONFIG.delayMs);
  }

  function foundWin() {
    var found = findSock();
    return found ? found.win : window;
  }

  /* ================= 挂钩：包装 socket._onmessage ================= */
  function tryHook() {
    var found = findSock();
    if (!found) return false;
    var sock = found.sock;
    if (sock._onmessage.__welcomeWrapped) return true;

    var orig = sock._onmessage;
    sock._onmessage = function () {
      try { handleFrame(arguments[0]); } catch (e) {
        console.warn('[欢迎] 处理帧出错（已放行给客户端，不影响正常聊天）', e);
      }
      return orig.apply(this, arguments);
    };
    sock._onmessage.__welcomeWrapped = true;
    return true;
  }

  // socket 可能还没创建好，每半秒试一次，最多试 40 次（20秒）
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (tryHook()) {
      clearInterval(timer);
      console.log('%c[欢迎插件] 已挂载！现在有人进房间就会自动 @ 欢迎', 'background:#0c0;color:#fff;padding:2px 6px');
      console.log('[欢迎插件] 提示：控制台输 __WELCOME__.enabled=false 可临时停止，输 __WELCOME__.enabled=true 恢复');
    } else if (tries > 40) {
      clearInterval(timer);
      console.warn('[欢迎插件] 20秒都没找到 window.socket —— 确认你已登录并进入了房间，再把脚本粘贴进控制台');
    }
  }, 500);
})();
