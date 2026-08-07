/**
 * Cloudflare Pages Function: /api/analyze
 * محلل المواقع: سرعة + أمان + SEO أساسي + توصيات AI
 * المفاتيح المستخدمة: EXT_TOKEN_MAIN (PageSpeed + Safe Browsing + Custom Search)
 *                      env.GEMINI_API_KEY (Google AI Studio - Gemini API)
 */
export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.EXT_TOKEN_MAIN) {
        return jsonError('مفتاح الخدمات الخارجية غير مربوط بالمشروع (EXT_TOKEN_MAIN).', 500);
    }
    if (!env.GEMINI_API_KEY) {
        return jsonError('مفتاح Gemini غير مربوط بالمشروع (GEMINI_API_KEY).', 500);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonError('بيانات الطلب غير صحيحة.', 400);
    }

    const { url } = body;
    if (!url || !isValidUrl(url)) {
        return jsonError('من فضلك أدخل رابط صحيح يبدأ بـ http:// أو https://', 400);
    }

    const apiKey = env.EXT_TOKEN_MAIN;

    try {
        // تشغيل الفحوصات الثلاثة بالتوازي لتوفير الوقت
        const [pageSpeedResult, safeBrowsingResult, pageContent] = await Promise.allSettled([
            fetchPageSpeed(url, apiKey),
            fetchSafeBrowsing(url, apiKey),
            fetchAndParsePage(url)
        ]);

        const speed = pageSpeedResult.status === 'fulfilled' ? pageSpeedResult.value : null;
        const safety = safeBrowsingResult.status === 'fulfilled' ? safeBrowsingResult.value : null;
        const seo = pageContent.status === 'fulfilled' ? pageContent.value : null;

        // توليد توصيات بالذكاء الاصطناعي بناءً على كل النتائج
        const aiRecommendations = await generateAIRecommendations(env, url, speed, safety, seo);

        return new Response(JSON.stringify({
            success: true,
            url,
            checkedAt: new Date().toISOString(),
            speed,
            safety,
            seo,
            aiRecommendations
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        return jsonError(err.message, 500);
    }
}

// ============================================================
// فحص السرعة (PageSpeed Insights API) — الأرقام + كل التفاصيل
// ============================================================
async function fetchPageSpeed(url, apiKey) {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
        `?url=${encodeURIComponent(url)}` +
        `&key=${apiKey}` +
        `&strategy=mobile` +
        `&category=performance&category=seo&category=accessibility`;

    const res = await fetch(endpoint);
    if (!res.ok) {
        throw new Error(`تعذّر فحص السرعة (${res.status})`);
    }
    const data = await res.json();
    const lighthouse = data?.lighthouseResult || {};
    const categories = lighthouse.categories || {};
    const audits = lighthouse.audits || {};

    return {
        performanceScore: Math.round((categories.performance?.score || 0) * 100),
        seoScore: Math.round((categories.seo?.score || 0) * 100),
        accessibilityScore: Math.round((categories.accessibility?.score || 0) * 100),
        firstContentfulPaint: audits['first-contentful-paint']?.displayValue || null,
        largestContentfulPaint: audits['largest-contentful-paint']?.displayValue || null,
        totalBlockingTime: audits['total-blocking-time']?.displayValue || null,
        // كل المشاكل التفصيلية (فرص تحسين + تشخيصات) اللي الموقع فاشل فيها
        actionableAudits: extractActionableAudits(lighthouse)
    };
}

// ============================================================
// استخراج كل المشاكل الفعلية من تقرير Lighthouse الكامل
// (مش بس الأرقام الملخّصة — دي كل التفاصيل اللي بتظهر في
// التقرير الرسمي على pagespeed.web.dev بالظبط)
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
        // نتجاهل اللي عدّى الفحص، أو مش قابل للتطبيق، أو محتاج مراجعة يدوية
        if (audit.score === null || audit.score >= 0.9) continue;
        if (audit.scoreDisplayMode === 'notApplicable' || audit.scoreDisplayMode === 'manual') continue;

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

    // الأولوية للأسوأ نتيجة الأول (الأكثر تأثيراً على النتيجة الكلية)
    results.sort((a, b) => (a.score ?? 1) - (b.score ?? 1));

    return results.slice(0, 20); // حد أقصى 20 مشكلة عشان الطلب للـAI ميبقاش ضخم أوي
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
// توصيات الذكاء الاصطناعي (Gemini API) — تعليمات فعلية قابلة للتنفيذ
// ============================================================
async function generateAIRecommendations(env, url, speed, safety, seo) {
    const audits = speed?.actionableAudits || [];

    const prompt = `
أنت مهندس ويب خبير في الأداء والأرشفة (SEO). قدّامك تقرير Lighthouse كامل لموقع ${url}،
فيه كل المشاكل الحقيقية اللي الموقع فاشل فيها (مش ملخص، دي كل التفاصيل).

المشاكل المكتشفة (${audits.length} مشكلة، مرتبة من الأسوأ تأثيراً):
${JSON.stringify(audits)}

بيانات إضافية عن الصفحة: ${seo ? JSON.stringify(seo) : 'غير متاحة'}
بيانات الأمان: ${safety ? JSON.stringify(safety) : 'غير متاحة'}

المطلوب منك بالظبط، لكل مشكلة من أهم 8 مشاكل (الأعلى تأثيراً بس):
- severity: صنّفها "critical" (لو بتأثر بشكل كبير جداً على الأداء/الأرشفة/الأمان) أو "high" أو "medium" فقط
- title: اسم المشكلة بالعربي وبشكل مباشر
- impact: تأثيرها الفعلي بالأرقام (مثال: "بيبطّئ تحميل الصفحة 1.2 ثانية" أو "بيكبّر حجم الصفحة 340 كيلوبايت")
- instructions: تعليمات عملية دقيقة تتنفذ فوراً (خطوات، مش كلام عام). لو المشكلة عن ملف معين
  (صورة، سكريبت...) اذكر اسمه من affectedItems لو موجود
- codeExample: كود فعلي جاهز للنسخ يحل المشكلة (HTML/CSS attribute جاهز، إعداد،...)، لو مفيش
  كود منطقي للمشكلة دي سيبها null صراحة (متختلقش كود وهمي)

وبرضو:
- suggestedMetaDescription: لو الـmeta description ناقصة أو قصيرة، وصف Meta جاهز (155 حرف تقريباً)
- schemaMarkup: كود Schema Markup (JSON-LD نوع WebPage) جاهز للنسخ

رد بصيغة JSON فقط بالشكل ده بالظبط، من غير أي نص زيادة قبله أو بعده، ومن غير علامات كود markdown:
{
  "fixes": [
    { "severity": "critical", "title": "...", "impact": "...", "instructions": "...", "codeExample": "..." }
  ],
  "suggestedMetaDescription": "...",
  "schemaMarkup": "..."
}
`.trim();

    try {
        const res = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': env.GEMINI_API_KEY
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
            throw new Error(errData.error?.message || `فشل استدعاء Gemini (${res.status})`);
        }

        const data = await res.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

        return parsed || {
            fixes: [{ title: 'تعذّر توليد التوصيات', impact: null, instructions: 'حاول تاني', codeExample: null }],
            suggestedMetaDescription: null,
            schemaMarkup: null
        };
    } catch (err) {
        return {
            fixes: [{ title: 'تعذّر توليد التوصيات', impact: null, instructions: err.message, codeExample: null }],
            suggestedMetaDescription: null,
            schemaMarkup: null
        };
    }
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
