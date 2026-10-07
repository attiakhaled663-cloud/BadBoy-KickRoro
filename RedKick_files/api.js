/* ═══════════════════════════════════════════════════════════
   BadBoy Kick — api.js
   طبقة الشبكة + دالة إرسال الرسائل (مفصولة عن index.html)
   يُحمَّل هذا الملف داخل index.html عبر:
   <script src="api.js"></script>
   ويجب أن يوضع قبل السكربت الرئيسي في الصفحة

   ✅ محدَّث 2026-10-07 (v4):
   ─ 12 بروكسي مجدَّدين + direct (10 تدعم POST و2 للقراءة فقط)
   ─ إرسال الرسائل بدون أي تحقق مسبق من اسم القناة
   ─ إصلاح مشاكل (موضّحة في كل قسم بعلامة ✅ FIX)
   ═══════════════════════════════════════════════════════════ */

var KICK_BASE = 'https://kick.com';
var $ = function(id) { return document.getElementById(id); };

// ═══════════════════════════════════════
//  (اختياري) بروكسي خاص بيك — الأضمن على الإطلاق
//  انشر Cloudflare Worker مجاني (100 ألف طلب/يوم) وحط رابطه هنا بالشكل:
//  'https://اسمك.workers.dev/?url='
//  لو فاضي بيتجاهله الملف.
// ═══════════════════════════════════════
var CUSTOM_WORKER = '';

// مفتاح cors.sh المجاني من cors.sh/playground (اختياري — لو فاضي بيتخطّاه الكود)
var CORS_SH_KEY = '';

// ═══════════════════════════════════════
//  البروكسي — 12 بروكسي + direct
//  (direct لازم يفضل آخر عنصر في المصفوفة دايماً)
// ═══════════════════════════════════════
var PROXIES = [
    // ── تدعم POST ──
    { name:'corsfix',       build:function(u){return 'https://proxy.corsfix.com/?'+u;}, canPost:true },
    { name:'killcors',      build:function(u){return 'https://proxy.killcors.com/?url='+encodeURIComponent(u);}, canPost:true },
    { name:'cors.x2u.in',   build:function(u){return 'https://cors.x2u.in/?url='+encodeURIComponent(u);}, canPost:true },
    { name:'cors.lol',      build:function(u){return 'https://api.cors.lol/url='+u;}, canPost:true },
    { name:'corsproxy.io',  build:function(u){return 'https://corsproxy.io/?url='+encodeURIComponent(u);}, canPost:true },
    { name:'api.corsproxy.io', build:function(u){return 'https://api.corsproxy.io/?url='+encodeURIComponent(u);}, canPost:true },
    { name:'corsproxy.org', build:function(u){return 'https://corsproxy.org/?'+encodeURIComponent(u);}, canPost:true },
    { name:'cors.eu.org',   build:function(u){return 'https://cors.eu.org/'+u;}, canPost:true },
    { name:'cors-anywhere', build:function(u){return 'https://cors-anywhere.com/'+u;}, canPost:true },
    // cors.sh: بيتخطّاه الكود تلقائياً لو CORS_SH_KEY فاضي
    { name:'cors.sh',       build:function(u){return 'https://proxy.cors.sh/'+u;}, canPost:true, needsKey:true },
    // ── للقراءة فقط (بيرجعوا 200 دايماً فمينفعوش للإرسال) ──
    { name:'allorigins',    build:function(u){return 'https://api.allorigins.win/raw?url='+encodeURIComponent(u);}, canPost:false },
    { name:'codetabs',      build:function(u){return 'https://api.codetabs.com/v1/proxy/?quest='+encodeURIComponent(u);}, canPost:false }
];

if (CUSTOM_WORKER) {
    PROXIES.unshift({ name:'custom-worker', build:function(u){return CUSTOM_WORKER+encodeURIComponent(u);}, canPost:true });
}
// direct دايماً آخر عنصر
PROXIES.push({ name:'direct', build:function(u){return u;}, canPost:true });

var DIRECT_INDEX = PROXIES.length - 1;

var activeProxy = 0;
var xsrfToken = '';
var isDirectMode = false;

function detectMode() {
    try { isDirectMode = window.location.hostname === 'kick.com' || window.location.hostname.endsWith('.kick.com'); } catch(e) { isDirectMode=false; }
    if (isDirectMode) activeProxy = DIRECT_INDEX;
}

var _bestProxy = -1;
var _proxyFailCount = {};

// رُفع لـ v4 لأن قائمة البروكسيات اتغيّرت بالكامل — الاندكس القديم مش صالح
var BEST_PROXY_KEY = 'redkick_best_proxy_v4';

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

// هل البروكسي ده صالح للاستخدام دلوقتي؟
function isUsable(p) {
    var px = PROXIES[p];
    if (!px) return false;
    if (px.needsKey && !CORS_SH_KEY) return false;
    if (p === DIRECT_INDEX && !isDirectMode) return false; // ✅ FIX: direct بيفشل دايماً (CORS) برا kick.com
    return true;
}

// هيدرز خاصة بالبروكسي (cors.sh)
function extraHeaders(p) {
    var px = PROXIES[p];
    if (px && px.needsKey && CORS_SH_KEY) return { 'x-cors-api-key': CORS_SH_KEY };
    return null;
}

// ✅ FIX: مهلة حقيقية بتلغي الطلب (AbortController) وبتنضّف التايمر
async function fetchWithTimeout(url, opts, ms) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var o = ctrl ? Object.assign({}, opts, { signal: ctrl.signal }) : opts;
    var timer = null;
    var timeoutP = new Promise(function(_, reject) {
        timer = setTimeout(function() {
            if (ctrl) { try { ctrl.abort(); } catch(e) {} }
            reject(new Error('timeout'));
        }, ms);
    });
    try {
        return await Promise.race([fetch(url, o), timeoutP]);
    } finally {
        clearTimeout(timer);
    }
}

// ✅ FIX: الاختبار بقى بالتوازي (قبل كده كان تسلسلي وممكن ياخد لحد ~50 ثانية)
//        وبيختبر بس البروكسيات اللي تدعم POST لأنها اللي بتتستخدم في الإرسال
function prewarmProxies() {
    var testUrl = KICK_BASE + '/api/v2/channels/kick';
    var cands = getProxyOrder().filter(function(i) { return PROXIES[i].canPost && isUsable(i); });
    return new Promise(function(resolve) {
        var pending = cands.length, done = false;
        if (!pending) { resolve(-1); return; }
        cands.forEach(function(p) {
            var h = Object.assign({ 'Accept':'application/json' }, extraHeaders(p) || {});
            fetchWithTimeout(PROXIES[p].build(testUrl), { method:'GET', headers:h, credentials:'omit' }, 4000)
                .then(function(res) {
                    if (res && res.ok && !done) {
                        done = true;
                        _bestProxy = p;
                        _proxyFailCount[p] = 0;
                        saveBestProxy();
                        resolve(p);
                    } else if (!(res && res.ok)) {
                        _proxyFailCount[p] = (_proxyFailCount[p] || 0) + 1;
                    }
                })
                .catch(function() { _proxyFailCount[p] = (_proxyFailCount[p] || 0) + 1; })
                .then(function() { if (--pending === 0 && !done) resolve(-1); });
        });
    });
}

function getProxyOrder(preferredProxy) {
    var order = [];
    function add(i) {
        if (i !== undefined && i >= 0 && i < PROXIES.length && order.indexOf(i) === -1 && isUsable(i)) order.push(i);
    }
    // ✅ FIX: في وضع direct (الصفحة على kick.com) نبدأ بـ direct
    if (isDirectMode) add(DIRECT_INDEX);
    add(preferredProxy);
    add(_bestProxy);
    var remaining = [];
    for (var i = 0; i < PROXIES.length; i++) {
        if (order.indexOf(i) === -1 && isUsable(i)) remaining.push(i);
    }
    remaining.sort(function(a, b) {
        return (_proxyFailCount[a] || 0) - (_proxyFailCount[b] || 0);
    });
    return order.concat(remaining);
}

// options.single = true → جرّب البروكسي المحدد فقط ولا تنتقل لغيره
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
    var single = options.single || false;
    var isPost = (method !== 'GET');

    var defHeaders = { 'Accept':'application/json' };
    if (isPost) defHeaders['Content-Type'] = 'application/json';
    if (!skipAuth && token) defHeaders['Authorization'] = 'Bearer ' + token;
    if (xsrfToken) defHeaders['X-XSRF-TOKEN'] = xsrfToken;
    for (var k in headers) defHeaders[k] = headers[k];
    // (تم حذف هيدر Origin: المتصفح بيمنع تعديله وبيتجاهله)

    var fetchOpts = { method:method, headers:defHeaders, credentials:'omit' };
    if (body && isPost) fetchOpts.body = JSON.stringify(body);

    var fullUrl = KICK_BASE + kickPath;
    var lastError = null;
    var lastBad = null;

    var order = single ? [preferredProxy] : getProxyOrder(preferredProxy);

    for (var pi = 0; pi < order.length; pi++) {
        var p = order[pi];
        if (!isUsable(p)) continue;
        if (isPost && !PROXIES[p].canPost) continue;
        var url = PROXIES[p].build(fullUrl);
        var opts = Object.assign({}, fetchOpts);
        opts.credentials = (isDirectMode && p === DIRECT_INDEX) ? 'include' : 'omit';
        var eh = extraHeaders(p);
        if (eh) opts.headers = Object.assign({}, defHeaders, eh);
        try {
            var res = await fetchWithTimeout(url, opts, timeout);
            if (requireOk && !res.ok) {
                _proxyFailCount[p] = (_proxyFailCount[p] || 0) + 1;
                lastBad = { res: res, proxyUsed: p };
                continue;
            }
            // ✅ FIX: نحفظ "أفضل بروكسي" فقط لو الردّ ناجح فعلاً
            //        (قبل كده ردّ 403/429 من البروكسي كان بيتحفظ كأفضل بروكسي)
            if (res.ok) {
                _bestProxy = p;
                _proxyFailCount[p] = 0;
                saveBestProxy();
            } else {
                _proxyFailCount[p] = (_proxyFailCount[p] || 0) + 1;
            }
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
//  جلب chatroom id للقناة (بدون أي تحقق/رفض)
//  ─ لو القيمة رقم → تُستخدم كما هي فوراً
//  ─ لو اسم قناة → يُحاول جلب الـ id في الخلفية ويُخزَّن
//  ─ إضافة القناة نفسها لا تعتمد على نتيجة هذه الدالة أبداً
// ═══════════════════════════════════════
var _chatroomCache = {};

async function resolveChatroomId(slugOrId) {
    var s = String(slugOrId == null ? '' : slugOrId).trim();
    if (/^\d+$/.test(s)) return s;
    var key = s.toLowerCase().replace(/_/g, '-');
    if (_chatroomCache[key]) return _chatroomCache[key];
    var r = await proxiedFetch('/api/v2/channels/' + encodeURIComponent(key), { skipAuth:true, requireOk:true, timeout:8000 });
    if (!r.res.ok) throw new Error('تعذّر جلب بيانات القناة');
    var j = await r.res.json();
    var id = j && j.chatroom && j.chatroom.id;
    if (!id) throw new Error('تعذّر جلب بيانات القناة');
    _chatroomCache[key] = String(id);
    return _chatroomCache[key];
}

// ═══════════════════════════════════════
//  إرسال رسالة
//  chatroomId: رقم الـ chatroom أو اسم القناة (يُحوَّل تلقائياً)
// ═══════════════════════════════════════
async function sendMessage(chatroomId, content, token, preferredProxy) {
    chatroomId = await resolveChatroomId(chatroomId);

    var endpoints = [
        { path:'/api/v2/messages/send/'+chatroomId, body:{content:content, type:'message'} },
        { path:'/api/v1/chat-messages', body:{content:content, chatroom_id:parseInt(chatroomId, 10)} }
    ];
    var order = getProxyOrder(preferredProxy);
    var lastErr = null;
    var statusCounts = {};

    for (var ei = 0; ei < endpoints.length; ei++) {
        var ep = endpoints[ei];
        for (var oi = 0; oi < order.length; oi++) {
            var p = order[oi];
            if (!PROXIES[p].canPost) continue;
            var retried419 = false;
            // ✅ FIX: single:true — قبل كده كل بروكسي فاشل كان بيجرّب كل البروكسيات تاني (تكرار تربيعي وبطء)
            for (var attempt = 0; attempt < 2; attempt++) {
                try {
                    var r = await proxiedFetch(ep.path, {
                        method:'POST', token:token, timeout:10000,
                        preferredProxy:p, single:true, body:ep.body
                    });
                    if (r.res.ok) { return { success:true, proxyUsed:r.proxyUsed }; }
                    var st = r.res.status;
                    if (st === 419 && !retried419) {
                        retried419 = true;
                        await refreshXsrf();
                        continue; // أعد المحاولة على نفس البروكسي بتوكن جديد
                    }
                    if (st === 401 || st === 403 || st === 429) {
                        statusCounts[st] = (statusCounts[st] || 0) + 1;
                    }
                    // ✅ FIX: التوكن المنتهي ما يحتاجش نجرّب باقي البروكسيات
                    if (statusCounts[401] >= 2) throw new Error('توكن منتهي');
                    lastErr = new Error('HTTP '+st);
                } catch(e) {
                    if (e && e.message === 'توكن منتهي') throw e;
                    lastErr = e;
                }
                break;
            }
        }
    }

    if (statusCounts[429] >= 2) throw new Error('حظر مؤقت');
    if (statusCounts[403] >= 2) throw new Error('لا صلاحية');
    if (statusCounts[401] >= 2) throw new Error('توكن منتهي');
    if (lastErr instanceof TypeError || (lastErr && lastErr.message && lastErr.message.indexOf('Failed to fetch')>=0)) throw new Error('خطأ اتصال');
    throw lastErr || new Error('فشل الإرسال');
}
