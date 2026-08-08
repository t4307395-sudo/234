/**
 * Cloudflare Pages Function: /api/save-report
 * يحفظ نتيجة فحص في شيت جوجل داخل Drive بتاع المستخدم نفسه (drive.file scope)
 * لو مفيش شيت قبل كده، بينشئ واحد ويحفظ الـ ID، وبعدين بيضيف صف جديد في كل مرة
 */
export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.DB) {
        return jsonError('قاعدة البيانات غير مربوطة (DB).', 500);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonError('بيانات الطلب غير صحيحة.', 400);
    }

    const { email, report } = body;
    if (!email || !report) {
        return jsonError('بيانات ناقصة (email أو report).', 400);
    }

    try {
        const tokenRow = await env.DB.prepare("SELECT * FROM google_tokens WHERE user_email = ?")
            .bind(email).first();

        if (!tokenRow) {
            return jsonError('لازم تربط Drive الأول قبل ما تقدر تحفظ النتائج.', 403);
        }

        const accessToken = await getValidAccessToken(env, tokenRow);

        let spreadsheetId = tokenRow.spreadsheet_id;

        if (!spreadsheetId) {
            spreadsheetId = await createReportSheet(accessToken);
            await env.DB.prepare("UPDATE google_tokens SET spreadsheet_id = ? WHERE user_email = ?")
                .bind(spreadsheetId, email).run();
        }

        await appendReportRow(accessToken, spreadsheetId, report);

        return new Response(JSON.stringify({
            success: true,
            reportUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        return jsonError(err.message, 500);
    }
}

// ============================================================
// تجديد الـ access_token تلقائياً لو خلصت صلاحيته
// ============================================================
async function getValidAccessToken(env, tokenRow) {
    const isExpired = Date.now() > (tokenRow.expires_at - 60000); // هامش دقيقة أمان

    if (!isExpired) {
        return tokenRow.access_token;
    }

    if (!tokenRow.refresh_token) {
        throw new Error('انتهت صلاحية الربط مع Drive، لازم تربطه تاني.');
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            refresh_token: tokenRow.refresh_token,
            grant_type: 'refresh_token'
        })
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error('فشل تجديد الاتصال بـ Drive: ' + (data.error_description || data.error));
    }

    const newExpiresAt = Date.now() + (data.expires_in * 1000);
    await env.DB.prepare("UPDATE google_tokens SET access_token = ?, expires_at = ? WHERE user_email = ?")
        .bind(data.access_token, newExpiresAt, tokenRow.user_email).run();

    return data.access_token;
}

// ============================================================
// إنشاء شيت جديد لأول مرة
// ============================================================
async function createReportSheet(accessToken) {
    const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            properties: { title: 'سوبر ويب - سجل فحوصات المواقع' },
            sheets: [{
                properties: { title: 'الفحوصات' },
                data: [{
                    startRow: 0,
                    startColumn: 0,
                    rowData: [{
                        values: [
                            'التاريخ', 'الرابط', 'سرعة الأداء', 'الأمان', 'نتيجة SEO'
                        ].map(v => ({ userEnteredValue: { stringValue: v } }))
                    }]
                }]
            }]
        })
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error('فشل إنشاء الشيت: ' + (data.error?.message || 'خطأ غير معروف'));
    }

    return data.spreadsheetId;
}

// ============================================================
// إضافة صف جديد للنتيجة
// ============================================================
async function appendReportRow(accessToken, spreadsheetId, report) {
    const row = [
        new Date().toLocaleString('ar-EG'),
        report.url || '',
        report.mobile?.performanceScore ?? '',
        report.safety?.isSafe ? 'آمن' : 'يوجد تهديد',
        report.mobile?.seoScore ?? ''
    ];

    const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: [row] })
        }
    );

    if (!res.ok) {
        const data = await res.json();
        throw new Error('فشل إضافة النتيجة للشيت: ' + (data.error?.message || 'خطأ غير معروف'));
    }
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
