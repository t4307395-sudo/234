/**
 * Cloudflare Pages Function: /api/analyze
 * محلل المواقع: سرعة (موبايل + ديسكتوب) + أمان + SEO أساسي + توصيات AI شاملة
 * المفاتيح المستخدمة: EXT_TOKEN_MAIN (PageSpeed + Safe Browsing + Custom Search)
 *                      GEMINI_API_KEY / GEMINI_API_KEY2 / GEMINI_API_KEY3 / GEMINI_API_KEY4
 *                      (تدوير تلقائي بينهم + Fallback لو مفتاح خلّصت كوتته)
 *                      env.DB (D1) لتخزين عداد التدوير
 */
export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.EXT_TOKEN_MAIN) {
        return jsonError('مفتاح الخدمات الخارجية غير مربوط بالمشروع (EXT_TOKEN_MAIN).', 500);
    }
    if (!env.DB) {
        return jsonError('قاعدة البيانات غير مربوطة بالمشروع (DB).', 500);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonError('بيانات الطلب غير صحيحة.', 400);
    }

    const { url, email } = body;
    if (!url || !isValidUrl(url)) {
        return jsonError('من فضلك أدخل رابط صحيح يبدأ بـ http:// أو https://', 400);
    }

    // تسجيل الدخول إجباري لاستخدام الأداة
    if (!email) {
        return jsonError('لازم تسجّل دخول الأول عشان تقدر تستخدم الأداة.', 401);
    }

    const userExists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (!userExists) {
        return jsonError('الحساب ده مش موجود، سجّل دخول تاني.', 401);
    }

    // المعرّف: الإيميل بس (تسجيل الدخول إجباري دلوقتي)
    const identifier = email;

    // 1) تحقق من الكاش الأول (ساعة واحدة) قبل أي حاجة تانية
    const cached = await getCachedResult(env, url);
    if (cached) {
        return new Response(JSON.stringify({ ...cached, fromCache: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 2) تحقق من الحد اليومي (3 فحوصات فقط، الكاش مبيتحسبش منها)
    const limitCheck = await checkAndIncrementLimit(env, identifier);
    if (!limitCheck.allowed) {
        return jsonError(
            `وصلت للحد الأقصى (3 فحوصات في اليوم). حاول تاني بكرة، أو جرب رابط فحصته قبل كده هيرجع من الكاش فوراً.`,
            429
        );
    }

    const apiKey = env.EXT_TOKEN_MAIN;

    try {
        // تشغيل كل الفحوصات بالتوازي: موبايل + ديسكتوب + أمان + تحليل HTML
        const [mobileResult, desktopResult, safeBrowsingResult, pageContent] = await Promise.allSettled([
            fetchPageSpeed(url, apiKey, 'mobile'),
            fetchPageSpeed(url, apiKey, 'desktop'),
            fetchSafeBrowsing(url, apiKey),
            fetchAndParsePage(url)
        ]);

        const mobile = mobileResult.status === 'fulfilled' ? mobileResult.value : null;
        const desktop = desktopResult.status === 'fulfilled' ? desktopResult.value : null;
        const safety = safeBrowsingResult.status === 'fulfilled' ? safeBrowsingResult.value : null;
        const seo = pageContent.status === 'fulfilled' ? pageContent.value : null;

        // دمج مشاكل الموبايل والديسكتوب مع بعض (كل مشكلة موسومة بالجهاز)
        const allAudits = [
            ...(mobile?.actionableAudits || []).map(a => ({ ...a, device: 'mobile' })),
            ...(desktop?.actionableAudits || []).map(a => ({ ...a, device: 'desktop' }))
        ];

        const aiRecommendations = await generateAIRecommendations(env, url, allAudits, safety, seo);

        // 3) قارن بآخر فحص سابق لنفس الرابط ونفس الحساب/IP
        const comparison = await getComparison(env, identifier, url, mobile?.performanceScore, mobile?.seoScore);

        const responseData = {
            success: true,
            url,
            checkedAt: new Date().toISOString(),
            mobile: mobile ? stripAudits(mobile) : null,
            desktop: desktop ? stripAudits(desktop) : null,
            safety,
            seo,
            aiRecommendations,
            comparison
        };

        // احفظ في الكاش وفي السجل التاريخي (من غير ما نستنى، مش لازم نأخر الرد بسببهم)
        context.waitUntil(saveToCache(env, url, responseData));
        context.waitUntil(saveToHistory(env, identifier, url, mobile?.performanceScore, mobile?.seoScore));

        return new Response(JSON.stringify(responseData), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        return jsonError(err.message, 500);
    }
}

// ============================================================
// الكاش (ساعة واحدة لكل رابط)
// ============================================================
async function getCachedResult(env, url) {
    try {
        const row = await env.DB.prepare(
            "SELECT result_json, cached_at FROM analysis_cache WHERE url = ?"
        ).bind(url).first();

        if (!row) return null;

        const ageMs = Date.now() - row.cached_at;
        if (ageMs > 60 * 60 * 1000) return null; // أقدم من ساعة

        return JSON.parse(row.result_json);
    } catch {
        return null; // لو الجدول لسه مش موجود، منكملش الطلب من غير كاش
    }
}

async function saveToCache(env, url, data) {
    try {
        await env.DB.prepare(
            "INSERT INTO analysis_cache (url, result_json, cached_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(url) DO UPDATE SET result_json = excluded.result_json, cached_at = excluded.cached_at"
        ).bind(url, JSON.stringify(data), Date.now()).run();
    } catch {
        // متعمّد: فشل الكاش مايوقفش الطلب الأساسي
    }
}

// ============================================================
// الحد اليومي (3 فحوصات لكل حساب/IP)
// ============================================================
async function checkAndIncrementLimit(env, identifier) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    try {
        const row = await env.DB.prepare(
            "SELECT count FROM scan_limits WHERE identifier = ? AND scan_date = ?"
        ).bind(identifier, today).first();

        const currentCount = row?.count || 0;

        if (currentCount >= 3) {
            return { allowed: false };
        }

        await env.DB.prepare(
            "INSERT INTO scan_limits (identifier, scan_date, count) VALUES (?, ?, 1) " +
            "ON CONFLICT(identifier, scan_date) DO UPDATE SET count = count + 1"
        ).bind(identifier, today).run();

        return { allowed: true };
    } catch {
        return { allowed: true }; // لو الجدول لسه مش موجود، منمنعش المستخدم بسبب مشكلة عندنا
    }
}

// ============================================================
// مقارنة "قبل وبعد" مع آخر فحص سابق لنفس الرابط
// ============================================================
async function getComparison(env, identifier, url, newPerformance, newSeo) {
    try {
        const previous = await env.DB.prepare(
            "SELECT performance_score, seo_score, checked_at FROM scan_history " +
            "WHERE identifier = ? AND url = ? ORDER BY checked_at DESC LIMIT 1"
        ).bind(identifier, url).first();

        if (!previous) return null;

        return {
            previousPerformance: previous.performance_score,
            previousSeo: previous.seo_score,
            performanceDelta: newPerformance != null && previous.performance_score != null
                ? newPerformance - previous.performance_score : null,
            seoDelta: newSeo != null && previous.seo_score != null
                ? newSeo - previous.seo_score : null,
            previousCheckedAt: previous.checked_at
        };
    } catch {
        return null;
    }
}

async function saveToHistory(env, identifier, url, performanceScore, seoScore) {
    try {
        await env.DB.prepare(
            "INSERT INTO scan_history (identifier, url, performance_score, seo_score, checked_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(identifier, url, performanceScore ?? null, seoScore ?? null, Date.now()).run();
    } catch {
        // متعمّد: فشل حفظ التاريخ مايوقفش الطلب الأساسي
    }
}

// نشيل قائمة الأودتس التفصيلية من الرد النهائي (استخدمناها داخلياً بس مع الـAI)
function stripAudits(deviceResult) {
    const { actionableAudits, ...rest } = deviceResult;
    return rest;
}

// ============================================================
// فحص السرعة (PageSpeed Insights API) — لجهاز واحد (موبايل/ديسكتوب)
// ============================================================
async function fetchPageSpeed(url, apiKey, strategy) {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
        `?url=${encodeURIComponent(url)}` +
        `&key=${apiKey}` +
        `&strategy=${strategy}` +
        `&category=performance&category=seo&category=accessibility`;

    const res = await fetch(endpoint);
    if (!res.ok) {
        throw new Error(`تعذّر فحص ${strategy === 'mobile' ? 'الموبايل' : 'الديسكتوب'} (${res.status})`);
    }
    const data = await res.json();
    const lighthouse = data?.lighthouseResult || {};
    const categories = lighthouse.categories || {};
    const audits = lighthouse.audits || {};

    return {
        strategy,
        performanceScore: Math.round((categories.performance?.score || 0) * 100),
        seoScore: Math.round((categories.seo?.score || 0) * 100),
        accessibilityScore: Math.round((categories.accessibility?.score || 0) * 100),
        firstContentfulPaint: audits['first-contentful-paint']?.displayValue || null,
        largestContentfulPaint: audits['largest-contentful-paint']?.displayValue || null,
        totalBlockingTime: audits['total-blocking-time']?.displayValue || null,
        // صورة فعلية للموقع من نفس الـAPI (مفيش مفتاح إضافي مطلوب)
        screenshot: audits['final-screenshot']?.details?.data || null,
        actionableAudits: extractActionableAudits(lighthouse)
    };
}

// ============================================================
// استخراج كل المشاكل (كبيرة وصغيرة) من تقرير Lighthouse الكامل
// ============================================================
function extractActionableAudits(lighthouse) {
    const audits = lighthouse.audits || {};
    const categories = lighthouse.categories || {};
    const relevantIds = new Set();

    ['performance', 'seo', 'accessibility'].forEach(catKey => {
        (categories[catKey]?.auditRefs || []).forEach(ref => relevantIds.add(ref.id));
    });

    const results = [];

    for (const id of relevantIds) {
        const audit = audits[id];
        if (!audit) continue;
        if (audit.scoreDisplayMode === 'notApplicable' || audit.scoreDisplayMode === 'manual') continue;

        // نضم أي مشكلة معندهاش علامة كاملة (score < 1) وكمان أي فرصة توفير حقيقية حتى لو صغيرة
        const hasOpportunity = audit.details?.type === 'opportunity' &&
            ((audit.details.overallSavingsMs || 0) > 0 || (audit.details.overallSavingsBytes || 0) > 0);
        const isImperfect = audit.score !== null && audit.score < 1;

        if (!hasOpportunity && !isImperfect) continue;

        const entry = {
            id,
            title: audit.title,
            description: stripMarkdownLinks(audit.description || ''),
            displayValue: audit.displayValue || null,
            score: audit.score
        };

        if (audit.details?.type === 'opportunity') {
            entry.potentialSavingsMs = audit.details.overallSavingsMs ?? null;
            entry.potentialSavingsBytes = audit.details.overallSavingsBytes ?? null;
        }

        if (Array.isArray(audit.details?.items)) {
            entry.affectedItems = audit.details.items.slice(0, 5).map(item => ({
                url: item.url || item.node?.snippet || null,
                wastedBytes: item.wastedBytes ?? null,
                wastedMs: item.wastedMs ?? null
            }));
        }

        results.push(entry);
    }

    results.sort((a, b) => (a.score ?? 1) - (b.score ?? 1));

    return results.slice(0, 30); // حد أقصى 30 مشكلة لكل جهاز عشان الطلب ميبقاش ضخم جداً
}

function stripMarkdownLinks(text) {
    return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

// ============================================================
// فحص الأمان (Safe Browsing API)
// ============================================================
async function fetchSafeBrowsing(url, apiKey) {
    const endpoint = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`;

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client: { clientId: 'super-web', clientVersion: '1.0' },
            threatInfo: {
                threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
                platformTypes: ['ANY_PLATFORM'],
                threatEntryTypes: ['URL'],
                threatEntries: [{ url }]
            }
        })
    });

    if (!res.ok) {
        throw new Error(`تعذّر فحص الأمان (${res.status})`);
    }

    const data = await res.json();
    const isSafe = !data.matches || data.matches.length === 0;

    return {
        isSafe,
        threats: isSafe ? [] : data.matches.map(m => m.threatType)
    };
}

// ============================================================
// تحليل HTML أساسي (Title, Meta, Headings, Schema...)
// ============================================================
async function fetchAndParsePage(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperWebBot/1.0)' }
    });

    if (!res.ok) {
        throw new Error(`تعذّر فتح الصفحة (${res.status})`);
    }

    const html = await res.text();

    const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const metaDescription = extractAttr(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
    const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
    const imgTags = html.match(/<img\s[^>]*>/gi) || [];
    const imagesWithoutAlt = imgTags.filter(tag => !/alt=["'][^"']+["']/i.test(tag)).length;
    const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);
    const hasSchema = /application\/ld\+json/i.test(html);
    const isHttps = url.startsWith('https://');

    return {
        title: title || null,
        titleLength: title ? title.length : 0,
        metaDescription: metaDescription || null,
        metaDescriptionLength: metaDescription ? metaDescription.length : 0,
        h1Count,
        totalImages: imgTags.length,
        imagesWithoutAlt,
        hasCanonical,
        hasSchema,
        isHttps
    };
}

function extractTag(html, regex) {
    const match = html.match(regex);
    return match ? match[1].trim().replace(/\s+/g, ' ') : null;
}

function extractAttr(html, regex) {
    const match = html.match(regex);
    return match ? match[1].trim() : null;
}

// ============================================================
// تدوير مفاتيح Gemini (Round-Robin عبر D1)
// ============================================================
function getGeminiKeys(env) {
    return [env.GEMINI_API_KEY, env.GEMINI_API_KEY2, env.GEMINI_API_KEY3, env.GEMINI_API_KEY4]
        .map((key, i) => ({ key, index: i + 1 }))
        .filter(k => !!k.key);
}

async function getStartIndex(env, totalKeys) {
    if (!env.DB || totalKeys <= 1) return 0;

    try {
        const row = await env.DB.prepare(
            `UPDATE api_key_rotation SET counter = (counter + 1) % ? WHERE id = 1 RETURNING counter`
        ).bind(totalKeys).first();

        return row ? row.counter : 0;
    } catch {
        // لو الجدول لسه مش موجود، نبدأ من أول مفتاح من غير ما نكسر الطلب
        return 0;
    }
}

// ============================================================
// توصيات الذكاء الاصطناعي (Gemini API) — مع تدوير مفاتيح وFallback
// ============================================================
async function generateAIRecommendations(env, url, audits, safety, seo) {
    const keys = getGeminiKeys(env);

    if (keys.length === 0) {
        return fallbackRecommendations('مفيش أي مفتاح Gemini مربوط بالمشروع.');
    }

    const prompt = buildPrompt(url, audits, safety, seo);
    const startIndex = await getStartIndex(env, keys.length);

    // نجرب كل مفتاح بالترتيب بدءاً من دوره، ولو خلّص كوتته ننتقل للتالي تلقائياً
    for (let attempt = 0; attempt < keys.length; attempt++) {
        const keyEntry = keys[(startIndex + attempt) % keys.length];

        try {
            const result = await callGemini(keyEntry.key, prompt);
            result.keyUsed = keyEntry.index;
            return result;
        } catch (err) {
            if (err.isRateLimit && attempt < keys.length - 1) {
                continue; // جرّب المفتاح اللي بعده
            }
            if (err.isRateLimit) {
                return fallbackRecommendations('الخدمة مشغولة حالياً، من فضلك حاول تاني بعد بضع دقائق.');
            }
            return fallbackRecommendations('تعذّر توليد التوصيات: ' + err.message);
        }
    }

    return fallbackRecommendations('يرجى المحاولة بعد بضع دقائق.');
}

function buildPrompt(url, audits, safety, seo) {
    return `
أنت مهندس ويب خبير في الأداء والأرشفة (SEO). قدّامك تقرير Lighthouse كامل لموقع ${url}
(موبايل وديسكتوب مع بعض)، فيه كل المشاكل الحقيقية اللي الموقع فاشل فيها (كبيرة وصغيرة، مش ملخص فقط).

المشاكل المكتشفة (${audits.length} مشكلة، كل واحدة موسومة بجهاز mobile أو desktop):
${JSON.stringify(audits)}

بيانات إضافية عن الصفحة: ${seo ? JSON.stringify(seo) : 'غير متاحة'}
بيانات الأمان: ${safety ? JSON.stringify(safety) : 'غير متاحة'}

المطلوب منك بالظبط، لكل مشكلة مهمة (اختار أهمها، صغيرة كانت أو كبيرة، بحد أقصى 12 مشكلة):
- severity: صنّفها "critical" أو "high" أو "medium" فقط، حسب حجم تأثيرها الفعلي
- title: اسم المشكلة بالعربي وبشكل مباشر
- impact: تأثيرها الفعلي بالأرقام (مثال: "بيبطّئ التحميل 1.2 ثانية على الموبايل")
- steps: مصفوفة (array) من الخطوات العملية المرقّمة تلقائياً، كل خطوة جملة قصيرة واحدة ومباشرة
  (متكتبش الخطوات كلها في نص واحد طويل، كل خطوة عنصر منفصل في المصفوفة)
- codeExample: كود فعلي جاهز للنسخ يحل المشكلة، أو null صراحة لو مفيش كود منطقي (متختلقش كود وهمي)

وبرضو:
- suggestedMetaDescription: لو الـmeta description ناقصة أو قصيرة، وصف Meta جاهز (155 حرف تقريباً)
- schemaMarkup: كود Schema Markup (JSON-LD نوع WebPage) جاهز للنسخ

رد بصيغة JSON فقط بالشكل ده بالظبط، من غير أي نص زيادة قبله أو بعده، ومن غير علامات كود markdown:
{
  "fixes": [
    { "severity": "critical", "title": "...", "impact": "...", "steps": ["...", "..."], "codeExample": "..." }
  ],
  "suggestedMetaDescription": "...",
  "schemaMarkup": "..."
}
`.trim();
}

async function callGemini(apiKey, prompt) {
    const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.3,
                    responseMimeType: 'application/json'
                }
            })
        }
    );

    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const message = errData.error?.message || `فشل استدعاء Gemini (${res.status})`;
        const error = new Error(message);
        error.isRateLimit = res.status === 429;
        throw error;
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    return parsed || fallbackRecommendations('تعذّر فهم رد الذكاء الاصطناعي.');
}

function fallbackRecommendations(message) {
    return {
        fixes: [{ severity: 'medium', title: 'تعذّر توليد التوصيات', impact: null, steps: [message], codeExample: null }],
        suggestedMetaDescription: null,
        schemaMarkup: null,
        keyUsed: null
    };
}

// ============================================================
// أدوات مساعدة
// ============================================================
function isValidUrl(str) {
    try {
        const u = new URL(str);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
