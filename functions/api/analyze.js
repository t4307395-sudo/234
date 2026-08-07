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
// فحص السرعة (PageSpeed Insights API)
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
    const categories = data?.lighthouseResult?.categories || {};
    const audits = data?.lighthouseResult?.audits || {};

    return {
        performanceScore: Math.round((categories.performance?.score || 0) * 100),
        seoScore: Math.round((categories.seo?.score || 0) * 100),
        accessibilityScore: Math.round((categories.accessibility?.score || 0) * 100),
        firstContentfulPaint: audits['first-contentful-paint']?.displayValue || null,
        largestContentfulPaint: audits['largest-contentful-paint']?.displayValue || null,
        totalBlockingTime: audits['total-blocking-time']?.displayValue || null
    };
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
// توصيات الذكاء الاصطناعي (Gemini API)
// ============================================================
async function generateAIRecommendations(env, url, speed, safety, seo) {
    const prompt = `
أنت خبير تحسين محركات بحث (SEO) وأداء مواقع. حلل البيانات دي لموقع ${url} ورد بالعربي بس:

بيانات السرعة: ${speed ? JSON.stringify(speed) : 'غير متاحة'}
بيانات الأمان: ${safety ? JSON.stringify(safety) : 'غير متاحة'}
بيانات الصفحة: ${seo ? JSON.stringify(seo) : 'غير متاحة'}

المطلوب منك بالظبط:
1. اكتب أهم 3 مشاكل بترتيب الأولوية (الأهم أولاً) اللي لو اتحلت هيحسّن الموقع بسرعة
2. لو الـ meta description ناقصة أو قصيرة، اكتب وصف Meta جاهز (155 حرف تقريباً) مبني على عنوان الصفحة
3. اديني كود Schema Markup بسيط (JSON-LD نوع WebPage) جاهز للنسخ، مبني على العنوان والوصف

رد بصيغة JSON فقط بالشكل ده بالظبط، من غير أي نص زيادة قبله أو بعده، ومن غير علامات كود markdown:
{
  "topPriorities": ["...", "...", "..."],
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
                        temperature: 0.4,
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
            topPriorities: ['تعذّر توليد التوصيات، حاول مرة أخرى'],
            suggestedMetaDescription: null,
            schemaMarkup: null
        };
    } catch (err) {
        return {
            topPriorities: ['تعذّر توليد التوصيات: ' + err.message],
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
