/* ═══════════════════════════════════════════════════════════
   BadBoy Kick — api.js
   طبقة الشبكة + دالة إرسال الرسائل (مفصولة عن index.html)
   يُحمَّل هذا الملف داخل index.html عبر:
   <script src="api.js"></script>
   ويجب أن يوضع قبل السكربت الرئيسي في الصفحة
   ═══════════════════════════════════════════════════════════ */

var KICK_BASE = 'https://kick.com';
var $ = function(id) { return document.getElementById(id); };

// ═══════════════════════════════════════
//  البروكسي
// ═══════════════════════════════════════
var PROXIES = [
    { name:'corsproxy.io', build:function(u){return 'https://api.corsproxy.io/?url='+encodeURIComponent(u);}, canPost:true },
    { name:'corsfix', build:function(u){return 'https://proxy.corsfix.com/?'+u;}, canPost:true },
    { name:'cors-worker', build:function(u){return 'https://test.cors.workers.dev/?'+u;}, canPost:true },
    { name:'corsproxy.org', build:function(u){return 'https://corsproxy.org/?'+encodeURIComponent(u);}, canPost:true },
    { name:'codetabs', build:function(u){return 'https://api.codetabs.com/v1/proxy/?quest='+encodeURIComponent(u);}, canPost:false },
    { name:'allorigins', build:function(u){return 'https://api.allorigins.win/raw?url='+encodeURIComponent(u);}, canPost:false },
    { name:'direct', build:function(u){return u;}, canPost:true }
];

var activeProxy = 0;
var xsrfToken = '';
var isDirectMode = false;

function detectMode() {
    try { isDirectMode = window.location.hostname === 'kick.com' || window.location.hostname.endsWith('.kick.com'); } catch(e) { isDirectMode=false; }
    if (isDirectMode) activeProxy = PROXIES.length - 1;
}

var _bestProxy = -1;
var _proxyFailCount = {};

var BEST_PROXY_KEY = 'redkick_best_proxy_v2';

function loadBestProxy() {
    try {
        var v = parseInt(localStorage.getItem(BEST_PROXY_KEY));
        if (!isNaN(v) && v >= 0 && v < PROXIES.length) _bestProxy = v;
    } catch(e) {}
}
function saveBestProxy() {
    try {
        if (_bestProxy >= 0) localStorage.setItem(BEST_PROXY_KEY, String(_bestProxy));
    } catch(e) {}
}

async function prewarmProxies() {
    var testSlug = 'kick';
    var candidates = [];
    if (_bestProxy >= 0) candidates.push(_bestProxy);
    for (var i = 0; i < PROXIES.length; i++) {
        if (candidates.indexOf(i) === -1) candidates.push(i);
    }
    for (var pi = 0; pi < candidates.length; pi++) {
        var p = candidates[pi];
        try {
            var res = await Promise.race([
                fetch(PROXIES[p].build(KICK_BASE + '/api/v2/channels/' + testSlug), {method:'GET'}),
                new Promise(function(_, reject){ setTimeout(function(){ reject(new Error('timeout')); }, 4000); })
            ]);
            if (res && res.ok) {
                _bestProxy = p;
                _proxyFailCount[p] = 0;
                saveBestProxy();
                return p;
            }
        } catch(e) {
            _proxyFailCount[p] = (_proxyFailCount[p] || 0) + 1;
        }
    }
    return -1;
}

function getProxyOrder(preferredProxy) {
    var order = [];
    if (preferredProxy !== undefined && preferredProxy >= 0) order.push(preferredProxy);
    if (_bestProxy >= 0 && order.indexOf(_bestProxy) === -1) order.push(_bestProxy);
    var remaining = [];
    for (var i = 0; i < PROXIES.length; i++) {
        if (order.indexOf(i) === -1) remaining.push(i);
    }
    remaining.sort(function(a, b) {
        return (_proxyFailCount[a] || 0) - (_proxyFailCount[b] || 0);
    });
    return order.concat(remaining);
}

async function proxiedFetch(kickPath, options) {
    options = options || {};
    var method = options.method || 'GET';
    var body = options.body || null;
    var headers = options.headers || {};
    var timeout = options.timeout || 8000;
    var skipAuth = options.skipAuth || false;
    var token = options.token || '';
    var preferredProxy = options.preferredProxy;
    var requireOk = options.requireOk || false;
    var isPost = (method !== 'GET');

    var defHeaders = { 'Accept':'application/json' };
    if (isPost) defHeaders['Content-Type'] = 'application/json';
    defHeaders['Origin'] = KICK_BASE;
    if (!skipAuth && token) defHeaders['Authorization'] = 'Bearer ' + token;
    if (xsrfToken) defHeaders['X-XSRF-TOKEN'] = xsrfToken;
    for (var k in headers) defHeaders[k] = headers[k];

    var fetchOpts = { method:method, headers:defHeaders, credentials:isDirectMode?'include':'omit' };
    if (body && isPost) fetchOpts.body = JSON.stringify(body);

    var fullUrl = KICK_BASE + kickPath;
    var lastError = null;
    var lastBad = null; // ✅ آخر ردّ غير ناجح (يُستخدم مع requireOk)

    var order = getProxyOrder(preferredProxy);

    for (var pi = 0; pi < order.length; pi++) {
        var p = order[pi];
        if (isPost && !PROXIES[p].canPost) continue;
        var url = PROXIES[p].build(fullUrl);
        var opts = Object.assign({}, fetchOpts);
        opts.credentials = (isDirectMode && p === PROXIES.length-1) ? 'include' : 'omit';
        try {
            var res = await Promise.race([
                fetch(url, opts),
                new Promise(function(_, reject) { setTimeout(function(){ reject(new Error('timeout')); }, timeout); })
            ]);
            // ✅ requireOk: ردّ 403/429/5xx من البروكسي لا يُعتبر نجاحاً — جرّب بروكسي آخر
            if (requireOk && !res.ok) {
                _proxyFailCount[p] = (_proxyFailCount[p] || 0) + 1;
                lastBad = { res: res, proxyUsed: p };
                continue;
            }
            _bestProxy = p;
            _proxyFailCount[p] = 0;
            saveBestProxy();
            return { res: res, proxyUsed: p };
        } catch(e) {
            _proxyFailCount[p] = (_proxyFailCount[p] || 0) + 1;
            lastError = e;
            continue;
        }
    }
    if (lastBad) return lastBad;
    throw lastError || new Error('فشل الاتصال — تحقق من الإنترنت');
}

async function fetchXsrf() {
    xsrfToken = '';
    try {
        try { await proxiedFetch('/sanctum/csrf-cookie', {skipAuth:true, timeout:8000}); } catch(e){}
        var pr = await proxiedFetch('/', {skipAuth:true, timeout:8000});
        if (pr.res.ok) {
            var html = await pr.res.text(); var m;
            m = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i);
            if (m) { xsrfToken=m[1]; return; }
            m = html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i);
            if (m) { xsrfToken=m[1]; return; }
            m = html.match(/"csrf[^"]*"\s*:\s*"([^"]+)"/i);
            if (m) { xsrfToken=m[1]; return; }
        }
    } catch(e){}
}

async function refreshXsrf() { xsrfToken=''; await fetchXsrf(); }

// ═══════════════════════════════════════
//  إرسال رسالة
// ═══════════════════════════════════════
async function sendMessage(chatroomId, content, token, preferredProxy) {
    var endpoints = [
        { path:'/api/v2/messages/send/'+chatroomId, body:{content:content, type:'message'} },
        { path:'/api/v1/chat-messages', body:{content:content, chatroom_id:parseInt(chatroomId)} }
    ];
    var order = getProxyOrder(preferredProxy);
    var lastErr = null;
    var statusCounts = {};

    for (var ei = 0; ei < endpoints.length; ei++) {
        var ep = endpoints[ei];
        for (var oi = 0; oi < order.length; oi++) {
            var p = order[oi];
            if (!PROXIES[p].canPost) continue;
            try {
                var r = await proxiedFetch(ep.path, {
                    method:'POST', token:token, timeout:10000,
                    preferredProxy:p, body:ep.body
                });
                if (r.res.ok) { return { success:true, proxyUsed:r.proxyUsed }; }
                var st = r.res.status;
                if (st === 419) { await refreshXsrf(); continue; }
                if (st === 401 || st === 403 || st === 429) {
                    statusCounts[st] = (statusCounts[st] || 0) + 1;
                }
                lastErr = new Error('HTTP '+st);
            } catch(e) {
                lastErr = e;
            }
        }
    }

    if (statusCounts[429] >= 2) throw new Error('حظر مؤقت');
    if (statusCounts[403] >= 2) throw new Error('لا صلاحية');
    if (statusCounts[401] >= 2) throw new Error('توكن منتهي');
    if (lastErr instanceof TypeError || (lastErr && lastErr.message && lastErr.message.indexOf('Failed to fetch')>=0)) throw new Error('خطأ اتصال');
    throw lastErr || new Error('فشل الإرسال');
}