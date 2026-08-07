/**
 * Cloudflare Pages Function: /api/save-report
 * يحفظ نتيجة فحص كملف JSON مباشر في Drive بتاع المستخدم (drive.file scope فقط)
 * لو مفيش ملف قبل كده، بينشئ واحد، وبعدين بيضيف كل نتيجة جديدة جوه نفس الملف
 *
 * ملاحظة: بنستخدم نفس عمود spreadsheet_id في جدول google_tokens لتخزين
 * ID الملف الجديد (مفيش داعي نعدل قاعدة البيانات، بس تغيّر الغرض من العمود)
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

        let fileId = tokenRow.spreadsheet_id; // بنعيد استخدام نفس العمود لتخزين ID ملف الـ JSON
        let reportUrl;

        if (!fileId) {
            const created = await createReportFile(accessToken, report);
            fileId = created.fileId;
            reportUrl = created.webViewLink;
            await env.DB.prepare("UPDATE google_tokens SET spreadsheet_id = ? WHERE user_email = ?")
                .bind(fileId, email).run();
        } else {
            reportUrl = await appendReportToFile(accessToken, fileId, report);
        }

        return new Response(JSON.stringify({
            success: true,
            reportUrl
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
// إنشاء ملف JSON جديد في Drive لأول مرة (يحتوي على أول نتيجة)
// ============================================================
async function createReportFile(accessToken, firstReport) {
    const boundary = 'super_web_boundary_' + Date.now();
    const metadata = {
        name: 'سوبر ويب - سجل فحوصات المواقع.json',
        mimeType: 'application/json'
    };
    const fileContent = JSON.stringify([firstReport], null, 2);

    const multipartBody =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${fileContent}\r\n` +
        `--${boundary}--`;

    const res = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body: multipartBody
        }
    );

    const data = await res.json();
    if (!res.ok) {
        throw new Error('فشل إنشاء ملف التقرير في Drive: ' + (data.error?.message || 'خطأ غير معروف'));
    }

    return { fileId: data.id, webViewLink: data.webViewLink };
}

// ============================================================
// قراءة الملف الحالي، إضافة النتيجة الجديدة، وإعادة رفعه
// ============================================================
async function appendReportToFile(accessToken, fileId, newReport) {
    const getRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    let reports = [];
    if (getRes.ok) {
        try {
            const parsed = await getRes.json();
            if (Array.isArray(parsed)) reports = parsed;
        } catch {
            reports = [];
        }
    }

    reports.push(newReport);

    const updateRes = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=webViewLink`,
        {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8'
            },
            body: JSON.stringify(reports, null, 2)
        }
    );

    const data = await updateRes.json().catch(() => ({}));
    if (!updateRes.ok) {
        throw new Error('فشل تحديث ملف التقرير في Drive: ' + (data.error?.message || 'خطأ غير معروف'));
    }

    return data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}/**
 * Cloudflare Pages Function: /api/save-report
 * يحفظ نتيجة فحص كملف JSON مباشر في Drive بتاع المستخدم (drive.file scope فقط)
 * لو مفيش ملف قبل كده، بينشئ واحد، وبعدين بيضيف كل نتيجة جديدة جوه نفس الملف
 *
 * ملاحظة: بنستخدم نفس عمود spreadsheet_id في جدول google_tokens لتخزين
 * ID الملف الجديد (مفيش داعي نعدل قاعدة البيانات، بس تغيّر الغرض من العمود)
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

        let fileId = tokenRow.spreadsheet_id; // بنعيد استخدام نفس العمود لتخزين ID ملف الـ JSON
        let reportUrl;

        if (!fileId) {
            const created = await createReportFile(accessToken, report);
            fileId = created.fileId;
            reportUrl = created.webViewLink;
            await env.DB.prepare("UPDATE google_tokens SET spreadsheet_id = ? WHERE user_email = ?")
                .bind(fileId, email).run();
        } else {
            reportUrl = await appendReportToFile(accessToken, fileId, report);
        }

        return new Response(JSON.stringify({
            success: true,
            reportUrl
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
// إنشاء ملف JSON جديد في Drive لأول مرة (يحتوي على أول نتيجة)
// ============================================================
async function createReportFile(accessToken, firstReport) {
    const boundary = 'super_web_boundary_' + Date.now();
    const metadata = {
        name: 'سوبر ويب - سجل فحوصات المواقع.json',
        mimeType: 'application/json'
    };
    const fileContent = JSON.stringify([firstReport], null, 2);

    const multipartBody =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${fileContent}\r\n` +
        `--${boundary}--`;

    const res = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body: multipartBody
        }
    );

    const data = await res.json();
    if (!res.ok) {
        throw new Error('فشل إنشاء ملف التقرير في Drive: ' + (data.error?.message || 'خطأ غير معروف'));
    }

    return { fileId: data.id, webViewLink: data.webViewLink };
}

// ============================================================
// قراءة الملف الحالي، إضافة النتيجة الجديدة، وإعادة رفعه
// ============================================================
async function appendReportToFile(accessToken, fileId, newReport) {
    const getRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    let reports = [];
    if (getRes.ok) {
        try {
            const parsed = await getRes.json();
            if (Array.isArray(parsed)) reports = parsed;
        } catch {
            reports = [];
        }
    }

    reports.push(newReport);

    const updateRes = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=webViewLink`,
        {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8'
            },
            body: JSON.stringify(reports, null, 2)
        }
    );

    const data = await updateRes.json().catch(() => ({}));
    if (!updateRes.ok) {
        throw new Error('فشل تحديث ملف التقرير في Drive: ' + (data.error?.message || 'خطأ غير معروف'));
    }

    return data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
